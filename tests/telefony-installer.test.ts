import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TELEFONY_RELEASES_URL, TelefonyInstaller, pickTelefonyRelease, exePathFor, installedVersionOf, parseSha256, parseTelefonyRelease,
  type ExtractFn,
} from '../src/phone/telefony-installer.js';

const DL = 'https://github.com/PetePeter/telefony-app/releases/download/v0.2.0';
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.2.0',
  assets: [
    { name: 'telefony-app-win64.zip', browser_download_url: `${DL}/telefony-app-win64.zip`, size: 3 },
    { name: 'telefony-app-win64.zip.sha256', browser_download_url: `${DL}/telefony-app-win64.zip.sha256` },
  ],
  ...over,
});

describe('parseTelefonyRelease', () => {
  it('picks both assets and strips the v', () => {
    expect(parseTelefonyRelease(release())).toEqual({
      version: '0.2.0', zipUrl: `${DL}/telefony-app-win64.zip`, shaUrl: `${DL}/telefony-app-win64.zip.sha256`, size: 3,
    });
  });
  it('rejects a release missing the checksum', () => {
    expect(parseTelefonyRelease(release({ assets: [release().assets[0]] }))).toBeNull();
  });
  it('rejects assets hosted outside the telefony repo', () => {
    const assets = release().assets.map(a => ({ ...a, browser_download_url: a.browser_download_url.replace('PetePeter/telefony-app', 'evil/x') }));
    expect(parseTelefonyRelease(release({ assets }))).toBeNull();
  });
  it('rejects a non-semver tag (it becomes a directory name)', () => {
    expect(parseTelefonyRelease(release({ tag_name: 'v../../x' }))).toBeNull();
  });
});

describe('pickTelefonyRelease', () => {
  it('takes the newest usable release, including pre-releases, skipping drafts and broken ones', () => {
    const list = [release({ tag_name: 'v0.4.0', draft: true }), release({ tag_name: 'v0.3.0', assets: [] }), release({ prerelease: true })];
    expect(pickTelefonyRelease(list)?.version).toBe('0.2.0');
  });
});

describe('parseSha256', () => {
  it('reads sha256sum format', () => {
    expect(parseSha256(`${'AB'.repeat(32)}  telefony-app-win64.zip\n`)).toBe('ab'.repeat(32));
  });
  it('rejects garbage', () => { expect(parseSha256('<html>not found')).toBeNull(); });
});

describe('installedVersionOf', () => {
  const root = path.join(os.tmpdir(), 'r');
  it('recognises an exe this installer placed', () => { expect(installedVersionOf(root, exePathFor(root, '0.2.0'))).toBe('0.2.0'); });
  it('returns null for a user-picked exe', () => { expect(installedVersionOf(root, 'C:\\dev\\.venv\\Scripts\\telefony-app.exe')).toBeNull(); });
});

describe('TelefonyInstaller.install', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function setup(opts: { sha?: string; zipLayoutOk?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telefony-inst-'));
    dirs.push(root);
    const zipBytes = Buffer.from('zip');
    const sha = opts.sha ?? createHash('sha256').update(zipBytes).digest('hex');
    const fetchFn = async (url: string) => {
      if (url === TELEFONY_RELEASES_URL) return new Response(JSON.stringify([release({ prerelease: true })]));
      if (url.endsWith('.sha256')) return new Response(`${sha}  telefony-app-win64.zip`);
      return new Response(zipBytes, { headers: { 'content-length': String(zipBytes.length) } });
    };
    const extract: ExtractFn = async (_zip, dest) => {
      const dir = path.join(dest, 'telefony-app');
      fs.mkdirSync(path.join(dir, 'piper'), { recursive: true });
      if (opts.zipLayoutOk !== false) fs.writeFileSync(path.join(dir, 'telefony-app.exe'), 'exe');
      fs.writeFileSync(path.join(dir, 'piper', 'piper.exe'), 'piper');
    };
    return { root, installer: new TelefonyInstaller({ root, fetchFn, extract }) };
  }

  it('installs a verified release side by side and keeps piper beside the exe', async () => {
    const { root, installer } = setup();
    const rel = (await installer.latest())!;
    const exe = await installer.install(rel);
    expect(exe).toBe(exePathFor(root, '0.2.0'));
    expect(fs.existsSync(path.join(path.dirname(exe), 'piper', 'piper.exe'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['0.2.0']);
  });

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const { root, installer } = setup({ sha: '0'.repeat(64) });
    await expect(installer.install((await installer.latest())!)).rejects.toThrow(/Checksum mismatch/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects a zip without the agreed layout and keeps the old version', async () => {
    const { root, installer } = setup({ zipLayoutOk: false });
    fs.mkdirSync(path.join(root, '0.1.0'));
    await expect(installer.install((await installer.latest())!)).rejects.toThrow(/no telefony-app/);
    expect(fs.readdirSync(root)).toEqual(['0.1.0']);
  });

  it('prunes older versions only on request', async () => {
    const { root, installer } = setup();
    fs.mkdirSync(path.join(root, '0.1.0'));
    await installer.install((await installer.latest())!);
    expect(fs.readdirSync(root).sort()).toEqual(['0.1.0', '0.2.0']);
    installer.pruneExcept('0.2.0');
    expect(fs.readdirSync(root)).toEqual(['0.2.0']);
  });
});
