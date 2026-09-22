/**
 * hooks:* IPC handlers — the pane's provider-keyed surface.
 *
 * The rows come from the canonical HOOK_PROVIDERS list, NOT from cli-types
 * config: exactly three providers, regardless of what CLI types the user has.
 * One interpreter probe per call, shared across every row's status read and
 * snippet build (not one per row). Install/uninstall are keyed by provider.
 * Mirrors the config-fleet-handlers ipcMain harness: real handler, fake
 * loader, real hookDeps against a throwaway HOME.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

/** A loader whose CLI types are irrelevant — rows must NOT come from here. */
function fakeConfigLoader() {
  return {
    getCliTypes: () => ['custom-uuid-a', 'custom-uuid-b'],
    getCliTypeEntry: (key: string) => ({ name: key, displayName: key }),
  } as any;
}

describe('hooks:getStatus', () => {
  let home: string;
  let probeCalls: number;

  beforeEach(() => {
    handleCalls.clear();
    home = mkdtempSync(join(tmpdir(), 'helm-hooks-status-'));
    probeCalls = 0;
    const hookDeps = {
      homeDir: () => home,
      shimPath: join(home, 'hooks', 'helm-hook-shim.py'),
      runCommand: async () => {
        probeCalls++;
        return { code: 0 };
      },
    };
    setupConfigHandlers(fakeConfigLoader(), undefined, undefined, undefined, undefined, hookDeps as any);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lists exactly the three canonical providers regardless of configured CLI types', async () => {
    const res = await getHandler('hooks:getStatus')();

    expect(res.success).toBe(true);
    expect(res.items.map((item: any) => item.provider)).toEqual(['claude', 'codex', 'copilot']);
    expect(probeCalls).toBe(1);
    for (const item of res.items) {
      expect(item.status).toBe('not-installed');
      expect(item.label).toBeTruthy();
      expect(item.configPath).toMatch(/^~[\\/]/);
      expect(item.snippet).toContain('helm-hook-shim.py');
    }
    // The copy-ready code is shaped per provider, same as install writes it.
    expect(res.items[0].snippet).toContain('"matcher": "*"');
  });
});

describe('hooks:install / hooks:uninstall (by provider)', () => {
  let home: string;

  beforeEach(() => {
    handleCalls.clear();
    home = mkdtempSync(join(tmpdir(), 'helm-hooks-inst-'));
    const hookDeps = {
      homeDir: () => home,
      shimPath: join(home, 'hooks', 'helm-hook-shim.py'),
      runCommand: async (command: string) => (command === 'python' ? { code: 0 } : { code: 1 }),
    };
    setupConfigHandlers(fakeConfigLoader(), undefined, undefined, undefined, undefined, hookDeps as any);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('installs the Claude block into the real config file when asked by provider', async () => {
    const res = await getHandler('hooks:install')({}, 'claude');

    expect(res.success).toBe(true);
    expect(res.status).toBe('installed');
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(Object.keys(settings.hooks)).toContain('StopFailure');
  });

  it('uninstalls by provider and rejects an unknown provider', async () => {
    await getHandler('hooks:install')({}, 'codex');
    const removed = await getHandler('hooks:uninstall')({}, 'codex');
    expect(removed.success).toBe(true);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true); // user file kept, emptied

    const unknown = await getHandler('hooks:install')({}, 'ghost');
    expect(unknown.success).toBe(false);
  });
});
