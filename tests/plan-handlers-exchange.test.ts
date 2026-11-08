/**
 * Tests for the new plan exchange IPC channels:
 *   plan:incoming-list, plan:incoming-delete
 *   plan:export-item, plan:export-directory
 *   plan:read-file, plan:write-file
 *   plan:open-external
 *
 * Also tests that the incoming-watcher events forward to the renderer window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const handlers = new Map<string, Function>();

const mockShellOpenPath = vi.fn();
const mockExistsSync = vi.fn(() => true);

vi.mock('electron', () => {
  const mockGetAllWindows = vi.fn(() => []);
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: Function) => {
        handlers.set(channel, handler);
      }),
    },
    shell: { openPath: (...args: unknown[]) => mockShellOpenPath(...args) },
    BrowserWindow: {
      getAllWindows: mockGetAllWindows,
    },
  };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/utils/app-paths.js', () => ({
  getTempDir: () => '/tmp/helm-test',
  getRendererHtmlPath: () => 'about:blank',
  getConfigDir: () => '/tmp/helm-config',
  getProfileConfigDir: () => '/tmp/helm-config',
}));

vi.mock('../src/session/persistence.js', () => ({
  savePlanFile: vi.fn(),
  deletePlanFile: vi.fn(),
  listPlanFiles: vi.fn(() => []),
  loadPlanFile: vi.fn(() => null),
  loadDependencies: vi.fn(() => []),
  saveDependencies: vi.fn(),
  cleanupOrphanDependencies: vi.fn(() => ({ removed: 0, deps: [] })),
  loadPlanSequences: vi.fn(() => []),
  savePlanSequences: vi.fn(),
  loadPlanContexts: vi.fn(() => []),
  savePlanContexts: vi.fn(),
  loadPlanContextBindings: vi.fn(() => []),
  savePlanContextBindings: vi.fn(),
}));

vi.mock('../src/electron/window-icon.js', () => ({
  resolveWindowIconPath: () => undefined,
}));

// Mock node:fs for read-file / write-file tests
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockChmodSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

import { setupPlanHandlers } from '../src/electron/ipc/plan-handlers.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { BrowserWindow } from 'electron';

// ─── Fake IncomingPlansWatcher ────────────────────────────────────────────────

class FakeWatcher extends EventEmitter {
  listFiles = vi.fn(() => [] as string[]);
  deleteFile = vi.fn(() => true);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    dirPath: '/proj',
    title: 'Task',
    description: 'Do the thing',
    status: 'ready' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('plan exchange IPC channels', () => {
  let planManager: PlanManager;
  let fakeWatcher: FakeWatcher;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    planManager = new PlanManager();
    fakeWatcher = new FakeWatcher();
    setupPlanHandlers(planManager, undefined as any, fakeWatcher as any);
  });

  // ─── Registration ──────────────────────────────────────────────────────────

  it('registers new exchange channels', () => {
    const expected = [
      'plan:incoming-list',
      'plan:incoming-delete',
      'plan:export-item',
      'plan:export-directory',
      'plan:read-file',
      'plan:write-file',
      'plan:open-external',
    ];
    for (const ch of expected) {
      expect(handlers.has(ch), `missing channel: ${ch}`).toBe(true);
    }
  });

  // ─── plan:incoming-list ────────────────────────────────────────────────────

  describe('plan:incoming-list', () => {
    it('returns file list from watcher', async () => {
      fakeWatcher.listFiles.mockReturnValue(['a.json', 'b.json']);
      const result = await handlers.get('plan:incoming-list')!({});
      expect(result).toEqual(['a.json', 'b.json']);
    });

    it('returns empty array when no files', async () => {
      fakeWatcher.listFiles.mockReturnValue([]);
      const result = await handlers.get('plan:incoming-list')!({});
      expect(result).toEqual([]);
    });

    it('returns empty array when no watcher provided', async () => {
      handlers.clear();
      setupPlanHandlers(planManager); // no watcher
      const result = await handlers.get('plan:incoming-list')!({});
      expect(result).toEqual([]);
    });
  });

  // ─── plan:incoming-delete ──────────────────────────────────────────────────

  describe('plan:incoming-delete', () => {
    it('delegates to watcher.deleteFile and returns true on success', async () => {
      fakeWatcher.deleteFile.mockReturnValue(true);
      const result = await handlers.get('plan:incoming-delete')!({}, 'file.json');
      expect(fakeWatcher.deleteFile).toHaveBeenCalledWith('file.json');
      expect(result).toBe(true);
    });

    it('returns false when file does not exist', async () => {
      fakeWatcher.deleteFile.mockReturnValue(false);
      const result = await handlers.get('plan:incoming-delete')!({}, 'missing.json');
      expect(result).toBe(false);
    });

    it('returns false when no watcher provided', async () => {
      handlers.clear();
      setupPlanHandlers(planManager);
      const result = await handlers.get('plan:incoming-delete')!({}, 'file.json');
      expect(result).toBe(false);
    });
  });

  // ─── plan:export-item ─────────────────────────────────────────────────────

  describe('plan:export-item', () => {
    it('returns JSON string with item and dependencies', async () => {
      const item = planManager.create('/proj', 'My Task', 'desc');
      const result = await handlers.get('plan:export-item')!({}, item.id);
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result);
      expect(parsed.item).toMatchObject({ id: item.id, title: 'My Task' });
      expect(Array.isArray(parsed.dependencies)).toBe(true);
    });

    it('returns null for unknown plan ID', async () => {
      const result = await handlers.get('plan:export-item')!({}, 'nonexistent');
      expect(result).toBeNull();
    });

    it('exported JSON includes dependencies touching the item', async () => {
      const a = planManager.create('/proj', 'A', '');
      const b = planManager.create('/proj', 'B', '');
      planManager.addDependency(a.id, b.id);

      const resultA = JSON.parse(await handlers.get('plan:export-item')!({}, a.id));
      expect(resultA.dependencies).toHaveLength(1);
      expect(resultA.dependencies[0]).toMatchObject({ fromId: a.id, toId: b.id });
    });
  });

  // ─── plan:export-directory ────────────────────────────────────────────────

  describe('plan:export-directory', () => {
    it('returns JSON with all items for a directory', async () => {
      planManager.create('/proj', 'Task 1', '');
      planManager.create('/proj', 'Task 2', '');
      planManager.create('/other', 'Unrelated', '');

      const result = await handlers.get('plan:export-directory')!({}, '/proj');
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result);
      expect(parsed.dirPath).toBe('/proj');
      expect(parsed.items).toHaveLength(2);
    });

    it('includes cross-item dependencies in export', async () => {
      const a = planManager.create('/proj', 'A', '');
      const b = planManager.create('/proj', 'B', '');
      planManager.addDependency(a.id, b.id);

      const result = JSON.parse(await handlers.get('plan:export-directory')!({}, '/proj'));
      expect(result.dependencies).toHaveLength(1);
    });

    it('returns null for empty directory', async () => {
      const result = await handlers.get('plan:export-directory')!({}, '/empty');
      expect(result).toBeNull();
    });
  });

  // ─── plan:read-file ────────────────────────────────────────────────────────

  describe('plan:read-file', () => {
    it('reads and returns file content', async () => {
      mockReadFileSync.mockReturnValue('{"id":"x"}');
      const result = await handlers.get('plan:read-file')!({}, '/some/file.json');
      expect(result).toBe('{"id":"x"}');
      expect(mockReadFileSync).toHaveBeenCalledWith('/some/file.json', 'utf8');
    });

    it('returns null if file does not exist', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const result = await handlers.get('plan:read-file')!({}, '/missing.json');
      expect(result).toBeNull();
    });
  });

  // ─── plan:write-file ──────────────────────────────────────────────────────

  describe('plan:write-file', () => {
    it('writes content to file and returns true', async () => {
      mockWriteFileSync.mockImplementation(() => {});
      const result = await handlers.get('plan:write-file')!({}, '/out/plan.json', '{"data":1}');
      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledWith('/out/plan.json', '{"data":1}', 'utf8');
    });

    it('creates parent directories before writing', async () => {
      mockMkdirSync.mockImplementation(() => {});
      mockWriteFileSync.mockImplementation(() => {});
      await handlers.get('plan:write-file')!({}, '/deep/nested/plan.json', '{}');
      expect(mockMkdirSync).toHaveBeenCalledWith('/deep/nested', expect.objectContaining({ recursive: true }));
    });

    it('returns false if write fails', async () => {
      mockMkdirSync.mockImplementation(() => {});
      mockWriteFileSync.mockImplementation(() => { throw new Error('Permission denied'); });
      const result = await handlers.get('plan:write-file')!({}, '/readonly/plan.json', '{}');
      expect(result).toBe(false);
    });
  });

  // ─── Incoming watcher event forwarding ────────────────────────────────────

  // ─── plan:open-external ───────────────────────────────────────────────────

  describe('plan:open-external', () => {
    it('exports selected plan as Markdown and opens via shell', async () => {
      const item = planManager.create('/proj', 'My Task', 'Do the thing');
      mockShellOpenPath.mockResolvedValue(undefined as any);
      mockWriteFileSync.mockImplementation(() => {});

      const result = await handlers.get('plan:open-external')!({}, item.id);

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/[\\/]tmp[\\/]helm-test[\\/]helm-plan-export-My_Task-\d+\.md$/);
      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenMd = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenMd).toContain('<!-- auto-generated by Helm - read-only -->');
      expect(writtenMd).toContain('# My Task');
      expect(writtenMd).toContain('Do the thing');
      expect(writtenMd).toContain('ready');
      expect(mockChmodSync).toHaveBeenCalledWith(result.path, 0o444);
      expect(mockShellOpenPath).toHaveBeenCalledWith(result.path);
    });

    it('returns failure for unknown plan ID', async () => {
      const result = await handlers.get('plan:open-external')!({}, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns failure when shell.openPath fails', async () => {
      const item = planManager.create('/proj', 'X', '');
      mockShellOpenPath.mockResolvedValue('No app associated');
      mockWriteFileSync.mockImplementation(() => {});

      const result = await handlers.get('plan:open-external')!({}, item.id);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No app associated');
    });

    it('includes dependencies and completion notes in Markdown', async () => {
      const a = planManager.create('/proj', 'A', 'Plan A');
      const b = planManager.create('/proj', 'B', 'Plan B');
      planManager.addDependency(a.id, b.id);
      planManager.setState(a.id, 'coding', 'Working on A', 'session-1');
      planManager.completeItem(a.id, 'Finished the plan work');

      mockShellOpenPath.mockResolvedValue(undefined as any);
      mockWriteFileSync.mockImplementation(() => {});

      await handlers.get('plan:open-external')!({}, a.id);

      const writtenMd = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenMd).toContain('## Dependencies');
      expect(writtenMd).toContain('P-0002 - B');
      expect(writtenMd).toContain('## Completion Notes');
      expect(writtenMd).toContain('Finished the plan work');
    });
  });

  describe('incoming watcher event forwarding', () => {
    it('forwards incoming-imported event to renderer window', () => {
      const mockSend = vi.fn();
      (BrowserWindow.getAllWindows as any).mockReturnValue([{ isDestroyed: () => false, webContents: { send: mockSend } }]);

      fakeWatcher.emit('incoming-imported', { filename: 'x.json', title: 'Task', dirPath: '/proj' });

      expect(mockSend).toHaveBeenCalledWith('plan:incoming-imported', expect.objectContaining({ title: 'Task' }));
    });

    it('forwards incoming-error event to renderer window', () => {
      const mockSend = vi.fn();
      (BrowserWindow.getAllWindows as any).mockReturnValue([{ isDestroyed: () => false, webContents: { send: mockSend } }]);

      fakeWatcher.emit('incoming-error', { filename: 'bad.json', error: 'Invalid JSON' });

      expect(mockSend).toHaveBeenCalledWith('plan:incoming-error', expect.objectContaining({ error: 'Invalid JSON' }));
    });

    it('does not forward if window is destroyed', () => {
      const mockSend = vi.fn();
      (BrowserWindow.getAllWindows as any).mockReturnValue([{ isDestroyed: () => true, webContents: { send: mockSend } }]);

      fakeWatcher.emit('incoming-imported', { filename: 'x.json', title: 'T', dirPath: '/proj' });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not forward if no window returned', () => {
      (BrowserWindow.getAllWindows as any).mockReturnValue([]);
      // Should not throw
      expect(() => fakeWatcher.emit('incoming-imported', { filename: 'x.json', title: 'T', dirPath: '/proj' })).not.toThrow();
    });
  });
});
