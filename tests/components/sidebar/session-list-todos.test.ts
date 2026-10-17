/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import type { SessionTodo } from '../../../src/types/todo.js';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';

describe('SessionList todo progress', () => {
  it('loads local session counts for the row and leaves peer rows empty', async () => {
    const asked: string[] = [];
    const todos: SessionTodo[] = [
      { id: 'done', text: 'Finished', status: 'done', createdAt: 1, doneAt: 2 },
      { id: 'open', text: 'Open', status: 'open', createdAt: 3 },
    ];
    (window as unknown as { helm: unknown }).helm = {
      sessions: { todoList: async (id: string) => { asked.push(id); return todos; } },
      events: { onTodosChanged: () => () => {} },
    };
    const cards: Array<{ todoCount: { done: number; total: number } }> = [];
    const CardStub = {
      props: ['session', 'todoCount'],
      setup(props: { todoCount: { done: number; total: number } }) { cards.push(props as typeof cards[number]); return {}; },
      template: '<div />',
    };
    const base = {
      hasSessions: true,
      groups: [{ dirPath: '/repo', displayName: '/repo', collapsed: false, sessions: [
        { id: 's1', name: 'one', cliType: 'claude-code' },
      ] }],
      directories: [],
      navIndexMap: new Map<string, number>(),
      activeFocus: 'sessions',
      focusedNavItem: null,
      focusColumn: 0 as 0,
      activeSessionId: null,
      editingSessionId: null,
      sessionStates: new Map<string, string>(),
      sessionActivityLevels: new Map<string, string>(),
      artifactCounts: new Map<string, number>(),
      workingPlanLabels: new Map<string, string>(),
      workingPlanTooltips: new Map<string, string>(),
      pendingSchedules: new Map<string, string>(),
      snappedOutSessions: new Set<string>(),
      llmNotifications: new Map(),
      getCliDisplayName: (name: string) => name,
      resolveGroupDisplayName: (name: string) => name,
      isSessionHiddenFromOverview: () => false,
      sessionElapsedText: () => '',
      sessionShortcutMap: new Map<string, number>(),
    };
    const local = mount(SessionList, {
      props: base,
      global: { plugins: [createPinia()], stubs: { SessionGroup: { template: '<div><slot /></div>' }, SessionCard: CardStub } },
    });
    await flushPromises();
    expect(cards[0]?.todoCount).toEqual({ done: 1, total: 2 });
    expect(asked).toEqual(['s1']);
    local.unmount();

    const remote = mount(SessionList, {
      props: { ...base, source: 'peer' },
      global: { plugins: [createPinia()], stubs: { SessionGroup: { template: '<div><slot /></div>' }, SessionCard: CardStub } },
    });
    await flushPromises();
    expect(cards[1]?.todoCount).toEqual({ done: 0, total: 0 });
    expect(asked).toEqual(['s1']);
    remote.unmount();
  });
});
