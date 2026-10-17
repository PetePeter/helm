/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { SessionTodo, SessionTodosChanged } from '../../../src/types/todo.js';

let onChanged: ((change: SessionTodosChanged) => void) | null = null;
let loaded: string[] = [];
let TodosPane: typeof import('../../../renderer/components/dock/TodosPane.vue').default;
let setActiveSessionId: typeof import('../../../renderer/stores/app.js').setActiveSessionId;
let wrapper: VueWrapper | null = null;

beforeEach(async () => {
  vi.resetModules();
  onChanged = null;
  loaded = [];
  const lists: Record<string, SessionTodo[]> = {
    s1: [
      { id: 'done', text: 'Finished task', status: 'done', createdAt: 1, doneAt: 2 },
      { id: 'open', text: 'Open task', status: 'open', createdAt: 3 },
    ],
    s2: [{ id: 'next', text: 'Second session task', status: 'open', createdAt: 4 }],
  };
  (window as unknown as { helm: unknown }).helm = {
    sessions: { todoList: async (id: string) => { loaded.push(id); return lists[id] ?? []; } },
    events: { onTodosChanged: (listener: (change: SessionTodosChanged) => void) => { onChanged = listener; return () => { onChanged = null; }; } },
  };
  ({ default: TodosPane } = await import('../../../renderer/components/dock/TodosPane.vue'));
  ({ setActiveSessionId } = await import('../../../renderer/stores/app.js'));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  setActiveSessionId(null);
});

async function open(sessionId = 's1') {
  setActiveSessionId(sessionId);
  wrapper = mount(TodosPane, { global: { plugins: [createPinia()] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('TodosPane', () => {
  it('shows open items first, completed items struck through, and no editing controls', async () => {
    const pane = await open();
    const rows = pane.findAll('.todos-pane__item');

    expect(rows.map(row => row.text())).toEqual(['Open task', 'Finished task']);
    expect(rows[0]!.classes()).not.toContain('todos-pane__item--done');
    expect(rows[1]!.classes()).toContain('todos-pane__item--done');
    expect(pane.findAll('button, input, textarea, select')).toHaveLength(0);
    expect(loaded).toEqual(['s1']);
  });

  it('switches with the active session and reflects live MCP changes', async () => {
    const pane = await open();
    setActiveSessionId('s2');
    await flushPromises();
    expect(pane.text()).toContain('Second session task');

    onChanged?.({ sessionId: 's2', todos: [
      { id: 'new', text: 'Changed remotely', status: 'open', createdAt: 5 },
    ] });
    await flushPromises();
    expect(pane.text()).toContain('Changed remotely');
    expect(loaded).toEqual(['s1', 's2']);
  });
});
