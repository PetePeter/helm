/**
 * Self-update — pure decision logic for the launch-time GitHub check.
 *
 * The main process owns the network and the install; this module owns every
 * decision that is worth unit-testing: is the published release newer, which
 * release asset is the Windows installer, and what exactly does the detached
 * update script do. The repo is the same one the phone APK ships from
 * (src/mobile/apk-release.ts) — one public repo carries every artifact.
 */

import { APK_REPO } from '../mobile/apk-release.js';

/** `https://api.github.com/repos/PetePeter/helm/releases/latest` */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${APK_REPO}/releases/latest`;

/** Only installer URLs from our own release downloads are ever fetched. */
export function isRepoDownloadUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith(`https://github.com/${APK_REPO}/releases/download/`);
}

/** What electron-builder names the NSIS installer: `Helm Setup 3.12.0.exe`. */
const INSTALLER_ASSET_RE = /^Helm Setup [\d.]+\.exe$/i;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface UpdateInfo {
  version: string;
  /** The release page, opened in the browser when the user wants details. */
  releaseUrl: string;
  installerUrl: string;
  installerSize?: number;
}

/**
 * Numeric comparison of dotted versions (`v` prefix tolerated, prerelease
 * suffixes ignored — prepareDeploy.py only ever writes plain `X.Y.Z` tags).
 * Returns >0 when `a` is newer, 0 when equal, <0 when `b` is newer.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.trim().replace(/^v/i, '').split('-')[0].split('.').map(Number);
  const [pa, pb] = [parse(a), parse(b)];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Pick the x64 NSIS installer out of a release's assets. Everything else on
 * the release (APK, blockmap, checksums, the Mac build) must be ignored.
 */
export function pickInstallerAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find(asset => INSTALLER_ASSET_RE.test(asset.name));
}

/** A minimal shape of the GitHub `releases/latest` response this code reads. */
interface GithubReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

/**
 * Decide whether a fetched `releases/latest` payload represents an update for
 * `currentVersion`. Returns null when the release is not newer, carries no
 * installer asset, or the payload is malformed — a failed check must never
 * look like "update available".
 */
export function parseLatestRelease(payload: unknown, currentVersion: string): UpdateInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const release = payload as GithubReleasePayload;
  if (typeof release.tag_name !== 'string') return null;

  const version = release.tag_name.replace(/^v/i, '');
  if (compareVersions(version, currentVersion) <= 0) return null;

  if (!Array.isArray(release.assets)) return null;
  const installer = pickInstallerAsset(release.assets as ReleaseAsset[]);
  if (!installer) return null;

  return {
    version,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : '',
    installerUrl: installer.browser_download_url,
    installerSize: typeof installer.size === 'number' ? installer.size : undefined,
  };
}

/**
 * The .cmd the update flow leaves behind, detached. Sequence:
 * wait for the app to fully exit (before-quit cleanup can take up to its
 * 5 s cap, plus quit itself), wait for the silent NSIS install to FINISH,
 * relaunch the same exe path, then delete the installer and itself.
 *
 * `start /wait` is load-bearing: NSIS installers are GUI-subsystem
 * executables, so a bare `"installer" /S` returns control to cmd.exe
 * immediately and the relaunch would race a half-written install.
 * `/S` installs over the previous directory the installer remembers in the
 * registry. If the app is somehow still alive when the installer starts,
 * the silent electron-builder NSIS installer kills it — the initial wait is
 * the polite path, not the only one.
 */
export function buildUpdateScript(installerPath: string, appExePath: string): string {
  return [
    '@echo off',
    'rem Written by Helm self-update. Do not edit while an update is in flight.',
    `timeout /t 8 /nobreak >nul`,
    `start /wait "" "${installerPath}" /S`,
    `timeout /t 2 /nobreak >nul`,
    `start "" "${appExePath}"`,
    `del "${installerPath}"`,
    'del "%~f0"',
  ].join('\r\n');
}
