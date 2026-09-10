import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Function>();
const senderWindow = { id: 1, isDestroyed: () => false };

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)) },
  BrowserWindow: { fromWebContents: vi.fn(() => senderWindow) },
  shell: { openPath: vi.fn() },
}));

import { setupMemoryHandlers } from '../src/electron/ipc/memory-handlers.js';
import { MemoryManager } from '../src/session/memory-manager.js';

describe('memory renderer IPC handlers', () => {
  beforeEach(async () => {
    handlers.clear();
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow.fromWebContents).mockReset().mockReturnValue(senderWindow as any);
  });

  it('derives ownership from the sending window and returns summaries', async () => {
    const ids = ['m1', 'm2'];
    const manager = new MemoryManager({ persist: () => {}, idFactory: () => ids.shift()! });
    manager.createForSession('s1', { tldr: 'private', content: 'body' });
    manager.createForSession('s2', { tldr: 'other', content: 'secret' });
    const sessionManager = {
      getActiveSession: () => ({ id: 's1' }),
      getSession: (id: string) => (['s1', 's2'].includes(id) ? { id } : null),
    } as any;
    const windowManager = {
      getMainWindow: () => senderWindow,
      getSessionsInWindow: () => [],
    } as any;
    setupMemoryHandlers(manager, {} as any, sessionManager, windowManager, {} as any);

    const list = await handlers.get('memory:list')!({ sender: {} });
    expect(list).toEqual([{ id: 'm1', tldr: 'private', createdAt: expect.any(Number), updatedAt: expect.any(Number), attachmentCount: 0 }]);
    // No requested id: ownership still falls back to the active session, so
    // another session's memory stays invisible.
    expect(handlers.get('memory:get')!({ sender: {} }, 'm2')).toBeNull();
  });

  it('answers list for the explicitly requested session, not whatever is active now', async () => {
    const ids = ['a1', 'b1'];
    const manager = new MemoryManager({ persist: () => {}, idFactory: () => ids.shift()! });
    manager.createForSession('projectA', { tldr: 'alpha', content: 'A body' });
    manager.createForSession('projectB', { tldr: 'beta', content: 'B body' });
    // The user switched to A after the pane for B dispatched its request.
    const sessionManager = {
      getActiveSession: () => ({ id: 'projectA' }),
      getSession: (id: string) => (['projectA', 'projectB'].includes(id) ? { id } : null),
    } as any;
    const windowManager = { getMainWindow: () => senderWindow, getSessionsInWindow: () => [] } as any;
    setupMemoryHandlers(manager, {} as any, sessionManager, windowManager, {} as any);

    const list = await handlers.get('memory:list')!({ sender: {} }, 'projectB');
    expect(list.map((item: { tldr: string }) => item.tldr)).toEqual(['beta']);
  });

  it('answers graph-all for the explicitly requested session', async () => {
    const ids = ['a1', 'b1'];
    const manager = new MemoryManager({ persist: () => {}, idFactory: () => ids.shift()! });
    manager.createForSession('projectA', { tldr: 'alpha', content: 'A body' });
    manager.createForSession('projectB', { tldr: 'beta', content: 'B body' });
    const sessionManager = {
      getActiveSession: () => ({ id: 'projectA' }),
      getSession: (id: string) => (['projectA', 'projectB'].includes(id) ? { id } : null),
    } as any;
    const windowManager = { getMainWindow: () => senderWindow, getSessionsInWindow: () => [] } as any;
    setupMemoryHandlers(manager, {} as any, sessionManager, windowManager, {} as any);

    const forest = await handlers.get('memory:graph-all')!({ sender: {} }, 'projectB');
    expect(forest.records.map((record: { id: string }) => record.id)).toEqual(['b1']);
  });

  it('refuses a requested session a pinned window does not own', async () => {
    const manager = new MemoryManager({ persist: () => {} });
    const sessionManager = {
      getActiveSession: () => ({ id: 'projectA' }),
      getSession: (id: string) => ({ id }),
    } as any;
    const windowManager = {
      getMainWindow: () => ({ id: 99 }),
      getSessionsInWindow: () => ['projectA'],
    } as any;
    setupMemoryHandlers(manager, {} as any, sessionManager, windowManager, {} as any);

    expect(() => handlers.get('memory:list')!({ sender: {} }, 'projectB')).toThrow(/owning session window/i);
    expect(handlers.get('memory:list')!({ sender: {} }, 'projectA')).toEqual([]);
  });

  it('rejects a child window that has no server-side session binding', async () => {
    const manager = new MemoryManager({ persist: () => {} });
    const sessionManager = { getActiveSession: () => ({ id: 's1' }) } as any;
    const windowManager = { getMainWindow: () => senderWindow, getSessionsInWindow: () => [] } as any;
    setupMemoryHandlers(manager, {} as any, sessionManager, windowManager, {} as any);
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ id: 2, isDestroyed: () => false } as any);

    expect(() => handlers.get('memory:list')!({ sender: {} })).toThrow(/owning session window/i);
  });
});
