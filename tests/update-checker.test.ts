/**
 * Self-update decision logic — version comparison, installer asset picking,
 * latest-release parsing, and the detached update script. All pure; no
 * mocking, no Electron.
 */

import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isRepoDownloadUrl,
  pickInstallerAsset,
  parseLatestRelease,
  buildUpdateScript,
} from '../src/session/update-checker.js';

describe('compareVersions', () => {
  const cases: Array<[string, string, number, string]> = [
    ['3.11.1', '3.11.1', 0, 'equal'],
    ['3.11.2', '3.11.1', 1, 'patch newer'],
    ['3.12.0', '3.11.9', 1, 'minor newer'],
    ['4.0.0', '3.99.99', 1, 'major newer'],
    ['v3.12.0', '3.11.1', 1, 'leading v tolerated'],
    ['3.12', '3.11.9', 1, 'shorter version padded'],
    ['3.12', '3.12.0', 0, 'shorter version equal when padded'],
    ['3.11.1', '3.11.2', -1, 'negative when remote is older'],
  ];

  for (const [a, b, expected, label] of cases) {
    it(`${label}: ${a} vs ${b} -> ${expected}`, () => {
      expect(Math.sign(compareVersions(a, b))).toBe(expected);
    });
  }
});

describe('pickInstallerAsset', () => {
  const assets = [
    { name: 'helm-3.12.0.apk', browser_download_url: 'https://github.com/x/helm-3.12.0.apk', size: 1 },
    { name: 'Helm Setup 3.12.0.exe', browser_download_url: 'https://github.com/x/Helm Setup 3.12.0.exe', size: 2 },
    { name: 'Helm Setup 3.12.0.exe.blockmap', browser_download_url: 'https://github.com/x/bm', size: 3 },
    { name: 'latest.yml', browser_download_url: 'https://github.com/x/latest.yml', size: 4 },
  ];

  it('picks the NSIS installer and nothing else', () => {
    expect(pickInstallerAsset(assets)?.name).toBe('Helm Setup 3.12.0.exe');
  });

  it('returns undefined when the release carries no installer', () => {
    expect(pickInstallerAsset(assets.slice(0, 1))).toBeUndefined();
  });
});

describe('parseLatestRelease', () => {
  const release = (tag: string, assets: Array<{ name: string; browser_download_url: string; size?: number }>) => ({
    tag_name: tag,
    html_url: `https://github.com/PetePeter/helm/releases/tag/${tag}`,
    assets,
  });
  const installer = { name: 'Helm Setup 3.12.0.exe', browser_download_url: 'https://github.com/PetePeter/helm/releases/download/v3.12.0/Helm%20Setup%203.12.0.exe', size: 150 };

  it('returns update info when the release is newer', () => {
    const info = parseLatestRelease(release('v3.12.0', [installer]), '3.11.1');
    expect(info).toEqual({
      version: '3.12.0',
      releaseUrl: 'https://github.com/PetePeter/helm/releases/tag/v3.12.0',
      installerUrl: installer.browser_download_url,
      installerSize: 150,
    });
  });

  it('returns null for the same version', () => {
    expect(parseLatestRelease(release('v3.11.1', [installer]), '3.11.1')).toBeNull();
  });

  it('returns null for an older release', () => {
    expect(parseLatestRelease(release('v3.10.0', [installer]), '3.11.1')).toBeNull();
  });

  it('returns null when the release has no installer asset', () => {
    expect(parseLatestRelease(release('v3.12.0', [{ name: 'helm-3.12.0.apk', browser_download_url: 'u' }]), '3.11.1')).toBeNull();
  });

  it('returns null for malformed payloads — never a phantom update', () => {
    expect(parseLatestRelease(null, '3.11.1')).toBeNull();
    expect(parseLatestRelease({}, '3.11.1')).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v4.0.0' }, '3.11.1')).toBeNull(); // no assets array
    expect(parseLatestRelease({ tag_name: 4, assets: [] }, '3.11.1')).toBeNull();
  });
});

describe('isRepoDownloadUrl', () => {
  it('accepts only our own release download URLs', () => {
    expect(isRepoDownloadUrl('https://github.com/PetePeter/helm/releases/download/v3.12.0/x.exe')).toBe(true);
    expect(isRepoDownloadUrl('https://github.com/evil/helm/releases/download/v3.12.0/x.exe')).toBe(false);
    expect(isRepoDownloadUrl('http://github.com/PetePeter/helm/releases/download/v3.12.0/x.exe')).toBe(false);
    expect(isRepoDownloadUrl('file:///C:/evil.exe')).toBe(false);
  });
});

describe('buildUpdateScript', () => {
  const script = buildUpdateScript('C:\\Helm Data\\helm-update-3.12.0.exe', 'C:\\Program Files\\Helm\\Helm.exe');

  it('waits for the silent installer to finish — NSIS is GUI-subsystem, so a bare call would return instantly', () => {
    expect(script).toContain('start /wait "" "C:\\Helm Data\\helm-update-3.12.0.exe" /S');
  });

  it('relaunches the app from the install directory', () => {
    expect(script).toContain('start "" "C:\\Program Files\\Helm\\Helm.exe"');
  });

  it('waits for the app to exit before installing (quit cleanup can take up to its 5 s cap)', () => {
    const wait = script.match(/timeout \/t (\d+) /);
    expect(wait).not.toBeNull();
    expect(Number(wait![1])).toBeGreaterThanOrEqual(8);
  });

  it('cleans up the installer and itself', () => {
    expect(script).toContain('del "C:\\Helm Data\\helm-update-3.12.0.exe"');
    expect(script).toContain('del "%~f0"');
  });

  it('uses CRLF line endings — cmd.exe parses .cmd files with them', () => {
    expect(script).not.toMatch(/(?<!\r)\n/);
  });
});
