import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { setupRecycleBinHandlers } from '../src/electron/ipc/recycle-bin-handlers.js';

function makeRecycleBin(entries: Array<{ id: string; sessionId: string }>) {
  const recycleBin = new EventEmitter() as EventEmitter & {
    list: ReturnType<typeof vi.fn>;
    peek: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
    empty: ReturnType<typeof vi.fn>;
  };
  recycleBin.list = vi.fn(() => [...entries]);
  recycleBin.peek = vi.fn((id: string) => entries.find((entry) => entry.id === id) ?? null);
  recycleBin.forget = vi.fn();
  recycleBin.empty = vi.fn();
  return recycleBin;
}

describe('per-session store lifecycle in recycle-bin handlers', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('purges memory and the Mess cursor on forget, empty, and expiry while restore leaves them untouched', async () => {
    const entries = [
      { id: 'bin-1', sessionId: 's1' },
      { id: 'bin-2', sessionId: 's2' },
    ];
    const recycleBin = makeRecycleBin(entries);
    const memoryManager = { purgeSession: vi.fn() };
    const messManager = { onSessionClosed: vi.fn() };
    const artifactManager = { clearSession: vi.fn() };
    const tempRegistry = { drain: vi.fn() };
    setupRecycleBinHandlers(recycleBin as any, artifactManager as any, undefined, tempRegistry as any, memoryManager as any, messManager as any, undefined, async id => recycleBin.peek(id) as any);

    await handlers.get('recycleBin:forget')!(null, 'bin-1');
    expect(memoryManager.purgeSession).toHaveBeenCalledWith('s1');
    expect(messManager.onSessionClosed).toHaveBeenCalledWith('s1', 'forgotten');
    expect(artifactManager.clearSession).toHaveBeenCalledWith('s1');

    await handlers.get('recycleBin:empty')!(null);
    expect(memoryManager.purgeSession).toHaveBeenCalledWith('s1');
    expect(memoryManager.purgeSession).toHaveBeenCalledWith('s2');

    recycleBin.emit('recycle-bin:expired', [{ ...entries[0] }]);
    expect(messManager.onSessionClosed).toHaveBeenCalledWith('s1', 'expired');

    await handlers.get('recycleBin:restore')!(null, 'bin-1');
    expect(memoryManager.purgeSession).toHaveBeenCalledTimes(4);
    expect(messManager.onSessionClosed).toHaveBeenCalledTimes(4);
  });

  it('keeps destructive bin operations recoverable when memory purge fails', async () => {
    const entries = [{ id: 'bin-1', sessionId: 's1' }];
    const recycleBin = makeRecycleBin(entries);
    const memoryManager = { purgeSession: vi.fn(() => { throw new Error('disk full'); }) };
    const messManager = { onSessionClosed: vi.fn() };
    setupRecycleBinHandlers(recycleBin as any, { clearSession: vi.fn() } as any, undefined, { drain: vi.fn() } as any, memoryManager as any, messManager as any);

    expect(await handlers.get('recycleBin:forget')!(null, 'bin-1')).toBe(false);
    expect(recycleBin.forget).not.toHaveBeenCalled();
    expect(await handlers.get('recycleBin:empty')!(null)).toBe(false);
    expect(recycleBin.empty).not.toHaveBeenCalled();
    expect(() => recycleBin.emit('recycle-bin:expired', entries)).not.toThrow();
    // A gating failure stops before the cursor: the entry stays recoverable.
    expect(messManager.onSessionClosed).not.toHaveBeenCalled();
  });

  it('does not let a failed Mess cursor drop block a bin operation', async () => {
    const recycleBin = makeRecycleBin([{ id: 'bin-1', sessionId: 's1' }]);
    const messManager = { onSessionClosed: vi.fn(() => { throw new Error('cursor store corrupt'); }) };
    setupRecycleBinHandlers(recycleBin as any, { clearSession: vi.fn() } as any, undefined, { drain: vi.fn() } as any, { purgeSession: vi.fn() } as any, messManager as any);

    expect(await handlers.get('recycleBin:forget')!(null, 'bin-1')).toBe(true);
    expect(recycleBin.forget).toHaveBeenCalledWith('bin-1');
  });
});
