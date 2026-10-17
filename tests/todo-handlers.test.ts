import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler); }) },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { TodoManager } = await import('../src/session/todo-manager.js');
const { setupTodoHandlers } = await import('../src/electron/ipc/todo-handlers.js');

describe('todo IPC handlers', () => {
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);
  let todos: InstanceType<typeof TodoManager>;

  beforeEach(() => {
    handlers.clear();
    const files = new Map<string, ReturnType<typeof todos.list>>();
    todos = new TodoManager({
      load: id => files.get(id) ?? null,
      save: (id, list) => { files.set(id, list); },
      remove: id => { files.delete(id); },
      list: () => [...files.keys()],
    }, () => 'todo-1', () => 123);
    setupTodoHandlers(todos, id => id === 'live' || id === 'binned');
  });

  it('reads a known session list for the read-only dock pane', () => {
    todos.add('live', 'Keep moving');
    expect(invoke('todo:list', 'live')).toMatchObject([{ id: 'todo-1', text: 'Keep moving', status: 'open' }]);
  });

  it('allows a recoverable binned session but refuses unknown ids', () => {
    expect(invoke('todo:list', 'binned')).toEqual([]);
    expect(() => invoke('todo:list', 'gone')).toThrow(/Session not found/);
    expect(() => invoke('todo:list', '')).toThrow(/sessionId is required/);
  });
});
