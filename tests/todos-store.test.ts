/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTodo, SessionTodosChanged } from '../src/types/todo.js';

type TodoListener = (change: SessionTodosChanged) => void;
let onChanged: TodoListener | null = null;
let loader: (sessionId: string) => Promise<SessionTodo[]> = async () => [];

beforeEach(() => {
  vi.resetModules();
  onChanged = null;
  loader = async () => [];
  (window as unknown as { helm: unknown }).helm = {
    sessions: { todoList: (id: string) => loader(id) },
    events: { onTodosChanged: (listener: TodoListener) => { onChanged = listener; return () => { onChanged = null; }; } },
  };
});

async function createStore() {
  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const { useTodosStore } = await import('../renderer/stores/todos.js');
  return useTodosStore();
}

describe('Todos store', () => {
  it('loads lists for visible local sessions and derives the sidebar count', async () => {
    const first: SessionTodo[] = [
      { id: '1', text: 'Done', status: 'done', createdAt: 1, doneAt: 2 },
      { id: '2', text: 'Open', status: 'open', createdAt: 3 },
    ];
    const asked: string[] = [];
    loader = async id => { asked.push(id); return id === 's1' ? first : []; };
    const store = await createStore();

    await store.loadSessions(['s1', 's2', 's1']);

    expect(asked.sort()).toEqual(['s1', 's2']);
    expect(store.todosFor('s1').map(todo => todo.id)).toEqual(['2', '1']);
    expect(store.countFor('s1')).toEqual({ done: 1, total: 2 });
    expect(store.countFor('s2')).toEqual({ done: 0, total: 0 });
  });

  it('applies live MCP changes and does not replace them with an older pending snapshot', async () => {
    let resolveLoad!: (todos: SessionTodo[]) => void;
    loader = () => new Promise(resolve => { resolveLoad = resolve; });
    const store = await createStore();
    const pending = store.loadSession('s1');
    await Promise.resolve();
    const current: SessionTodo[] = [{ id: 'new', text: 'New', status: 'open', createdAt: 2 }];
    onChanged?.({ sessionId: 's1', todos: current });
    resolveLoad([{ id: 'old', text: 'Old', status: 'open', createdAt: 1 }]);
    await pending;

    expect(store.todosFor('s1')).toEqual(current);
  });
});
