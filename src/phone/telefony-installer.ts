/**
 * telefony-app install / update from its GitHub releases.
 *
 * Contract agreed with telefony-app: each `vX.Y.Z` release carries
 * `telefony-app-win64.zip` (root folder `telefony-app/` with the exe and a
 * `piper/` subfolder that must stay beside it) and a sha256sum-format
 * `telefony-app-win64.zip.sha256`. Versions install side by side under
 * `<root>/<version>/` so a failed update never breaks the working one; older
 * versions are pruned only after the new one is in place.
 */
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { downloadToFile, type DownloadProgress, type FetchFn } from '../utils/download.js';

export const TELEFONY_REPO = 'PetePeter/telefony-app';
/** The release list, not `/releases/latest`: telefony publishes pre-releases, which `latest` hides. */
export const TELEFONY_RELEASES_URL = `https://api.github.com/repos/${TELEFONY_REPO}/releases?per_page=10`;
const ZIP_NAME = 'telefony-app-win64.zip';
const SHA_NAME = `${ZIP_NAME}.sha256`;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface TelefonyRelease {
  version: string;
  zipUrl: string;
  shaUrl: string;
  size?: number;
}

/** Null for anything that is not a well-formed release with both assets. */
export function parseTelefonyRelease(payload: unknown): TelefonyRelease | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { tag_name, assets } = payload as { tag_name?: unknown; assets?: unknown };
  if (typeof tag_name !== 'string' || !Array.isArray(assets)) return null;
  const version = tag_name.replace(/^v/i, '');
  if (!VERSION_RE.test(version)) return null;
  const find = (name: string) => assets.find((a): a is { browser_download_url: string; size?: number } =>
    typeof a === 'object' && a !== null && (a as { name?: unknown }).name === name
    && isTelefonyDownloadUrl((a as { browser_download_url?: unknown }).browser_download_url));
  const zip = find(ZIP_NAME);
  const sha = find(SHA_NAME);
  if (!zip || !sha) return null;
  return { version, zipUrl: zip.browser_download_url, shaUrl: sha.browser_download_url, size: zip.size };
}

/** Newest usable release from the list (GitHub returns newest first); drafts are skipped. */
export function pickTelefonyRelease(list: unknown): TelefonyRelease | null {
  if (!Array.isArray(list)) return null;
  for (const r of list) {
    if ((r as { draft?: unknown })?.draft) continue;
    const parsed = parseTelefonyRelease(r);
    if (parsed) return parsed;
  }
  return null;
}

function isTelefonyDownloadUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(`https://github.com/${TELEFONY_REPO}/releases/download/`);
}

/** The hex digest from a sha256sum line (`<hex>  <file>`), or null. */
export function parseSha256(text: string): string | null {
  const m = /^\s*([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export function exePathFor(root: string, version: string): string {
  return path.join(root, version, 'telefony-app', 'telefony-app.exe');
}

/** Version of an executable this installer placed, read from its path; null for a user-picked exe. */
export function installedVersionOf(root: string, executable: string): string | null {
  const rel = path.relative(root, executable);
  const version = rel.split(path.sep)[0];
  return VERSION_RE.test(version) && path.resolve(exePathFor(root, version)) === path.resolve(executable) ? version : null;
}

export type ExtractFn = (zipPath: string, destDir: string) => Promise<void>;

/**
 * Windows 10+ ships bsdtar, which reads zip — no archive dependency needed.
 * Absolute path: a Git-for-Windows GNU tar earlier on PATH cannot read zip.
 */
export const extractWithTar: ExtractFn = (zipPath, destDir) => new Promise((resolve, reject) => {
  execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', destDir], { windowsHide: true }, err => (err ? reject(err) : resolve()));
});

export interface TelefonyInstallerDeps {
  root: string;
  fetchFn: FetchFn;
  extract?: ExtractFn;
}

export class TelefonyInstaller {
  private installing = false;

  constructor(private readonly deps: TelefonyInstallerDeps) {}

  async latest(): Promise<TelefonyRelease | null> {
    const res = await this.deps.fetchFn(TELEFONY_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'helm-desktop' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return pickTelefonyRelease(await res.json());
  }

  /** Download, verify and unpack `release`; returns the new executable path. */
  async install(release: TelefonyRelease, onProgress?: (p: DownloadProgress) => void): Promise<string> {
    if (this.installing) throw new Error('An install is already running');
    this.installing = true;
    const { root } = this.deps;
    const zipPath = path.join(root, `download-${release.version}.zip`);
    const staging = path.join(root, `staging-${release.version}`);
    const target = path.join(root, release.version);
    try {
      fs.mkdirSync(root, { recursive: true });
      const shaRes = await this.deps.fetchFn(release.shaUrl, { signal: AbortSignal.timeout(30_000) });
      const expected = shaRes.ok ? parseSha256(await shaRes.text()) : null;
      if (!expected) throw new Error('Could not read the release checksum');
      await downloadToFile(this.deps.fetchFn, release.zipUrl, zipPath, onProgress);
      if (await sha256File(zipPath) !== expected) throw new Error('Checksum mismatch: download rejected');
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      await (this.deps.extract ?? extractWithTar)(zipPath, staging);
      if (!fs.existsSync(path.join(staging, 'telefony-app', 'telefony-app.exe'))) throw new Error('Release zip has no telefony-app/telefony-app.exe');
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      return exePathFor(root, release.version);
    } finally {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      this.installing = false;
    }
  }

  /** Best effort: a version whose exe is still running stays until next time. */
  pruneExcept(version: string): void {
    for (const name of safeReaddir(this.deps.root)) {
      if (name === version || !VERSION_RE.test(name)) continue;
      try { fs.rmSync(path.join(this.deps.root, name), { recursive: true, force: true }); } catch { /* in use */ }
    }
  }
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
