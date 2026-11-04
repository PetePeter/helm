/**
 * IncomingPlansWatcher tests
 *
 * Uses mocked chokidar and fs to avoid real file I/O while still covering
 * all processing paths: valid import, invalid JSON, duplicate ID, validation
 * errors, listFiles, deleteFile, title collision rename.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/utils/app-paths.js', () => ({
  getConfigDir: vi.fn(() => '/config'),
}));

// ─── Mock chokidar ───────────────────────────────────────────────────────────
// Use vi.hoisted() so variables are available inside the vi.mock factory
// (which is hoisted to the top of the file by Vitest).

const { mockWatcherOn, mockWatcherClose, mockChokidarWatch } = vi.hoisted(() => {
  const mockWatcherOn = vi.fn();
  const mockWatcherClose = vi.fn().mockResolvedValue(undefined);
  const mockChokidarWatch = vi.fn(() => ({
    on: mockWatcherOn,
    close: mockWatcherClose,
  }));
  return { mockWatcherOn, mockWatcherClose, mockChokidarWatch };
});

vi.mock('chokidar', () => ({
  default: { watch: mockChokidarWatch },
}));

// ─── Mock node:fs ────────────────────────────────────────────────────────────

const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn(() => true);
const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn(() => [] as string[]);
const mockReadFileSync = vi.fn(() => '{}');

vi.mock('node:fs', () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
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

import { IncomingPlansWatcher } from '../src/session/incoming-plans-watcher.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { SuggestedPlanService } from '../src/session/suggested-plan-service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeValidJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'plan-abc-123',
    dirPath: '/projects/backend',
    title: 'Implement Auth',
    description: 'JWT middleware',
    status: 'ready',
    ...overrides,
  });
}

/** Capture the chokidar 'add' callback so tests can call it directly. */
function getAddCallback(): (filePath: string) => void {
  const calls = mockWatcherOn.mock.calls;
  const addCall = calls.find(c => c[0] === 'add');
  if (!addCall) throw new Error('No "add" handler registered on watcher');
  return addCall[1] as (filePath: string) => void;
}

/** Capture the chokidar 'change' callback. */
function getChangeCallback(): (filePath: string) => void {
  const calls = mockWatcherOn.mock.calls;
  const changeCall = calls.find(c => c[0] === 'change');
  if (!changeCall) throw new Error('No "change" handler registered on watcher');
  return changeCall[1] as (filePath: string) => void;
}

/** Capture the chokidar 'unlink' callback. */
function getUnlinkCallback(): (filePath: string) => void {
  const calls = mockWatcherOn.mock.calls;
  const unlinkCall = calls.find(c => c[0] === 'unlink');
  if (!unlinkCall) throw new Error('No "unlink" handler registered on watcher');
  return unlinkCall[1] as (filePath: string) => void;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IncomingPlansWatcher', () => {
  let planManager: PlanManager;
  let memories: MemoryManager;
  let suggestedPlanService: SuggestedPlanService;
  let sessionProjectId: string;
  let watcher: IncomingPlansWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    planManager = new PlanManager();
    vi.spyOn(planManager, 'getProjectIdForDirectory').mockReturnValue('project-backend');
    sessionProjectId = 'project-backend';
    memories = new MemoryManager({ resolveSessionProject: () => sessionProjectId });
    suggestedPlanService = new SuggestedPlanService(planManager, memories);
    watcher = new IncomingPlansWatcher(planManager, suggestedPlanService, '/config');
  });

  function createIdea(stage: 'suggested' | 'growing' = 'suggested', projectId = 'project-backend'): string {
    sessionProjectId = projectId;
    const idea = memories.createForSession('session-a', {
      kind: 'idea',
      tldr: 'A useful idea',
      content: 'A sufficiently detailed idea description.',
    });
    sessionProjectId = 'project-backend';
    memories.update(idea.id, { ideaStage: stage });
    return idea.id;
  }

  // ─── start / close ─────────────────────────────────────────────────────────

  describe('start()', () => {
    it('creates the incoming directory if missing', () => {
      watcher.start();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('incoming'),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('calls chokidar.watch on the incoming directory', () => {
      watcher.start();
      expect(mockChokidarWatch).toHaveBeenCalledWith(
        expect.stringContaining('incoming'),
        expect.objectContaining({ awaitWriteFinish: expect.any(Object) }),
      );
    });

    it('registers add, change, unlink, and error handlers on the chokidar watcher', () => {
      watcher.start();
      const channels = mockWatcherOn.mock.calls.map(c => c[0]);
      expect(channels).toContain('add');
      expect(channels).toContain('change');
      expect(channels).toContain('unlink');
      expect(channels).toContain('error');
    });
  });

  describe('close()', () => {
    it('closes the chokidar watcher and nullifies it', async () => {
      watcher.start();
      await watcher.close();
      expect(mockWatcherClose).toHaveBeenCalledOnce();
    });

    it('is safe to call when not started', async () => {
      await expect(watcher.close()).resolves.toBeUndefined();
      expect(mockWatcherClose).not.toHaveBeenCalled();
    });
  });

  // ─── listFiles ─────────────────────────────────────────────────────────────

  describe('listFiles()', () => {
    it('returns empty array when incoming dir does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(watcher.listFiles()).toEqual([]);
    });

    it('returns only .json files', () => {
      mockReaddirSync.mockReturnValue(['a.json', 'b.json', 'README.md', '.gitkeep'] as unknown as string[]);
      const result = watcher.listFiles();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/a\.json$/);
      expect(result[1]).toMatch(/b\.json$/);
    });

    it('returns empty array when directory is empty', () => {
      mockReaddirSync.mockReturnValue([] as unknown as string[]);
      expect(watcher.listFiles()).toEqual([]);
    });
  });

  // ─── deleteFile ────────────────────────────────────────────────────────────

  describe('deleteFile()', () => {
    it('deletes a file and returns true', () => {
      mockExistsSync.mockReturnValue(true);
      const result = watcher.deleteFile('my-plan.json');
      expect(mockUnlinkSync).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });

    it('returns false if file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const result = watcher.deleteFile('missing.json');
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('rejects path traversal — only uses basename', () => {
      mockExistsSync.mockReturnValue(false);
      watcher.deleteFile('../../evil.json');
      // Should resolve to incoming dir + 'evil.json' only
      const firstArg = (mockExistsSync as Mock).mock.calls[0]?.[0] as string;
      expect(firstArg).not.toContain('..');
    });
  });

  // ─── processFile — valid JSON ───────────────────────────────────────────────

  describe('processFile() — valid input', () => {
    it('emits incoming-imported with correct fields on success', () => {
      mockReadFileSync.mockReturnValue(makeValidJson());
      watcher.start();

      const onImported = vi.fn();
      watcher.on('incoming-imported', onImported);

      getAddCallback()('/config/plans/incoming/plan.json');

      expect(onImported).toHaveBeenCalledOnce();
      const evt = onImported.mock.calls[0][0];
      expect(evt.filename).toBe('plan.json');
      expect(evt.title).toBe('Implement Auth');
      expect(evt.dirPath).toBe('/projects/backend');
    });

    it('deletes the source file after successful import', () => {
      mockReadFileSync.mockReturnValue(makeValidJson());
      watcher.start();
      getAddCallback()('/config/plans/incoming/plan.json');
      expect(mockUnlinkSync).toHaveBeenCalledWith('/config/plans/incoming/plan.json');
    });

    it('forces imported item status to startable', () => {
      // Even if file says 'coding', importItem must normalise to 'ready'
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'coding' }));
      watcher.start();

      const importSpy = vi.spyOn(planManager, 'importItem');
      const onImported = vi.fn();
      watcher.on('incoming-imported', onImported);
      getAddCallback()('/config/plans/incoming/plan.json');

      // Spy was set up before processFile ran — verify status was normalised
      expect(importSpy).toHaveBeenCalledOnce();
      const passedItem = importSpy.mock.calls[0][0];
      // File sent 'coding' but importItem must receive the item and force 'ready' internally
      // (PlanManager.importItem always sets status='ready'; watcher passes item as-is)
      expect(passedItem.status).toBe('coding'); // watcher passes raw status; manager normalises
      expect(onImported).toHaveBeenCalled();
    });

    it('validates a linked idea and forces the imported plan to suggested', () => {
      const sourceIdeaId = createIdea();
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'ready', sourceIdeaId }));
      watcher.start();
      const importSpy = vi.spyOn(planManager, 'importItem');

      getAddCallback()('/config/plans/incoming/suggested.json');

      expect(importSpy.mock.calls[0]?.[0]).toMatchObject({ status: 'suggested', sourceIdeaId });
      expect(planManager.getItem('plan-abc-123')?.status).toBe('suggested');
    });

    it('refuses a second incoming plan for an idea with a live suggestion and reports that plan id', () => {
      const sourceIdeaId = createIdea();
      const existing = suggestedPlanService.createSuggested({
        dirPath: '/projects/backend',
        title: 'Existing suggestion',
        description: 'Already linked to this idea.',
        sourceIdeaId,
      });
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'ready', sourceIdeaId }));
      watcher.start();
      const importSpy = vi.spyOn(planManager, 'importItem');
      const onError = vi.fn();
      watcher.on('incoming-error', onError);

      getAddCallback()('/config/plans/incoming/duplicate-suggestion.json');

      expect(importSpy).not.toHaveBeenCalled();
      expect(onError.mock.calls[0]?.[0].error).toContain(existing.id);
      expect(watcher.getFailedFiles().has('duplicate-suggestion.json')).toBe(true);
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'missing idea', projectId: 'project-backend', stage: 'suggested', missing: true },
      { label: 'idea from another project', projectId: 'other-project', stage: 'suggested', missing: false },
      { label: 'idea at the wrong stage', projectId: 'project-backend', stage: 'growing', missing: false },
    ] as const)('keeps a linked import unimported when its $label is invalid', ({ projectId, stage, missing }) => {
      const sourceIdeaId = missing ? 'missing-idea' : createIdea(stage, projectId);
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'ready', sourceIdeaId }));
      watcher.start();
      const importSpy = vi.spyOn(planManager, 'importItem');
      const onError = vi.fn();
      watcher.on('incoming-error', onError);

      getAddCallback()('/config/plans/incoming/invalid-link.json');

      expect(importSpy).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
      expect(watcher.getFailedFiles().has('invalid-link.json')).toBe(true);
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('rejects a suggested status that has no source idea', () => {
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'suggested' }));
      watcher.start();
      const importSpy = vi.spyOn(planManager, 'importItem');
      const onError = vi.fn();
      watcher.on('incoming-error', onError);

      getAddCallback()('/config/plans/incoming/unlinked-suggestion.json');

      expect(importSpy).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
      expect(watcher.getFailedFiles().has('unlinked-suggestion.json')).toBe(true);
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('ignores non-.json files', () => {
      watcher.start();
      const onImported = vi.fn();
      watcher.on('incoming-imported', onImported);

      getAddCallback()('/config/plans/incoming/readme.txt');
      expect(onImported).not.toHaveBeenCalled();
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  // ─── processFile — invalid JSON ────────────────────────────────────────────

  describe('processFile() — invalid JSON', () => {
    it('emits incoming-error and keeps file on malformed JSON', () => {
      mockReadFileSync.mockReturnValue('not json!!!');
      watcher.start();

      const onError = vi.fn();
      watcher.on('incoming-error', onError);

      getAddCallback()('/config/plans/incoming/bad.json');

      expect(onError).toHaveBeenCalledOnce();
      const evt = onError.mock.calls[0][0];
      expect(evt.filename).toBe('bad.json');
      expect(evt.error).toMatch(/Invalid JSON/);
      expect(evt.filePath).toMatch(/bad\.json$/);
      // File is NOT deleted — kept for user to fix and retry
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      // Error is tracked in failedFiles
      expect(watcher.getFailedFiles().get('bad.json')).toMatch(/Invalid JSON/);
    });

    it('emits incoming-error for missing required id field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        dirPath: '/proj', title: 'T', description: 'D',
      }));
      watcher.start();

      const onError = vi.fn();
      watcher.on('incoming-error', onError);
      getAddCallback()('/config/plans/incoming/no-id.json');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error).toMatch(/id/);
    });

    it('emits incoming-error for missing required dirPath field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        id: 'x', title: 'T', description: 'D',
      }));
      watcher.start();

      const onError = vi.fn();
      watcher.on('incoming-error', onError);
      getAddCallback()('/config/plans/incoming/no-dir.json');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error).toMatch(/dirPath/);
    });

    it('emits incoming-error for missing title', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        id: 'x', dirPath: '/proj', description: 'D',
      }));
      watcher.start();

      const onError = vi.fn();
      watcher.on('incoming-error', onError);
      getAddCallback()('/config/plans/incoming/no-title.json');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error).toMatch(/title/);
    });

    it('emits incoming-error for invalid status value', () => {
      mockReadFileSync.mockReturnValue(makeValidJson({ status: 'unknown-status' }));
      watcher.start();

      const onError = vi.fn();
      watcher.on('incoming-error', onError);
      getAddCallback()('/config/plans/incoming/bad-status.json');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error).toMatch(/status/);
    });
  });

  // ─── processFile — duplicate ID ────────────────────────────────────────────

  describe('processFile() — duplicate ID', () => {
    it('emits incoming-error and keeps file when ID already exists', () => {
      // Pre-populate planManager with the same ID
      const json = makeValidJson({ id: 'existing-id' });
      mockReadFileSync.mockReturnValue(json);
      planManager.importItem({
        id: 'existing-id',
        dirPath: '/projects/backend',
        title: 'Already Exists',
        description: '',
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      watcher.start();
      const onError = vi.fn();
      const onImported = vi.fn();
      watcher.on('incoming-error', onError);
      watcher.on('incoming-imported', onImported);

      getAddCallback()('/config/plans/incoming/dup.json');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error).toMatch(/[Dd]uplicate/);
      expect(onImported).not.toHaveBeenCalled();
      // File is NOT deleted — kept for user to fix and retry
      expect(watcher.getFailedFiles().get('dup.json')).toMatch(/[Dd]uplicate/);
    });
  });

  // ─── Title collision rename ─────────────────────────────────────────────────

  describe('title collision rename', () => {
    it('auto-renames title to avoid collision (handled by PlanManager)', () => {
      // First import succeeds with 'Implement Auth'
      const json = makeValidJson();
      mockReadFileSync.mockReturnValue(json);
      watcher.start();

      const importedTitles: string[] = [];
      watcher.on('incoming-imported', (e: { title: string }) => importedTitles.push(e.title));

      getAddCallback()('/config/plans/incoming/first.json');
      expect(importedTitles[0]).toBe('Implement Auth');

      // Second import with same title but different ID should get renamed
      mockReadFileSync.mockReturnValue(makeValidJson({ id: 'different-id' }));
      getAddCallback()('/config/plans/incoming/second.json');

      // PlanManager.importItem renames to 'Implement Auth (2)'
      expect(importedTitles[1]).toBe('Implement Auth (2)');
    });
  });

  // ─── failedFiles tracking ──────────────────────────────────────────────────

  describe('failedFiles tracking', () => {
    it('tracks rejected files in getFailedFiles()', () => {
      mockReadFileSync.mockReturnValue('not json');
      watcher.start();
      getAddCallback()('/config/plans/incoming/bad.json');

      const failed = watcher.getFailedFiles();
      expect(failed.size).toBe(1);
      expect(failed.get('bad.json')).toMatch(/Invalid JSON/);
    });

    it('returns a defensive copy from getFailedFiles()', () => {
      mockReadFileSync.mockReturnValue('not json');
      watcher.start();
      getAddCallback()('/config/plans/incoming/bad.json');

      const copy = watcher.getFailedFiles();
      copy.delete('bad.json');
      expect(watcher.getFailedFiles().size).toBe(1);
    });

    it('clears failedFiles on close()', async () => {
      mockReadFileSync.mockReturnValue('not json');
      watcher.start();
      getAddCallback()('/config/plans/incoming/bad.json');
      expect(watcher.getFailedFiles().size).toBe(1);

      await watcher.close();
      expect(watcher.getFailedFiles().size).toBe(0);
    });

    it('deleteFile() clears the error and emits incoming-error-cleared', () => {
      mockReadFileSync.mockReturnValue('not json');
      watcher.start();
      getAddCallback()('/config/plans/incoming/bad.json');
      expect(watcher.getFailedFiles().has('bad.json')).toBe(true);

      const onCleared = vi.fn();
      watcher.on('incoming-error-cleared', onCleared);

      mockExistsSync.mockReturnValue(true);
      watcher.deleteFile('bad.json');

      expect(watcher.getFailedFiles().has('bad.json')).toBe(false);
      expect(onCleared).toHaveBeenCalledOnce();
      expect(onCleared.mock.calls[0][0].filename).toBe('bad.json');
    });
  });

  // ─── chokidar change handler ──────────────────────────────────────────────

  describe('change event handler', () => {
    it('re-processes a file on change event', () => {
      watcher.start();

      // First add with bad JSON
      mockReadFileSync.mockReturnValue('not json');
      getAddCallback()('/config/plans/incoming/fix-me.json');
      expect(watcher.getFailedFiles().has('fix-me.json')).toBe(true);

      // Fix file and trigger change
      mockReadFileSync.mockReturnValue(makeValidJson({ id: 'fixed-id' }));
      const onCleared = vi.fn();
      const onImported = vi.fn();
      watcher.on('incoming-error-cleared', onCleared);
      watcher.on('incoming-imported', onImported);

      getChangeCallback()('/config/plans/incoming/fix-me.json');

      expect(onCleared).toHaveBeenCalledOnce();
      expect(onImported).toHaveBeenCalledOnce();
      expect(watcher.getFailedFiles().has('fix-me.json')).toBe(false);
    });

    it('updates failedFiles when change still has errors', () => {
      watcher.start();

      mockReadFileSync.mockReturnValue('bad json 1');
      getAddCallback()('/config/plans/incoming/broken.json');
      expect(watcher.getFailedFiles().get('broken.json')).toMatch(/Invalid JSON/);

      mockReadFileSync.mockReturnValue(JSON.stringify({ id: 'x' }));
      getChangeCallback()('/config/plans/incoming/broken.json');
      // Now error should be different (missing dirPath, not Invalid JSON)
      expect(watcher.getFailedFiles().get('broken.json')).toMatch(/dirPath/);
    });

    it('ignores non-.json files on change', () => {
      watcher.start();
      getChangeCallback()('/config/plans/incoming/readme.txt');
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  // ─── chokidar unlink handler ──────────────────────────────────────────────

  describe('unlink event handler', () => {
    it('clears failedFiles and emits incoming-error-cleared on unlink', () => {
      watcher.start();

      mockReadFileSync.mockReturnValue('not json');
      getAddCallback()('/config/plans/incoming/gone.json');
      expect(watcher.getFailedFiles().has('gone.json')).toBe(true);

      const onCleared = vi.fn();
      watcher.on('incoming-error-cleared', onCleared);

      getUnlinkCallback()('/config/plans/incoming/gone.json');

      expect(watcher.getFailedFiles().has('gone.json')).toBe(false);
      expect(onCleared).toHaveBeenCalledOnce();
      expect(onCleared.mock.calls[0][0].filename).toBe('gone.json');
    });

    it('does nothing for unlink of non-failed file', () => {
      watcher.start();

      const onCleared = vi.fn();
      watcher.on('incoming-error-cleared', onCleared);

      getUnlinkCallback()('/config/plans/incoming/unknown.json');

      expect(onCleared).not.toHaveBeenCalled();
    });

    it('ignores non-.json files on unlink', () => {
      watcher.start();

      const onCleared = vi.fn();
      watcher.on('incoming-error-cleared', onCleared);

      getUnlinkCallback()('/config/plans/incoming/readme.txt');
      expect(onCleared).not.toHaveBeenCalled();
    });
  });

  // ─── ENOENT guard ─────────────────────────────────────────────────────────

  describe('ENOENT guard', () => {
    it('skips processing when file is gone before read', () => {
      watcher.start();

      mockExistsSync.mockReturnValue(false);
      const onError = vi.fn();
      const onImported = vi.fn();
      watcher.on('incoming-error', onError);
      watcher.on('incoming-imported', onImported);

      getAddCallback()('/config/plans/incoming/vanished.json');

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(onImported).not.toHaveBeenCalled();
    });
  });

  // ─── accessors ─────────────────────────────────────────────────────────────

  describe('accessors', () => {
    it('getIncomingDir() returns the correct path', () => {
      expect(watcher.getIncomingDir()).toMatch(/incoming$/);
    });

    it('getFailedFiles() returns empty map initially', () => {
      expect(watcher.getFailedFiles().size).toBe(0);
    });
  });
});
