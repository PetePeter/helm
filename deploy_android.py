#!/usr/bin/env python3
"""
The Android half of the release pipeline, shared by prepareDeploy and sendDeploy.

THE RULE THIS MODULE EXISTS TO ENFORCE: never conclude an APK is correctly
signed by reading the build log. A debug-signed APK builds cleanly, installs,
and runs — it is indistinguishable from a correct one until a user tries to
upgrade it, at which point the install is refused and their pairing and app
data are gone. `hasReleaseSigning` in build.gradle.kts was true the entire time
the signing config was silently dropping its own key, so the flag proves
nothing. Only the certificate in the finished APK does.

The release key is PERMANENT and lives in the PotatoMotato OneDrive folder,
referenced from gitignored android/local.properties. Never regenerate it.
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ANDROID_DIR = Path("android")

# The permanent release certificate. This is PUBLIC information — it ships in
# every APK — and it is recorded here so the pipeline can refuse anything else.
# Changing this constant is not a config tweak: it means a different signing key
# is in play, which no installed copy of the app can be upgraded from.
RELEASE_CERT_SHA256 = "169ed730f3a34e35940e4d90f97411c3738cd655f6d0a46d462516068890c3b8"

# What the Android debug key identifies itself as. Matched explicitly so the
# refusal can say WHY rather than only "unexpected certificate".
DEBUG_CERT_DN_MARKER = "CN=Android Debug"

SIGNER_SHA256 = re.compile(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})")


def apk_asset_name(version: str) -> str:
    """Mirrors apkAssetName() in src/mobile/apk-release.ts — keep them in step."""
    return f"helm-{version}.apk"


def _sdk_dir() -> Path | None:
    """The SDK root, from android/local.properties (forward slashes) or the env."""
    import os

    local_props = ANDROID_DIR / "local.properties"
    if local_props.exists():
        for line in local_props.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "sdk.dir" and value.strip():
                return Path(value.strip())
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(env):
            return Path(os.environ[env])
    return None


def find_apksigner() -> Path | None:
    """The newest build-tools apksigner, or None if the SDK is not installed."""
    sdk = _sdk_dir()
    if not sdk:
        return None
    build_tools = sdk / "build-tools"
    if not build_tools.is_dir():
        return None
    name = "apksigner.bat" if sys.platform == "win32" else "apksigner"
    candidates = sorted(
        (d / name for d in build_tools.iterdir() if d.is_dir()),
        key=lambda p: p.parent.name,
        reverse=True,
    )
    return next((c for c in candidates if c.exists()), None)


def verify_release_signature(apk: Path) -> None:
    """
    Assert the APK carries the permanent release certificate. Exits on anything
    else — an unverifiable APK is treated exactly like a wrongly signed one,
    because shipping on "we could not check" is how the debug key escapes.
    """
    apksigner = find_apksigner()
    if not apksigner:
        print("ERROR: apksigner not found. Install the Android SDK build-tools,")
        print("   or set sdk.dir in android/local.properties (forward slashes).")
        print("   Refusing to publish an APK whose signer cannot be verified.")
        sys.exit(1)

    print(f"  $ apksigner verify --print-certs {apk.name}")
    result = subprocess.run(
        [str(apksigner), "verify", "--print-certs", str(apk)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"ERROR: apksigner could not verify {apk.name}:")
        print(result.stderr.strip() or result.stdout.strip())
        sys.exit(1)

    if DEBUG_CERT_DN_MARKER in result.stdout:
        print(f"ERROR: {apk.name} is signed with the ANDROID DEBUG KEY.")
        print("   A debug-signed APK installs and runs, so this will not surface")
        print("   until a user cannot upgrade it and loses their pairing.")
        print("   Check the signing properties in android/local.properties.")
        sys.exit(1)

    match = SIGNER_SHA256.search(result.stdout)
    if not match:
        print(f"ERROR: no signer certificate found in {apk.name}. Refusing to publish.")
        sys.exit(1)

    actual = match.group(1).lower()
    if actual != RELEASE_CERT_SHA256:
        print(f"ERROR: {apk.name} is signed with an UNEXPECTED certificate.")
        print(f"   expected SHA-256 {RELEASE_CERT_SHA256}")
        print(f"   actual   SHA-256 {actual}")
        print("   An APK signed with a different key refuses to install over the")
        print("   existing app. NEVER regenerate the release keystore to make this")
        print("   pass - recover the permanent key instead.")
        sys.exit(1)

    print(f"  OK: {apk.name} carries the permanent release certificate")


def build_apk(version: str, dest_dir: Path) -> Path:
    """
    Build the release APK and place it, version-stamped, beside the installer.

    Runs AFTER the version bump on purpose: build.gradle.kts derives both
    versionName and versionCode from package.json, so building first would stamp
    the previous version into the APK.
    """
    gradlew = ANDROID_DIR / ("gradlew.bat" if sys.platform == "win32" else "gradlew")
    if not gradlew.exists():
        print(f"ERROR: {gradlew} not found. Cannot build the Android APK.")
        sys.exit(1)

    print(f"  $ {gradlew.name} assembleRelease")
    result = subprocess.run(
        [str(gradlew.resolve()), "assembleRelease", "--console=plain"],
        cwd=ANDROID_DIR,
    )
    if result.returncode != 0:
        print("ERROR: Android build failed. Revert with: git checkout package.json")
        sys.exit(1)

    built = ANDROID_DIR / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not built.exists():
        print(f"ERROR: assembleRelease reported success but {built} is missing.")
        sys.exit(1)

    verify_release_signature(built)

    dest = dest_dir / apk_asset_name(version)
    shutil.copy2(built, dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"  FILE: {dest.name} ({size_mb:.1f} MB)")
    return dest


def find_release_apk(release_path: Path, version: str) -> Path:
    """The prepared APK for this exact version, or a loud exit."""
    expected = release_path / apk_asset_name(version)
    if not expected.exists():
        print(f"ERROR: {expected.name} is missing from {release_path}.")
        print("   Every tagged release must carry the Android APK. The Mobile tab")
        print("   points a QR code at this exact asset, and without it that QR is a")
        print("   404 on a URL that looks correct.")
        print("   Re-run prepareDeploy.py.")
        sys.exit(1)
    return expected
