/**
 * The `mobile:apkRelease` channel.
 *
 * Driven by a FAKE asset checker rather than a mock, because the behaviour
 * worth pinning is how the handler classifies the checker's three outcomes —
 * found, not found, and could-not-ask — not that it called anything.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { MobileDeviceStore } = await import('../src/mobile/mobile-device-store.js');
const { setupMobileHandlers } = await import('../src/electron/ipc/mobile-handlers.js');

/** Answers a fixed verdict, or refuses to answer at all. */
function fakeChecker(verdict: boolean | 'offline'): (url: string) => Promise<boolean> {
  return async () => {
    if (verdict === 'offline') throw new Error('getaddrinfo ENOTFOUND github.com');
    return verdict;
  };
}

function setup(options: {
  version?: string;
  checkApkAsset?: (url: string) => Promise<boolean>;
}) {
  const dispose = setupMobileHandlers({
    deviceStore: new MobileDeviceStore(),
    getPairing: () => null,
    getAppVersion: () => options.version ?? '2.7.3',
    ...(options.checkApkAsset ? { checkApkAsset: options.checkApkAsset } : {}),
  });
  const handler = handleCalls.get('mobile:apkRelease');
  if (!handler) throw new Error('mobile:apkRelease was not registered');
  return { dispose, call: () => handler({}) as Promise<Record<string, unknown>> };
}

describe('mobile:apkRelease', () => {
  beforeEach(() => { handleCalls.clear(); });

  it('reports the asset as available when the checker finds it', async () => {
    const h = setup({ checkApkAsset: fakeChecker(true) });
    const result = await h.call();
    expect(result.ok).toBe(true);
    expect(result.availability).toBe('available');
    expect(result.url).toBe(
      'https://github.com/PetePeter/helm/releases/download/v2.7.3/helm-2.7.3.apk',
    );
    expect(result.note).toBe('');
    h.dispose();
  });

  it('reports `missing` — not a dead QR — when no asset exists for this version', async () => {
    const h = setup({ checkApkAsset: fakeChecker(false) });
    const result = await h.call();
    expect(result.availability).toBe('missing');
    expect(result.note).toContain('2.7.3');
    h.dispose();
  });

  it('degrades a checker failure to `unknown`, never to `missing`', async () => {
    // Being offline is not evidence that the release lacks an APK. Reporting it
    // as missing would tell the user their release is broken whenever the
    // desktop has no network.
    const h = setup({ checkApkAsset: fakeChecker('offline') });
    const result = await h.call();
    expect(result.availability).toBe('unknown');
    h.dispose();
  });

  it('is `unknown` when no checker is wired at all', async () => {
    const h = setup({});
    const result = await h.call();
    expect(result.availability).toBe('unknown');
    expect(result.url).toContain('helm-2.7.3.apk');
    h.dispose();
  });

  it('answers with a reason rather than rejecting when the version is unusable', async () => {
    // An IPC rejection surfaces in the renderer as an unhandled failure with no
    // copy attached to it, which is how a tab ends up blank with no explanation.
    const h = setup({ version: 'dev', checkApkAsset: fakeChecker(true) });
    const result = await h.call();
    expect(result.ok).toBe(false);
    expect(String(result.reason)).toMatch(/version/i);
    h.dispose();
  });
});
