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
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

let diskStore: RecycleBinEntry[] = [];
vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  saveRecycleBin: (entries: RecycleBinEntry[]) => { diskStore = [...entries]; },
  loadRecycleBin: () => [...diskStore],
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { RecycleBinManager } = await import('../src/session/recycle-bin-manager.js');
const { ArtifactManager } = await import('../src/session/artifact-manager.js');
const { ScratchpadManager } = await import('../src/session/scratchpad-manager.js');
const { setupRecycleBinHandlers } = await import('../src/electron/ipc/recycle-bin-handlers.js');

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

describe('recycle-bin handlers — artifact lifecycle', () => {
  let bin: InstanceType<typeof RecycleBinManager>;
  let artifacts: InstanceType<typeof ArtifactManager>;

  beforeEach(() => {
    diskStore = [];
    handleCalls.clear();
    bin = new RecycleBinManager();
    artifacts = new ArtifactManager();
    setupRecycleBinHandlers(bin, artifacts);
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

    expect(artifacts.count('s1')).toBe(0);
    expect(artifacts.count('s2')).toBe(1);
  });

  it('Empty clears every binned entry\'s artifacts', async () => {
    artifacts.create('s1', 'A', 'markdown', 'body');
    artifacts.create('s2', 'B', 'markdown', 'body');
    binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:empty')(null);

    expect(artifacts.count('s1')).toBe(0);
    expect(artifacts.count('s2')).toBe(0);
  });

  it('Restore PEEKS: returns the entry, keeps it in the bin, and never clears artifacts', async () => {
    artifacts.create('s1', 'A', 'markdown', 'v1');
    const e1 = binSession('s1');

    const restored = await getHandler('recycleBin:restore')(null, e1.id);

    expect(restored?.sessionId).toBe('s1');   // original id preserved for reuse
    expect(artifacts.count('s1')).toBe(1);    // artifacts intact
    expect(bin.count()).toBe(1);              // entry stays until commit (retryable)
  });

  it('commitRestore removes the entry but keeps the artifacts (session owns them now)', async () => {
    artifacts.create('s1', 'A', 'markdown', 'v1');
    const e1 = binSession('s1');

    await getHandler('recycleBin:commitRestore')(null, e1.id);

    expect(bin.count()).toBe(0);              // entry gone
    expect(artifacts.count('s1')).toBe(1);    // artifacts preserved for the reused id
  });

  it('a bin entry that expires at runtime has its artifacts cleared', async () => {
    // Fresh entry now, then a later append past the window prunes it and fires expired.
    let nowVal = 1_700_000_000_000;
    diskStore = [];
    handleCalls.clear();
    const clockBin = new RecycleBinManager(() => nowVal);
    const art = new ArtifactManager();
    setupRecycleBinHandlers(clockBin, art);

    art.create('s1', 'A', 'markdown', 'v1');
    clockBin.append({
      sessionId: 's1', name: 'c', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'u1', closedAt: nowVal,
    });
    expect(art.count('s1')).toBe(1);

    nowVal += 30 * 24 * 60 * 60 * 1000 + 1;
    clockBin.append({
      sessionId: 's2', name: 'c', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'u2', closedAt: nowVal,
    });

    expect(art.count('s1')).toBe(0); // expired entry's artifacts reclaimed at runtime
  });
});

describe('recycle-bin handlers: scratchpad lifecycle', () => {
  let bin: InstanceType<typeof RecycleBinManager>;
  let pads: InstanceType<typeof ScratchpadManager>;
  let files: Map<string, unknown>;
  let nowVal: number;

  beforeEach(() => {
    diskStore = [];
    handleCalls.clear();
    nowVal = 1_700_000_000_000;
    files = new Map();
    bin = new RecycleBinManager(() => nowVal);
    pads = new ScratchpadManager({
      load: (id) => (files.get(id) as never) ?? null,
      save: (pad) => { files.set(pad.sessionId, pad); },
      remove: (id) => { files.delete(id); },
      list: () => [...files.keys()],
    });
    setupRecycleBinHandlers(bin, new ArtifactManager(), undefined, undefined, undefined, undefined, undefined, undefined, pads);
  });

  function binSession(sessionId: string): RecycleBinEntry {
    pads.set(sessionId, `notes of ${sessionId}`, 'user', 0);
    return bin.append({
      sessionId, name: 'claude', cliType: 'claude-code', workingDir: 'X:\\work',
      cliSessionName: 'uuid-' + sessionId, closedAt: nowVal,
    });
  }

  it('keeps the pad while the session sits in the bin and through a restore', async () => {
    const entry = binSession('s1');
    expect(files.has('s1')).toBe(true);

    await getHandler('recycleBin:restore')(null, entry.id);
    await getHandler('recycleBin:commitRestore')(null, entry.id);

    expect(bin.count()).toBe(0);
    expect(pads.get('s1').text).toBe('notes of s1');
    expect(files.has('s1')).toBe(true);
  });

  it('Forget deletes exactly that session\'s pad', async () => {
    const entry = binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:forget')(null, entry.id);

    expect([...files.keys()]).toEqual(['s2']);
    expect(pads.get('s1')).toEqual({ sessionId: 's1', text: '', revision: 0 });
  });

  it('Empty deletes every binned session\'s pad', async () => {
    binSession('s1');
    binSession('s2');

    await getHandler('recycleBin:empty')(null);

    expect(files.size).toBe(0);
  });

  it('an entry that ages out of the bin takes its pad with it', () => {
    binSession('s1');
    nowVal += 30 * 24 * 60 * 60 * 1000 + 1;
    binSession('s2');

    expect([...files.keys()]).toEqual(['s2']);
  });
});
