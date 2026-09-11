#!/usr/bin/env python3
"""
Release preparation script - Step 1 of 2.

Bumps version in package.json, builds the app, and packages a Windows
NSIS installer plus the signed Android APK into a date+version stamped
folder under release/.

Does NOT commit, tag, or push. Run sendDeploy.py after validating the EXE.

Usage:
    python prepareDeploy.py <patch|minor|major>
    python prepareDeploy.py <patch|minor|major> --force   # skip dirty-repo check

Rollback (if unhappy with build):
    git checkout package.json
    # Optionally delete the release/YYYYMMDD-vX.Y.Z/ folder
"""

import subprocess
import sys
import json
import shutil
from datetime import datetime
from pathlib import Path

import yaml

from deploy_android import build_apk


def run(cmd, check=True):
    """Run shell command, printing output in real-time."""
    print(f"  $ {cmd}")
    result = subprocess.run(cmd, shell=True, check=check)
    return result


def patch_native_modules():
    """Patch node-pty .gyp files to disable Spectre mitigation requirement.

    VS 2026 (v18) doesn't ship Spectre-mitigated libraries as a component.
    node-pty's binding.gyp hardcodes SpectreMitigation: 'Spectre', which
    fails the build. We patch it to 'false' before electron-builder runs
    @electron/rebuild.
    """
    gyp_files = [
        Path("node_modules/node-pty/binding.gyp"),
        Path("node_modules/node-pty/deps/winpty/src/winpty.gyp"),
    ]
    for gyp in gyp_files:
        if not gyp.exists():
            continue
        content = gyp.read_text(encoding="utf-8")
        if "'SpectreMitigation': 'Spectre'" in content:
            content = content.replace(
                "'SpectreMitigation': 'Spectre'",
                "'SpectreMitigation': 'false'"
            )
            gyp.write_text(content, encoding="utf-8")
            print(f"  Patched {gyp}")


def bump_version(part):
    """Bump version in package.json and return (old_version, new_version)."""
    pkg_path = Path("package.json")
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    current = pkg["version"]

    parts = current.split(".")
    match part:
        case "patch":
            parts[2] = str(int(parts[2]) + 1)
        case "minor":
            parts[1] = str(int(parts[1]) + 1)
            parts[2] = "0"
        case "major":
            parts[0] = str(int(parts[0]) + 1)
            parts[1] = "0"
            parts[2] = "0"
        case _:
            print(f"ERROR: Invalid part: {part}")
            sys.exit(1)

    new_version = ".".join(parts)
    pkg["version"] = new_version
    pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")

    # The lockfile carries the version in two places and npm rewrites both on the
    # next install. Left alone, a tagged release ships a lockfile naming the
    # PREVIOUS version, and the drift only surfaces on whichever machine happens
    # to run npm install next.
    lock_path = Path("package-lock.json")
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        lock["version"] = new_version
        if "" in lock.get("packages", {}):
            lock["packages"][""]["version"] = new_version
        lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")

    return current, new_version


def create_deploy_configs():
    """Create stripped config files in config-deploy/ for packaging.

    Original config files are NEVER modified. The staging directory
    is overlaid on top of config/ by electron-builder during packaging,
    so deploy builds ship clean defaults instead of personal paths.
    """
    deploy_dir = Path("config-deploy")
    if deploy_dir.exists():
        shutil.rmtree(deploy_dir)

    # Strip workingDirectories from each profile YAML
    profiles_src = Path("config/profiles")
    profiles_dst = deploy_dir / "profiles"
    profiles_dst.mkdir(parents=True)

    for yaml_file in sorted(profiles_src.glob("*.yaml")):
        with open(yaml_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        data.pop("workingDirectories", None)
        with open(profiles_dst / yaml_file.name, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        print(f"    {yaml_file.name} -> config-deploy/profiles/{yaml_file.name}")

    # Clean settings.yaml (defaults only - no window bounds or session groups)
    settings = {
        "activeProfile": "default",
        "hapticFeedback": False,
        "notifications": True,
    }
    with open(deploy_dir / "settings.yaml", "w", encoding="utf-8") as f:
        yaml.dump(settings, f, default_flow_style=False, sort_keys=False)
    print("    settings.yaml -> config-deploy/settings.yaml (defaults)")

    # Empty sessions.yaml (no saved sessions)
    with open(deploy_dir / "sessions.yaml", "w", encoding="utf-8") as f:
        yaml.dump([], f)
    print("    sessions.yaml -> config-deploy/sessions.yaml (empty)")

    # Empty prompt-templates.yaml seed stub. Guarantees the global file is
    # shipped in the packaged config source regardless of the dev machine's
    # runtime config/ state. First launch migrates profile sequences over it
    # (migration treats an empty tree as "not yet migrated").
    with open(deploy_dir / "prompt-templates.yaml", "w", encoding="utf-8") as f:
        yaml.dump({"folders": [], "templates": []}, f, default_flow_style=False, sort_keys=False)
    print("    prompt-templates.yaml -> config-deploy/prompt-templates.yaml (empty seed)")


def cleanup_deploy_configs():
    """Remove the config-deploy/ staging directory."""
    deploy_dir = Path("config-deploy")
    if deploy_dir.exists():
        shutil.rmtree(deploy_dir)
        print("  Cleaned up config-deploy/")


def check_git_clean():
    """Abort if working tree is dirty."""
    result = subprocess.run(
        "git status --porcelain",
        shell=True, capture_output=True, text=True
    )
    if result.stdout.strip():
        print("ERROR: Uncommitted changes detected. Commit or stash first.")
        print()
        print("Dirty files:")
        for line in result.stdout.strip().split("\n"):
            print(f"  {line}")
        sys.exit(1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    force = "--force" in flags

    if len(args) != 1 or args[0] not in ("patch", "minor", "major"):
        print("Usage: python prepareDeploy.py <patch|minor|major> [--force]")
        sys.exit(1)

    part = args[0]

    print("=" * 50)
    print(f"Preparing {part} release...")
    print("=" * 50)
    print()

    # 1. Check git is clean
    print("[1/7] Checking git status...")
    if force:
        print("  WARNING: Skipping dirty-repo check (--force)")
    else:
        check_git_clean()
        print("  OK: Working tree is clean")
    print()

    # 2. Bump version
    print("[2/7] Bumping version...")
    old_version, new_version = bump_version(part)
    print(f"  OK: {old_version} -> {new_version}")
    print()

    # 3. Patch native modules for VS 2026 compatibility, then build + package
    print("[3/7] Patching native modules for build...")
    patch_native_modules()
    print("  OK: Native modules patched")
    print()

    # 4. Create deploy-safe config staging directory
    print("[4/7] Creating deploy configs (stripping personal paths)...")
    create_deploy_configs()
    print("  OK: Deploy configs staged in config-deploy/")
    print()

    # Clean release/ before building to avoid leftover artifacts
    release_root = Path("release")
    if release_root.exists():
        shutil.rmtree(release_root)
        print("  Cleaned previous release/")

    print("[5/7] Building and packaging...")
    try:
        result = run("npm run package", check=False)
        if result.returncode != 0:
            print("ERROR: Build failed. Revert with: git checkout package.json")
            sys.exit(1)
    finally:
        cleanup_deploy_configs()
    print()

    # 6. Move installer artifacts to dated folder (skip win-unpacked build dir)
    print("[6/7] Organizing release artifacts...")
    date_stamp = datetime.now().strftime("%Y%m%d")
    release_dir = release_root / f"{date_stamp}-v{new_version}"
    release_dir.mkdir(parents=True, exist_ok=True)

    # Only keep the installer EXE - skip directories, blockmap, auto-update manifests, and builder metadata
    skip_suffixes = {".blockmap", ".yml", ".yaml"}
    for item in release_root.iterdir():
        if item == release_dir or item.name.startswith("."):
            continue
        if item.is_dir():
            continue
        if item.suffix in skip_suffixes:
            item.unlink()
            continue
        item.rename(release_dir / item.name)

    # Find the installer EXE
    exes = list(release_dir.glob("*.exe"))
    if not exes:
        # Also check for NSIS installer pattern
        exes = list(release_dir.glob("*Setup*.exe"))
    if not exes:
        print("WARNING: No installer found in release output. Check electron-builder config.")
    else:
        for exe in exes:
            size_mb = exe.stat().st_size / (1024 * 1024)
            print(f"  FILE: {exe.name} ({size_mb:.1f} MB)")

    # 7. Build the Android APK into the same folder
    #
    # AFTER the bump on purpose: build.gradle.kts derives versionName and
    # versionCode from package.json, so building earlier would stamp the
    # previous version into the APK. Signed with the permanent release key and
    # verified by certificate before it is allowed near the release folder.
    print()
    print("[7/7] Building the Android APK...")
    build_apk(new_version, release_dir)
    print()

    print("=" * 50)
    print(f"Release v{new_version} prepared!")
    print("=" * 50)
    print()
    print(f"  Artifacts: {release_dir}")
    print()
    print("Next steps:")
    print(f"  1. Test the EXE and sideload the APK from {release_dir}")
    print("  2. If happy:  python sendDeploy.py")
    print("  3. If not:    git checkout package.json")


if __name__ == "__main__":
    main()
