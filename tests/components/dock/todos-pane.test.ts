/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { SessionTodo, SessionTodosChanged } from '../../../src/types/todo.js';

let onChanged: ((change: SessionTodosChanged) => void) | null = null;
let loaded: string[] = [];
let filterPreferences: Record<string, unknown> = {};
let filterPreferenceListener: ((change: { id: string; value: unknown }) => void) | null = null;
let TodosPane: typeof import('../../../renderer/components/dock/TodosPane.vue').default;
let setActiveSessionId: typeof import('../../../renderer/stores/app.js').setActiveSessionId;
let wrapper: VueWrapper | null = null;

beforeEach(async () => {
  vi.resetModules();
  onChanged = null;
  loaded = [];
  filterPreferences = {};
  filterPreferenceListener = null;
  const lists: Record<string, SessionTodo[]> = {
    s1: [
      { id: 'done', text: 'Finished task', status: 'done', createdAt: 1, doneAt: 2 },
      { id: 'open', text: 'Open task', status: 'open', createdAt: 3 },
    ],
    s2: [{ id: 'next', text: 'Second session task', status: 'open', createdAt: 4 }],
  };
  (window as unknown as { helm: unknown }).helm = {
    sessions: { todoList: async (id: string) => { loaded.push(id); return lists[id] ?? []; } },
    config: {
      configGetFilterPreference: async (id: string) => filterPreferences[id],
      configSetFilterPreference: async (id: string, value: unknown) => { filterPreferences[id] = value; return { success: true }; },
      onFilterPreferenceChanged: (listener: (change: { id: string; value: unknown }) => void) => {
        filterPreferenceListener = listener;
        return () => { filterPreferenceListener = null; };
      },
    },
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
    expect(pane.findAll('.todos-pane__list button, input, textarea, select')).toHaveLength(0);
    expect(loaded).toEqual(['s1']);
  });

  it('cycles the Done chip through any, done only, and open only', async () => {
    const pane = await open();
    const chip = pane.find('.filter-chip');
    const texts = () => pane.findAll('.todos-pane__item').map(row => row.text());

    await chip.trigger('click');
    expect(texts()).toEqual(['Finished task']);
    await chip.trigger('click');
    expect(texts()).toEqual(['Open task']);
    await chip.trigger('click');
    expect(texts()).toEqual(['Open task', 'Finished task']);
  });

  it('stores its Done state under the shared stable preference ID', async () => {
    const pane = await open();
    await pane.find('.filter-chip').trigger('click');
    await flushPromises();

    expect(filterPreferences['todo.done']).toBe('yes');
  });

  it('persists the No state after cycling past Yes', async () => {
    const pane = await open();
    const chip = pane.find('.filter-chip');
    await chip.trigger('click');
    await chip.trigger('click');
    await flushPromises();

    expect(pane.find('.filter-chip__state').text()).toBe('No');
    expect(filterPreferences['todo.done']).toBe('no');
  });

  it('restores No from the persisted preference on a fresh renderer load', async () => {
    filterPreferences['todo.done'] = 'no';
    const pane = await open();

    expect(pane.find('.filter-chip__state').text()).toBe('No');
    expect(pane.findAll('.todos-pane__item').map(row => row.text())).toEqual(['Open task']);
  });

  it('updates the chip when another window changes the registered preference', async () => {
    const pane = await open();
    filterPreferenceListener?.({ id: 'todo.done', value: 'no' });
    await flushPromises();

    expect(pane.find('.filter-chip__state').text()).toBe('No');
    expect(pane.findAll('.todos-pane__item').map(row => row.text())).toEqual(['Open task']);
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
