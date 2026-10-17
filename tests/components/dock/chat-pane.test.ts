/** @vitest-environment jsdom */

import { createPinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatJournalEntry } from '../../../src/mobile/mobile-chat-journal.js';
import ChatPane from '../../../renderer/components/dock/ChatPane.vue';
import { appState } from '../../../renderer/stores/app.js';

describe('ChatPane', () => {
  let wrapper: VueWrapper | null;
  let history: ReturnType<typeof vi.fn>;
  let scrollToDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    wrapper = null;
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    appState.sessions = [
      { id: 'one', name: 'First', cliType: 'codex', processId: 1 },
      { id: 'two', name: 'Second', cliType: 'claude', processId: 2 },
      { id: 'agent', name: 'Subagent', cliType: 'codex', processId: 3, subagentOf: 'one' },
    ];
    appState.activeSessionId = 'one';

    const entries = new Map<string, ChatJournalEntry[]>([
      ['one', [{ seq: 1, record: { sessionId: 'one', sessionName: 'First', text: 'first thread', at: 1_700_000_000_000 } }]],
      ['two', [{ seq: 2, record: { sessionId: 'two', sessionName: 'Second', text: 'second thread', at: 1_700_000_001_000 } }]],
    ]);
    const listeners = new Set<(entry: ChatJournalEntry) => void>();
    history = vi.fn(async (sessionId: string) => entries.get(sessionId) ?? []);
    (window as unknown as { helm: unknown }).helm = {
      chat: {
        chatHistory: history,
        chatSend: async () => ({ ok: true }),
        onChatEntry: (listener: (entry: ChatJournalEntry) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    appState.activeSessionId = null;
    appState.sessions = [];
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  });

  it('shows the active top-level session thread and follows active-session changes', async () => {
    wrapper = mount(ChatPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.get('.chat-pane__context-main strong').text()).toBe('First');
    expect(wrapper.get('.chat-pane__thread').text()).toContain('first thread');
    expect(history).not.toHaveBeenCalledWith('agent');

    appState.activeSessionId = 'two';
    await flushPromises();

    expect(wrapper.get('.chat-pane__context-main strong').text()).toBe('Second');
    expect(wrapper.get('.chat-pane__thread').text()).toContain('second thread');
    expect(wrapper.get('.chat-pane__thread').text()).not.toContain('first thread');

    appState.activeSessionId = 'agent';
    await flushPromises();

    expect(wrapper.find('.chat-pane__conversation').exists()).toBe(false);
    expect(wrapper.text()).toContain('Select a session from the sidebar to view its chat.');
  });
});
