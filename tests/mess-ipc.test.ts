import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Function>();
const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(() => [] as Array<{ isDestroyed: () => boolean; webContents: { send: Function } }>),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  },
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupMessHandlers } from '../src/electron/ipc/mess-handlers.js';

describe('Mess renderer IPC', () => {
  beforeEach(() => {
    handlers.clear();
    mockGetAllWindows.mockReset().mockReturnValue([]);
  });

  it('returns bounded, project-scoped history and leaves cursor ownership to agents', async () => {
    const historyForProject = vi.fn(() => ({ entries: [{ id: 'e1', projectId: 'p1' }], hasMore: false }));
    const manager = new EventEmitter() as EventEmitter & { historyForProject: typeof historyForProject };
    manager.historyForProject = historyForProject;
    const projects = { getById: vi.fn((id: string) => id === 'p1' ? { id } : undefined) } as any;
    setupMessHandlers(manager as any, projects, {
      getMainWindow: () => undefined,
      getAllWindows: () => [],
      getSessionsInWindow: () => [],
    } as any, { getActiveSession: () => undefined } as any);

    const result = await handlers.get('mess:history')!({}, 'p1', { sinceHours: 2, limit: 10 });

    expect(result.entries).toHaveLength(1);
    expect(historyForProject).toHaveBeenCalledWith('p1', { sinceHours: 2, limit: 10 });
    expect(projects.getById).toHaveBeenCalledWith('p1');
  });

  it('applies no time window when the renderer asks for a plain page', async () => {
    const historyForProject = vi.fn(() => ({ entries: [], hasMore: false }));
    const manager = new EventEmitter() as EventEmitter & { historyForProject: typeof historyForProject };
    manager.historyForProject = historyForProject;
    const projects = { getById: vi.fn(() => ({ id: 'p1' })) } as any;
    setupMessHandlers(manager as any, projects, {
      getMainWindow: () => undefined,
      getAllWindows: () => [],
      getSessionsInWindow: () => [],
    } as any, { getActiveSession: () => undefined } as any);

    await handlers.get('mess:history')!({}, 'p1');
    await handlers.get('mess:history')!({}, 'p1', { beforeSeq: 5 });

    expect(historyForProject).toHaveBeenNthCalledWith(1, 'p1', {});
    expect(historyForProject).toHaveBeenNthCalledWith(2, 'p1', { beforeSeq: 5 });
  });

  it('returns empty for an unknown project without touching Mess storage', async () => {
    const manager = new EventEmitter() as EventEmitter & { historyForProject: Function };
    manager.historyForProject = vi.fn();
    const projects = { getById: vi.fn(() => undefined) } as any;
    setupMessHandlers(manager as any, projects, {
      getMainWindow: () => undefined,
      getAllWindows: () => [],
      getSessionsInWindow: () => [],
    } as any, { getActiveSession: () => undefined } as any);

    expect(handlers.get('mess:history')!({}, 'unknown')).toEqual({ entries: [], hasMore: false });
    expect(manager.historyForProject).not.toHaveBeenCalled();
  });

  it('forwards append events with the project identity', () => {
    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }]);
    const manager = new EventEmitter() as EventEmitter & { getProjectIdForSession: Function };
    manager.getProjectIdForSession = () => 'p1';
    const main = { id: 1, isDestroyed: () => false, webContents: { send } };
    setupMessHandlers(manager as any, { getById: () => ({ id: 'p1' }) } as any, {
      getMainWindow: () => main,
      getAllWindows: () => [main],
      getSessionsInWindow: () => [],
    } as any, { getActiveSession: () => ({ id: 'active' }) } as any);
    const entry = { id: 'e1', projectId: 'p1', text: 'hello' };

    manager.emit('mess:appended', entry);

    expect(send).toHaveBeenCalledWith('mess:appended', { projectId: 'p1', entry: { ...entry, targetUnread: false } });
  });

  it('rejects invalid bounds before checking project existence', () => {
    const manager = new EventEmitter() as any;
    manager.historyForProject = vi.fn();
    const projects = { getById: vi.fn(() => undefined) } as any;
    setupMessHandlers(manager, projects, {
      getMainWindow: () => undefined,
      getAllWindows: () => [],
      getSessionsInWindow: () => [],
    } as any, { getActiveSession: () => undefined } as any);

    expect(() => handlers.get('mess:history')!({}, 'unknown', { limit: 501 })).toThrow(/limit/);
    expect(() => handlers.get('mess:history')!({}, 'unknown', { beforeSeq: 0 })).toThrow(/beforeSeq/);
    expect(projects.getById).not.toHaveBeenCalled();
  });

  it('routes appends to the active project and owned popout only, then disposes cleanly', () => {
    const sendMain = vi.fn();
    const sendChild = vi.fn();
    const main = { id: 1, isDestroyed: () => false, webContents: { send: sendMain } };
    const child = { id: 2, isDestroyed: () => false, webContents: { send: sendChild } };
    const manager = new EventEmitter() as any;
    manager.getProjectIdForSession = vi.fn((id: string) => id === 'child-session' ? 'p2' : 'p1');
    const projects = { getById: () => ({ id: 'p1' }) } as any;
    const windowManager = {
      getMainWindow: () => main,
      getAllWindows: () => [main, child],
      getSessionsInWindow: (id: number) => id === 2 ? ['child-session'] : [],
    };
    const sessionManager = { getActiveSession: () => ({ id: 'active' }) };
    const dispose = setupMessHandlers(manager, projects, windowManager as any, sessionManager as any);

    manager.emit('mess:appended', { projectId: 'p1', id: 'one' });
    expect(sendMain).toHaveBeenCalledTimes(1);
    expect(sendChild).not.toHaveBeenCalled();
    dispose();
    manager.emit('mess:appended', { projectId: 'p1', id: 'two' });
    expect(sendMain).toHaveBeenCalledTimes(1);
    expect(handlers.has('mess:history')).toBe(false);
  });
});
