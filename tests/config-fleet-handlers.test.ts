/**
 * config:setFleetConfig / getFleetConfig IPC handler tests (P-0658).
 * Mirrors the MCP hot-apply pattern: persist via a fake ConfigLoader, then invoke
 * an injected applyFleetConfig closure with the freshly-read config. A
 * throwing apply still returns {success:true} because the config WAS persisted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  dialog: {},
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setupConfigHandlers } = await import('../src/electron/ipc/config-handlers.js');
const testAdminGuard = { isAdmin: () => true, requireAdmin: () => {} };

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

/** Minimal fake ConfigLoader that records fleet config get/set. */
function fakeConfigLoader() {
  let fed = { enabled: false, host: '0.0.0.0', port: 47474 };
  return {
    load: vi.fn(),
    getCliTypes: () => [],
    getFleetConfig: vi.fn(() => ({ ...fed })),
    setFleetConfig: vi.fn((updates: Partial<typeof fed>) => { fed = { ...fed, ...updates }; }),
  } as any;
}

describe('config:setFleetConfig / getFleetConfig', () => {
  let loader: ReturnType<typeof fakeConfigLoader>;
  let applied: Array<{ enabled: boolean; host: string; port: number }>;
  let applyFleetConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handleCalls.clear();
    loader = fakeConfigLoader();
    applied = [];
    applyFleetConfig = vi.fn(async (cfg: any) => { applied.push(cfg); });
    setupConfigHandlers(loader, undefined, undefined, applyFleetConfig as never,
      undefined, undefined, undefined, undefined, testAdminGuard);
  });

  it('persists the update then hot-applies the freshly-read config and returns success', async () => {
    const res = await getHandler('config:setFleetConfig')({}, { enabled: true, port: 50000 });

    expect(loader.setFleetConfig).toHaveBeenCalledWith({ enabled: true, port: 50000 });
    expect(applyFleetConfig).toHaveBeenCalledTimes(1);
    // The applied config is the loader's POST-merge config, not the raw updates.
    expect(applied[0]).toEqual({ enabled: true, host: '0.0.0.0', port: 50000 });
    expect(res).toEqual({ success: true });
  });

  it('still returns success when hot-apply throws (config was persisted)', async () => {
    applyFleetConfig.mockRejectedValueOnce(new Error('bind failed'));
    const res = await getHandler('config:setFleetConfig')({}, { enabled: true });

    expect(loader.setFleetConfig).toHaveBeenCalled();
    expect(res).toEqual({ success: true });
  });

  it('config:getFleetConfig round-trips the loader value', async () => {
    await getHandler('config:setFleetConfig')({}, { enabled: true, host: '127.0.0.1', port: 40000 });
    const got = await getHandler('config:getFleetConfig')();
    expect(got).toEqual({ enabled: true, host: '127.0.0.1', port: 40000 });
  });

  it('works without an applyFleetConfig closure (optional dep)', async () => {
    handleCalls.clear();
    setupConfigHandlers(loader, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, testAdminGuard);
    const res = await getHandler('config:setFleetConfig')({}, { enabled: true });
    expect(loader.setFleetConfig).toHaveBeenCalled();
    expect(res).toEqual({ success: true });
  });
});
