/**
 * Recycle-bin IPC handler tests — artifact lifecycle across Forget / Empty /
 * Restore. Real RecycleBinManager + real ArtifactManager (no mocks for the
 * managers); Electron and the bin's disk persistence are faked.
 *
 * Contract under test:
 *   - a recoverable session's artifacts are preserved while it sits in the bin,
 *   - Forget clears exactly that entry's artifacts,
 *   - Empty clears every binned entry's artifacts,
 *   - Restore does NOT clear (the session comes back with its artifacts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecycleBinEntry, RecycleBinPurgeJob } from '../src/types/recycle-bin.js';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

let diskStore: RecycleBinEntry[] = [];
let diskPurges: RecycleBinPurgeJob[] = [];
let failDurableSave = false;
vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  saveRecycleBin: (entries: RecycleBinEntry[], _file?: string, pendingPurges: RecycleBinPurgeJob[] = [], requireDurable = false) => {
    if (failDurableSave && requireDurable) throw new Error('disk failure');
    diskStore = [...entries]; diskPurges = [...pendingPurges];
  },
  loadRecycleBinState: () => ({ entries: [...diskStore], pendingPurges: [...diskPurges] }),
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { RecycleBinManager } = await import('../src/session/recycle-bin-manager.js');
const { ArtifactManager } = await import('../src/session/artifact-manager.js');
const { DraftManager } = await import('../src/session/draft-manager.js');
const { TodoManager } = await import('../src/session/todo-manager.js');
const { ArtifactTempRegistry } = await import('../src/session/artifact-temp-registry.js');
const { RecycleBinPurgeMaintenance } = await import('../src/electron/recycle-bin-purge-maintenance.js');
const { setupRecycleBinHandlers } = await import('../src/electron/ipc/recycle-bin-handlers.js');

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

function testRestore(bin: InstanceType<typeof RecycleBinManager>) {
  return async (id: string) => {
    const entry = bin.peek(id);
    if (entry) bin.removeRestored(id);
    return entry;
  };
}

async function waitForPurgeTurns(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function setupPurgeMaintenance(
  bin: InstanceType<typeof RecycleBinManager>,
  artifacts: InstanceType<typeof ArtifactManager>,
  options: { draftManager?: InstanceType<typeof DraftManager>; todoManager?: InstanceType<typeof TodoManager> } = {},
): () => void {
  const maintenance = new RecycleBinPurgeMaintenance();
  maintenance.add({
    userProfileId: 'test-profile',
    recycleBinManager: bin,
    memoryManager: { purgeSession: () => undefined },
    messManager: { onSessionClosed: () => undefined },
    artifactManager: artifacts,
    artifactTempRegistry: new ArtifactTempRegistry(),
    draftManager: options.draftManager ?? { clearSession: () => undefined },
    todoManager: options.todoManager ?? { clearSession: () => undefined },
  } as any);
  return () => maintenance.start();
}

describe('recycle-bin handlers — artifact lifecycle', () => {
  let bin: InstanceType<typeof RecycleBinManager>;
  let artifacts: InstanceType<typeof ArtifactManager>;
  let startMaintenance: () => void;

  beforeEach(() => {
    diskStore = [];
    diskPurges = [];
    failDurableSave = false;
    handleCalls.clear();
    bin = new RecycleBinManager();
    artifacts = new ArtifactManager();
    setupRecycleBinHandlers(bin, undefined, testRestore(bin));
    startMaintenance = setupPurgeMaintenance(bin, artifacts);
  });

  function binSession(sessionId: string): RecycleBinEntry {
    return bin.append({
      sessionId,
      name: 'claude',
      cliType: 'claude-code',
      workingDir: 'X:\\work',
      cliSessionName: 'uuid-' + sessionId,
      closedAt: Date.now(),
    });
  }

  it('Forget clears exactly that entry\'s artifacts, leaving others', async () => {
    artifacts.create('s1', 'A', 'markdown', 'body');
    artifacts.create('s2', 'B', 'markdown', 'body');
    const e1 = binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:forget')(null, e1.id);

    expect(bin.list().map(entry => entry.id)).not.toContain(e1.id);
    expect(artifacts.count('s1')).toBe(1);
    startMaintenance();
    await waitForPurgeTurns();
    expect(artifacts.count('s1')).toBe(0);
    expect(artifacts.count('s2')).toBe(1);
  });

  it('Empty clears every binned entry\'s artifacts', async () => {
    artifacts.create('s1', 'A', 'markdown', 'body');
    artifacts.create('s2', 'B', 'markdown', 'body');
    binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:empty')(null);

    startMaintenance();
    await waitForPurgeTurns();
    expect(artifacts.count('s1')).toBe(0);
    expect(artifacts.count('s2')).toBe(0);
  });

  it('returns a clear failure when Forget or Empty targets an entry being restored', async () => {
    const entry = binSession('restoring');
    bin.beginRestore(entry.id);

    const forget = await getHandler('recycleBin:forget')(null, entry.id);
    const empty = await getHandler('recycleBin:empty')(null);

    expect(forget).toMatchObject({ ok: false, error: expect.stringMatching(/being restored/i) });
    expect(empty).toMatchObject({ ok: false, error: expect.stringMatching(/being restored/i) });
    expect(bin.list().map(item => item.id)).toContain(entry.id);
    expect(bin.pendingPurgeJobs()).toEqual([]);

    bin.releaseRestore(entry.id);
  });

  it('Restore returns the entry after commit and keeps its artifacts', async () => {
    artifacts.create('s1', 'A', 'markdown', 'v1');
    const e1 = binSession('s1');

    const restored = await getHandler('recycleBin:restore')(null, e1.id);

    expect(restored).toMatchObject({ ok: true, entry: { sessionId: 's1' } });   // original id preserved for reuse
    expect(artifacts.count('s1')).toBe(1);    // artifacts intact
    expect(bin.count()).toBe(0);              // one operation spawns then commits
    expect(handleCalls.has('recycleBin:commitRestore')).toBe(false);
  });

  it('failed restore keeps the entry recoverable', async () => {
    artifacts.create('s1', 'A', 'markdown', 'v1');
    const e1 = binSession('s1');
    handleCalls.set('recycleBin:restore', async () => null);

    await getHandler('recycleBin:restore')(null, e1.id);

    expect(bin.count()).toBe(1);              // failed spawn does not commit
    expect(artifacts.count('s1')).toBe(1);    // artifacts preserved for the reused id
  });

  it('returns a restore error when the durable row-removal commit fails', async () => {
    const entry = binSession('restore-commit-failure');
    failDurableSave = true;

    const result = await getHandler('recycleBin:restore')(null, entry.id);

    expect(result).toEqual({ ok: false, error: 'disk failure' });
    expect(bin.list().map(item => item.id)).toContain(entry.id);
    expect(bin.pendingPurgeJobs()).toEqual([]);
  });

  it('defers startup expiry pruning and cleanup until maintenance starts', async () => {
    const now = 1_700_000_000_000;
    diskStore = [{
      id: 'expired', sessionId: 's-old', name: 'claude', cliType: 'claude-code',
      workingDir: 'X:\\work', cliSessionName: 'old-uuid',
      closedAt: now - 7 * 24 * 60 * 60 * 1000 - 1,
    }];
    diskPurges = [];
    const startupBin = new RecycleBinManager(() => now);
    const art = new ArtifactManager();
    setupRecycleBinHandlers(startupBin);
    const start = setupPurgeMaintenance(startupBin, art);

    expect(startupBin.list()).toEqual([]);
    expect(diskStore.map(entry => entry.id)).toEqual(['expired']);
    expect(diskPurges).toEqual([]);

    start();
    await waitForPurgeTurns();
    expect(diskStore).toEqual([]);
    expect(diskPurges).toEqual([]);
    expect(art.count('s-old')).toBe(0);
  });

  it('a bin entry that expires at runtime has its artifacts cleared', async () => {
    // Fresh entry now, then a later append past the window prunes it and fires expired.
    let nowVal = 1_700_000_000_000;
    diskStore = [];
    diskPurges = [];
    handleCalls.clear();
    const clockBin = new RecycleBinManager(() => nowVal);
    const art = new ArtifactManager();
    setupRecycleBinHandlers(clockBin);
    const start = setupPurgeMaintenance(clockBin, art);

    art.create('s1', 'A', 'markdown', 'v1');
    clockBin.append({
      sessionId: 's1', name: 'c', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'u1', closedAt: nowVal,
    });
    expect(art.count('s1')).toBe(1);

    nowVal += 7 * 24 * 60 * 60 * 1000 + 1;
    clockBin.append({
      sessionId: 's2', name: 'c', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'u2', closedAt: nowVal,
    });

    expect(art.count('s1')).toBe(1); // pruning is deferred until the window first shows
    start();
    await waitForPurgeTurns();
    expect(art.count('s1')).toBe(0);
  });
});

describe('recycle-bin handlers: draft lifecycle', () => {
  let bin: InstanceType<typeof RecycleBinManager>;
  let pads: InstanceType<typeof DraftManager>;
  let files: Map<string, unknown>;
  let todoFiles: Map<string, import('../src/types/todo.js').SessionTodo[]>;
  let todos: InstanceType<typeof TodoManager>;
  let nowVal: number;
  let startMaintenance: () => void;

  beforeEach(() => {
    diskStore = [];
    diskPurges = [];
    handleCalls.clear();
    nowVal = 1_700_000_000_000;
    files = new Map();
    todoFiles = new Map();
    bin = new RecycleBinManager(() => nowVal);
    pads = new DraftManager({
      load: (id) => (files.get(id) as never) ?? null,
      save: (pad) => { files.set(pad.sessionId, pad); },
      remove: (id) => { files.delete(id); },
      list: () => [...files.keys()],
    });
    todos = new TodoManager({
      load: id => todoFiles.get(id) ?? null,
      save: (id, list) => { todoFiles.set(id, list); },
      remove: id => { todoFiles.delete(id); },
      list: () => [...todoFiles.keys()],
    });
    setupRecycleBinHandlers(bin, undefined, testRestore(bin));
    startMaintenance = setupPurgeMaintenance(bin, new ArtifactManager(), { draftManager: pads, todoManager: todos });
  });

  function binSession(sessionId: string): RecycleBinEntry {
    pads.set(sessionId, `notes of ${sessionId}`, 'user', 0);
    todos.add(sessionId, `todo of ${sessionId}`);
    return bin.append({
      sessionId, name: 'claude', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'uuid-' + sessionId, closedAt: nowVal,
    });
  }

  it('keeps the pad while the session sits in the bin and through a restore', async () => {
    const entry = binSession('s1');
    expect(files.has('s1')).toBe(true);

    await getHandler('recycleBin:restore')(null, entry.id);

    expect(bin.count()).toBe(0);
    expect(pads.get('s1').text).toBe('notes of s1');
    expect(files.has('s1')).toBe(true);
    expect(todos.list('s1').map(todo => todo.text)).toEqual(['todo of s1']);
    expect(todoFiles.has('s1')).toBe(true);
  });

  it('Forget deletes exactly that session\'s pad', async () => {
    const entry = binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:forget')(null, entry.id);

    expect(files.has('s1')).toBe(true);
    startMaintenance();
    await waitForPurgeTurns();
    expect([...files.keys()]).toEqual(['s2']);
    expect([...todoFiles.keys()]).toEqual(['s2']);
    expect(pads.get('s1')).toEqual({ sessionId: 's1', text: '', revision: 0 });
    expect(todos.list('s1')).toEqual([]);
  });

  it('Empty deletes every binned session\'s pad', async () => {
    binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:empty')(null);

    startMaintenance();
    await waitForPurgeTurns();
    expect(files.size).toBe(0);
    expect(todoFiles.size).toBe(0);
  });

  it('an entry that ages out of the bin takes its pad with it after startup maintenance starts', async () => {
    binSession('s1');
    nowVal += 7 * 24 * 60 * 60 * 1000 + 1;
    binSession('s2');

    expect([...files.keys()]).toEqual(['s1', 's2']);
    expect([...todoFiles.keys()]).toEqual(['s1', 's2']);
    startMaintenance();
    await waitForPurgeTurns();
    expect([...files.keys()]).toEqual(['s2']);
    expect([...todoFiles.keys()]).toEqual(['s2']);
  });
});
