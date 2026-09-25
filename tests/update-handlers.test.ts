/**
 * update:check / update:install — real handler functions against fakes for
 * the side-effecting edges (network, spawn, quit) and a throwaway temp dir.
 * The electron import is mocked only at the ipcMain/app surface, matching the
 * other handler suites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const handlers = new Map<string, Function>();
const quit = vi.fn();
const spawnCalls: Array<{ command: string; args: string[] }> = [];
const progress: unknown[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)),
  },
  app: {
    isPackaged: true,
    getVersion: () => '3.11.1',
    getPath: () => tmpdir(),
    quit: vi.fn(),
  },
  net: { fetch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupUpdateHandlers } from '../src/electron/ipc/update-handlers.js';
import { buildUpdateScript } from '../src/session/update-checker.js';

const INSTALLER_URL = 'https://github.com/PetePeter/helm/releases/download/v3.12.0/Helm%20Setup%203.12.0.exe';
const INSTALLER_BYTES = Buffer.from('fake-nsis-installer');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fileResponse(): Response {
  return new Response(new Uint8Array(INSTALLER_BYTES), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(INSTALLER_BYTES.length) },
  });
}

/** In-memory stand-in for ConfigLoader's update-check persistence. */
let savedMode: 'auto' | 'manual';
const modeStore = {
  getUpdateCheckMode: () => savedMode,
  setUpdateCheckMode: (mode: 'auto' | 'manual') => { savedMode = mode; },
};

let testDir: string;
let fetchUrls: string[];

beforeEach(() => {
  handlers.clear();
  quit.mockClear();
  spawnCalls.length = 0;
  progress.length = 0;
  fetchUrls = [];
  savedMode = 'auto';
  testDir = join(tmpdir(), `helm-test-update-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  const fetchFn = vi.fn(async (url: string) => {
    fetchUrls.push(url);
    if (url.includes('api.github.com')) {
      return jsonResponse({
        tag_name: 'v3.12.0',
        html_url: 'https://github.com/PetePeter/helm/releases/tag/v3.12.0',
        assets: [
          { name: 'helm-3.12.0.apk', browser_download_url: 'https://github.com/PetePeter/helm/releases/download/v3.12.0/helm-3.12.0.apk', size: 10 },
          { name: 'Helm Setup 3.12.0.exe', browser_download_url: INSTALLER_URL, size: INSTALLER_BYTES.length },
        ],
      });
    }
    return fileResponse();
  });

  setupUpdateHandlers({
    tempDir: testDir,
    modeStore,
    execPath: 'C:\\Program Files\\Helm\\Helm.exe',
    fetchFn: fetchFn as unknown as typeof fetch,
    spawnFn: ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return { unref: vi.fn() };
    }) as never,
    sendProgress: (p: unknown) => progress.push(p),
    quit,
  });
});

describe('update:check', () => {
  it('reports the newer release with its installer asset', async () => {
    const result = await handlers.get('update:check')!({}, undefined);
    expect(result).toEqual({
      packaged: true,
      current: '3.11.1',
      update: {
        version: '3.12.0',
        releaseUrl: 'https://github.com/PetePeter/helm/releases/tag/v3.12.0',
        installerUrl: INSTALLER_URL,
        installerSize: INSTALLER_BYTES.length,
      },
    });
    expect(fetchUrls[0]).toContain('api.github.com/repos/PetePeter/helm/releases/latest');
  });

  it('answers no update — never throws — when the fetch fails', async () => {
    handlers.clear();
    setupUpdateHandlers({
      tempDir: testDir,
    modeStore,
      execPath: 'x',
      fetchFn: vi.fn(async () => { throw new Error('DNS gone'); }) as unknown as typeof fetch,
      spawnFn: (() => ({ unref: vi.fn() })) as never,
      sendProgress: () => {},
      quit,
    });
    const result = await handlers.get('update:check')!({}, undefined);
    expect(result).toMatchObject({ packaged: true, current: '3.11.1', update: null });
  });
});

describe('update:getMode / update:setMode', () => {
  it('persists a valid mode and reads it back', async () => {
    expect(await handlers.get('update:getMode')!({})).toBe('auto');
    expect(await handlers.get('update:setMode')!({}, 'manual')).toEqual({ success: true });
    expect(await handlers.get('update:getMode')!({})).toBe('manual');
  });

  it('rejects an unknown mode without touching the stored one', async () => {
    const result = await handlers.get('update:setMode')!({}, 'hourly');
    expect(result).toMatchObject({ success: false });
    expect(savedMode).toBe('auto');
  });
});

describe('update:install', () => {
  it('downloads the installer, writes and spawns the script, then quits', async () => {
    const result = await handlers.get('update:install')!({}, INSTALLER_URL);
    expect(result).toEqual({ success: true });

    // Installer bytes landed on disk under the temp dir
    const installerPath = join(testDir, 'helm-update-Helm Setup 3.12.0.exe');
    expect(readFileSync(installerPath)).toEqual(INSTALLER_BYTES);

    // The script matches buildUpdateScript for these exact paths
    const scriptPath = join(testDir, 'helm-update-run.cmd');
    expect(readFileSync(scriptPath, 'utf-8')).toBe(buildUpdateScript(installerPath, 'C:\\Program Files\\Helm\\Helm.exe'));

    // Detached cmd runs the script
    expect(spawnCalls).toEqual([{ command: 'cmd.exe', args: ['/c', scriptPath] }]);

    // Download progress flowed, ending with the restarting stage
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toMatchObject({ stage: 'restarting', percent: 100 });

    // Quit is deferred so the renderer can show its toast first
    expect(quit).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(quit).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('refuses URLs outside the Helm release downloads', async () => {
    const result = await handlers.get('update:install')!({}, 'https://evil.example.com/x.exe');
    expect(result).toMatchObject({ success: false });
    expect(spawnCalls).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
  });

  it('reports failure without spawning when the download is truncated', async () => {
    handlers.clear();
    const truncated = new Response(new Uint8Array(4), {
      status: 200,
      headers: { 'Content-Length': String(INSTALLER_BYTES.length) },
    });
    setupUpdateHandlers({
      tempDir: testDir,
    modeStore,
      execPath: 'x',
      fetchFn: vi.fn(async (url: string) => (url.includes('api.github.com') ? jsonResponse({}) : truncated)) as unknown as typeof fetch,
      spawnFn: ((..._a: unknown[]) => ({ unref: vi.fn() })) as never,
      sendProgress: (p: unknown) => progress.push(p),
      quit,
    });
    const result = await handlers.get('update:install')!({}, INSTALLER_URL);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('truncated') });
    expect(spawnCalls).toEqual([]);
    expect(progress[progress.length - 1]).toMatchObject({ stage: 'failed' });
    expect(!existsSync(join(testDir, 'helm-update-Helm Setup 3.12.0.exe'))).toBe(true);
  });

  it('ignores a second install click while one is in flight', async () => {
    const first = handlers.get('update:install')!;
    await first({}, INSTALLER_URL);
    const again = await handlers.get('update:install')!({}, INSTALLER_URL);
    expect(again).toEqual({ success: true });
    expect(spawnCalls).toHaveLength(1);
  });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});
