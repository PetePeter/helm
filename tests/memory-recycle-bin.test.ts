import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycleBinPurgeJob } from '../src/types/recycle-bin.js';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { RecycleBinPurgeMaintenance } from '../src/electron/recycle-bin-purge-maintenance.js';
import { setupRecycleBinHandlers } from '../src/electron/ipc/recycle-bin-handlers.js';

function makeRecycleBin(entries: Array<{ id: string; sessionId: string }>) {
  const pending: RecycleBinPurgeJob[] = [];
  const recycleBin = new EventEmitter() as EventEmitter & Record<string, any>;
  recycleBin.list = vi.fn(() => [...entries]);
  recycleBin.peek = vi.fn((id: string) => entries.find(entry => entry.id === id) ?? null);
  recycleBin.pruneExpired = vi.fn(() => []);
  recycleBin.forget = vi.fn((id: string) => {
    const index = entries.findIndex(entry => entry.id === id);
    if (index < 0) return;
    const [entry] = entries.splice(index, 1);
    pending.push({ entry: entry as any, kind: 'forgotten' });
    recycleBin.emit('recycle-bin:changed');
  });
  recycleBin.empty = vi.fn(() => {
    for (const entry of entries.splice(0)) pending.push({ entry: entry as any, kind: 'forgotten' });
    recycleBin.emit('recycle-bin:changed');
  });
  recycleBin.pendingPurgeJobs = vi.fn((skip = new Set<string>()) => pending.filter(job => !skip.has(job.entry.id)));
  recycleBin.completePurge = vi.fn((id: string) => {
    const index = pending.findIndex(job => job.entry.id === id);
    if (index >= 0) pending.splice(index, 1);
  });
  recycleBin.pending = pending;
  return recycleBin;
}

async function waitForQueue(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function setupMaintenance(recycleBin: EventEmitter & Record<string, any>, services: {
  memoryManager: { purgeSession: (id: string) => void };
  messManager: { onSessionClosed: (id: string, kind: 'expired' | 'forgotten') => void };
  artifactManager: { clearSession: (id: string, requireDurable?: boolean) => void };
  tempRegistry: { pathsFor: (id: string) => string[]; drain: (id: string) => void };
}) {
  const maintenance = new RecycleBinPurgeMaintenance();
  maintenance.add({
    userProfileId: 'test-profile',
    recycleBinManager: recycleBin,
    memoryManager: services.memoryManager,
    messManager: services.messManager,
    artifactManager: services.artifactManager,
    artifactTempRegistry: services.tempRegistry,
    draftManager: { clearSession: () => undefined },
    todoManager: { clearSession: () => undefined },
  } as any);
  return () => maintenance.start();
}

describe('per-session store lifecycle in recycle-bin handlers', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('returns after queueing and later purges one forgotten session at a time', async () => {
    const recycleBin = makeRecycleBin([
      { id: 'bin-1', sessionId: 's1' },
      { id: 'bin-2', sessionId: 's2' },
    ]);
    const memoryManager = { purgeSession: vi.fn() };
    const messManager = { onSessionClosed: vi.fn() };
    const artifactManager = { clearSession: vi.fn() };
    const tempRegistry = { pathsFor: vi.fn(() => []), drain: vi.fn() };
    setupRecycleBinHandlers(recycleBin as any, undefined, async id => recycleBin.peek(id) as any);
    const start = setupMaintenance(recycleBin, { memoryManager, messManager, artifactManager, tempRegistry });

    expect(await handlers.get('recycleBin:forget')!(null, 'bin-1')).toEqual({ ok: true });
    expect(memoryManager.purgeSession).not.toHaveBeenCalled();
    expect(recycleBin.pending).toHaveLength(1);

    start();
    await waitForQueue();
    expect(memoryManager.purgeSession).toHaveBeenCalledWith('s1');
    expect(messManager.onSessionClosed).toHaveBeenCalledWith('s1', 'forgotten');
    expect(artifactManager.clearSession).toHaveBeenCalledWith('s1', true);
    expect(recycleBin.pending).toHaveLength(0);

    await handlers.get('recycleBin:empty')!(null);
    await waitForQueue();
    expect(memoryManager.purgeSession).toHaveBeenCalledWith('s2');
    expect(recycleBin.pending).toHaveLength(0);

    await handlers.get('recycleBin:restore')!(null, 'bin-1');
    expect(memoryManager.purgeSession).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed session purge durable and skips retrying it in the same run', async () => {
    const recycleBin = makeRecycleBin([{ id: 'bin-1', sessionId: 's1' }]);
    const memoryManager = { purgeSession: vi.fn(() => { throw new Error('disk full'); }) };
    const messManager = { onSessionClosed: vi.fn() };
    const artifactManager = { clearSession: vi.fn() };
    const tempRegistry = { pathsFor: vi.fn(() => []), drain: vi.fn() };
    setupRecycleBinHandlers(recycleBin as any);
    const start = setupMaintenance(recycleBin, { memoryManager, messManager, artifactManager, tempRegistry });

    expect(await handlers.get('recycleBin:forget')!(null, 'bin-1')).toEqual({ ok: true });
    start();
    await waitForQueue();

    expect(recycleBin.pending).toHaveLength(1);
    expect(memoryManager.purgeSession).toHaveBeenCalledTimes(1);
    expect(messManager.onSessionClosed).not.toHaveBeenCalled();
  });

  it('retains a failed Mess cursor cleanup for the next startup', async () => {
    const recycleBin = makeRecycleBin([{ id: 'bin-1', sessionId: 's1' }]);
    const messManager = { onSessionClosed: vi.fn(() => { throw new Error('cursor store corrupt'); }) };
    const memoryManager = { purgeSession: vi.fn() };
    const artifactManager = { clearSession: vi.fn() };
    const tempRegistry = { pathsFor: vi.fn(() => []), drain: vi.fn() };
    setupRecycleBinHandlers(recycleBin as any);
    const start = setupMaintenance(recycleBin, { memoryManager, messManager, artifactManager, tempRegistry });

    expect(await handlers.get('recycleBin:forget')!(null, 'bin-1')).toEqual({ ok: true });
    start();
    await waitForQueue();
    expect(recycleBin.pending).toHaveLength(1);
    expect(messManager.onSessionClosed).toHaveBeenCalledTimes(1);
  });
});
