import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { MainProcessAdminGuard } from '../src/electron/ipc/admin-guard.js';

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

let root: string;
let loader: ConfigLoader;
let profiles: UserProfileStore;
let nonAdminId: string;

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

function setup(activeProfileId = '1') {
  root = mkdtempSync(join(tmpdir(), 'helm-mcp-config-'));
  const globalConfigDir = join(root, 'global');
  const profileConfigDir = join(root, 'profiles', '1');
  mkdirSync(globalConfigDir, { recursive: true });
  mkdirSync(profileConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  loader = new ConfigLoader({ userProfileId: '1', profileConfigDir, globalConfigDir });
  loader.load();
  loader.setMcpConfig({ enabled: true, authToken: 'shared-token' });
  profiles = new UserProfileStore(globalConfigDir);
  profiles.ensureDefaultProfile();
  nonAdminId = profiles.create('Second profile').id;
  profiles.setActiveProfileId(activeProfileId === 'non-admin' ? nonAdminId : activeProfileId);
  setupConfigHandlers(loader, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new MainProcessAdminGuard(profiles));
}

beforeEach(() => handleCalls.clear());
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('MCP token config IPC profile authorization', () => {
  it('exposes and rotates the shared token for the admin profile', async () => {
    setup();

    expect(getHandler('config:getMcpConfig')()).toMatchObject({ authToken: 'shared-token' });
    const generated = await getHandler('config:generateMcpToken')();

    expect(generated.success).toBe(true);
    expect(generated.token).not.toBe('shared-token');
    expect(loader.getMcpConfig().authToken).toBe(generated.token);
  });

  it('redacts the shared token and refuses rotation for a non-admin profile', async () => {
    setup('non-admin');
    const setMcpConfig = vi.spyOn(loader, 'setMcpConfig');

    expect(getHandler('config:getMcpConfig')()).toMatchObject({ authToken: '' });
    expect(await getHandler('config:generateMcpToken')()).toMatchObject({ success: false });
    expect(setMcpConfig).not.toHaveBeenCalled();
    expect(loader.getMcpConfig().authToken).toBe('shared-token');
  });
});

describe('machine-wide hook injection config IPC authorization', () => {
  it('rejects direct writes and resets from a non-admin profile', () => {
    setup('non-admin');
    const setInjections = vi.spyOn(loader, 'setHookInjectionOverrides');
    const resetInjections = vi.spyOn(loader, 'resetHookInjectionOverrides');

    const write = getHandler('config:setHookInjections')(null, { helmMsgRules: 'attacker text' });
    const reset = getHandler('config:resetHookInjections')();

    expect(write).toMatchObject({ success: false });
    expect(write.error).toContain('Admin only');
    expect(reset).toMatchObject({ success: false });
    expect(reset.error).toContain('Admin only');
    expect(setInjections).not.toHaveBeenCalled();
    expect(resetInjections).not.toHaveBeenCalled();
  });
});
