#!/usr/bin/env python3
"""
Release publishing script - Step 2 of 2.

Finds the latest prepared release in release/, commits the version bump,
tags, pushes to GitHub, and publishes the release with the installer EXE
and the signed Android APK via the GitHub CLI (gh).

Prerequisites:
    - Run prepareDeploy.py first
    - Validate the EXE manually
    - Authenticated via `gh auth login` or set DEPLOY_GH_TOKEN env var

Usage:
    python sendDeploy.py
"""

import subprocess
import sys
import json
import os
import re
import shutil
from pathlib import Path

from deploy_android import find_release_apk, verify_release_signature


def run(cmd, check=True, capture=False):
    """Run shell command."""
    print(f"  $ {cmd}")
    if capture:
        result = subprocess.run(
            cmd, shell=True, check=check, capture_output=True, text=True
        )
    else:
        result = subprocess.run(cmd, shell=True, check=check)
    return result


def previous_tag(current_tag):
    """The newest version tag that is not this release, or None for a first release."""
    result = run("git tag --list \"v*\" --sort=-v:refname", check=False, capture=True)
    if result.returncode != 0:
        return None
    tags = [t.strip() for t in result.stdout.splitlines() if t.strip()]
    return next((t for t in tags if t != current_tag), None)


# "feat(scope): subject" -> ("feat", "scope", "subject")
#
# Subjects sometimes carry a decoration before the type ("@ fix(sidebar): ...").
# Anchoring hard on ^\w+ made those fail to match, and an unmatched subject is
# dropped silently — a real fix vanished from the v2.4.5 notes that way. Skip a
# short run of leading non-word characters so the decoration costs nothing.
CONVENTIONAL = re.compile(r"^[^\w\n]{0,4}(?P<type>\w+)(?:\((?P<scope>[^)]*)\))?!?:\s*(?P<subject>.+)$")

# Conventional-commit type -> release-note heading. Types absent here are
# housekeeping (chore, docs, test, refactor...) and are left out of the notes.
NOTE_SECTIONS = [("feat", "Features"), ("fix", "Fixes"), ("perf", "Performance")]


def build_release_notes(tag):
    """
    Compose notes from the commits since the previous tag.

    Hand-written notes always win (RELEASE_NOTES.md in the release folder);
    this is what fills the gap when there are none, so a release page never
    ships as a bare "Release vX.Y.Z" again. Returns None when there is nothing
    to say, leaving the caller to fall back.
    """
    prev = previous_tag(tag)
    if not prev:
        return None

    result = run(f'git log --pretty=format:%s {prev}..HEAD', check=False, capture=True)
    if result.returncode != 0:
        return None

    grouped = {}
    for subject in (line.strip() for line in result.stdout.splitlines()):
        # The version bump is an artifact of releasing, not a change in it.
        if not subject or subject.startswith("bump: v"):
            continue
        match = CONVENTIONAL.match(subject)
        if not match:
            continue
        scope = match.group("scope")
        text = match.group("subject")
        grouped.setdefault(match.group("type"), []).append(
            f"**{scope}:** {text}" if scope else text
        )

    lines = []
    for commit_type, heading in NOTE_SECTIONS:
        entries = grouped.get(commit_type)
        if not entries:
            continue
        lines.append(f"### {heading}")
        lines.extend(f"- {entry}" for entry in entries)
        lines.append("")

    if not lines:
        return None
    lines.append(f"**Full changelog:** {prev}...{tag}")
    return "\n".join(lines)


def find_latest_release():
    """Find the latest dated release folder."""
    release_root = Path("release")
    if not release_root.exists():
        return None

    # Match folders like 20260403-v0.1.1
    pattern = re.compile(r"^(\d{8})-v(\d+\.\d+\.\d+)$")
    candidates = []
    for item in release_root.iterdir():
        if item.is_dir():
            match = pattern.match(item.name)
            if match:
                candidates.append((item.name, match.group(2), item))

    if not candidates:
        return None

    # Sort by folder name (date+version) descending - latest first
    candidates.sort(key=lambda x: x[0], reverse=True)
    folder_name, version, path = candidates[0]
    return {"version": version, "path": path, "folder_name": folder_name}


def main():
    print("=" * 50)
    print("Publishing release to GitHub...")
    print("=" * 50)
    print()

    # 1. Find latest release
    print("[1/5] Finding latest prepared release...")
    release = find_latest_release()
    if not release:
        print("ERROR: No prepared release found in release/")
        print("   Run prepareDeploy.py first.")
        sys.exit(1)

    version = release["version"]
    release_path = release["path"]
    print(f"  OK: Found: {release['folder_name']} (v{version})")
    print()

    # 2. Verify artifacts — exclude uninstaller stubs (build artifacts, not for distribution)
    print("[2/5] Verifying artifacts...")
    exes = [f for f in release_path.glob("*.exe") if "__uninstaller" not in f.name]
    if not exes:
        print("ERROR: No installer .exe found in release folder. Cannot publish.")
        print("   Run prepareDeploy.py first.")
        sys.exit(1)
    for exe in exes:
        size_mb = exe.stat().st_size / (1024 * 1024)
        print(f"  FILE: {exe.name} ({size_mb:.1f} MB)")
        if size_mb < 10:
            print(f"  WARNING: {exe.name} is suspiciously small ({size_mb:.1f} MB) — packaging may have failed.")

    # Verify package.json version matches
    pkg = json.loads(Path("package.json").read_text(encoding="utf-8"))
    if pkg["version"] != version:
        print(f"ERROR: Version mismatch: package.json has {pkg['version']}, release folder has {version}")
        print("   Did you run prepareDeploy.py for this version?")
        sys.exit(1)
    print(f"  OK: package.json version matches: {version}")

    # Every tagged release must carry the APK: Settings -> Mobile points a QR at
    # this exact asset, so a release without one leaves a code that scans into a
    # 404 on a URL that looks correct. The signature is re-checked here because
    # this is the last gate before the file becomes public, and a debug-signed
    # APK is indistinguishable from a correct one until a user cannot upgrade it.
    apk = find_release_apk(release_path, version)
    verify_release_signature(apk)
    print(f"  FILE: {apk.name} ({apk.stat().st_size / (1024 * 1024):.1f} MB)")
    print()

    # 3. Check gh CLI is available and authenticated
    print("[3/5] Checking GitHub CLI...")
    if not shutil.which("gh"):
        print("ERROR: gh CLI not found. Install from https://cli.github.com/")
        sys.exit(1)

    deploy_token = os.environ.get("DEPLOY_GH_TOKEN")
    if deploy_token:
        os.environ["GH_TOKEN"] = deploy_token
        print("  OK: DEPLOY_GH_TOKEN set (forwarded to GH_TOKEN for gh CLI)")
    else:
        # Fall back to gh's own auth (gh auth login)
        auth_result = run("gh auth status", check=False, capture=True)
        if auth_result.returncode != 0:
            print("WARNING: Not authenticated. Either:")
            print("   - Set DEPLOY_GH_TOKEN=ghp_xxxxxxxxxxxx")
            print("   - Or run: gh auth login")
            response = input("   Continue anyway? (y/N): ").strip().lower()
            if response != "y":
                sys.exit(1)
        else:
            print("  OK: gh CLI authenticated")
    print()

    # 4. Git commit, tag, push
    print("[4/5] Committing and pushing...")
    run(f'git commit -am "bump: v{version}"', check=False)
    run(f'git tag -f -a v{version} -m "v{version}"')
    run("git push origin HEAD --tags")
    print()

    # 5. Create GitHub Release and upload installer EXE only
    print("[5/5] Publishing to GitHub Releases...")
    tag = f"v{version}"
    asset_args = " ".join(f'"{asset}"' for asset in [*exes, apk])
    notes_file = release_path / "RELEASE_NOTES.md"
    if not notes_file.exists():
        generated = build_release_notes(tag)
        if generated:
            notes_file.write_text(generated, encoding="utf-8")
            print("  NOTES: Generated from the commit range since the previous tag")

    if notes_file.exists():
        print(f"  NOTES: Using release notes from {notes_file.name}")
        run(f'gh release create {tag} --title "{tag}" --notes-file "{notes_file}" {asset_args}')
    else:
        print("  NOTES: No conventional commits to summarise — using a bare title")
        run(f'gh release create {tag} --title "{tag}" --notes "Release {tag}" {asset_args}')

    print()
    print("=" * 50)
    print(f"v{version} published!")
    print("=" * 50)
    print()
    print(f"  GitHub Release: https://github.com/PetePeter/helm/releases/tag/v{version}")


if __name__ == "__main__":
    main()
