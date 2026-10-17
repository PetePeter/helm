/** @vitest-environment jsdom */

import { createPinia } from 'pinia';
import { markRaw } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatJournalEntry } from '../../../src/mobile/mobile-chat-journal.js';
import ChatPane from '../../../renderer/components/dock/ChatPane.vue';
import DockPane from '../../../renderer/components/dock/DockPane.vue';
import { appState } from '../../../renderer/stores/app.js';
import { contextMenu, pasteChatContextMenuText } from '../../../renderer/stores/modal-bridge.js';

describe('ChatPane', () => {
  let wrapper: VueWrapper | null;
  let history: ReturnType<typeof vi.fn>;
  let scrollToDescriptor: PropertyDescriptor | undefined;
  let innerHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    wrapper = null;
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    contextMenu.visible = false;
    contextMenu.mode = 'terminal';
    contextMenu.selectedText = '';
    contextMenu.hasSelection = false;
    contextMenu.sourceSessionId = '';
    contextMenu.position = null;
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
    contextMenu.visible = false;
    window.getSelection()?.removeAllRanges();
    appState.activeSessionId = null;
    appState.sessions = [];
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
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

  it('focuses the composer when the Chat pane receives dock focus', async () => {
    wrapper = mount(DockPane, {
      attachTo: document.body,
      props: { paneId: 'chat', active: true, focused: false, focusRequestId: 0, component: markRaw(ChatPane) },
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.setProps({ focused: true });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('.chat-pane__input').element);

    const outside = document.body.appendChild(document.createElement('input'));
    try {
      outside.focus();
      await wrapper.setProps({ focusRequestId: 1 });
      await flushPromises();
      expect(document.activeElement).toBe(wrapper.get('.chat-pane__input').element);
    } finally {
      outside.remove();
    }
  });

  it('refocuses the composer on session changes only while the Chat pane is active', async () => {
    const outside = document.body.appendChild(document.createElement('input'));
    try {
      outside.focus();
      wrapper = mount(DockPane, {
        attachTo: document.body,
        props: { paneId: 'chat', active: false, focused: false, focusRequestId: 0, component: markRaw(ChatPane) },
        global: { plugins: [createPinia()] },
      });
      await flushPromises();

      outside.focus();
      appState.activeSessionId = 'two';
      await flushPromises();
      expect(document.activeElement).toBe(outside);

      await wrapper.setProps({ active: true });
      outside.focus();
      appState.activeSessionId = 'one';
      await flushPromises();
      expect(document.activeElement).toBe(wrapper.get('.chat-pane__input').element);
    } finally {
      outside.remove();
    }
  });

  it('opens the shared chat context menu when right-clicking a message body', async () => {
    wrapper = mount(ChatPane, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    const messageBody = wrapper.get('.chat-pane__text').element;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(messageBody);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 31, clientY: 47 });
    messageBody.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(contextMenu.visible).toBe(true);
    expect(contextMenu.mode).toBe('chat');
    expect(contextMenu.sourceSessionId).toBe('one');
    expect(contextMenu.selectedText).toBe('first thread');
    expect(contextMenu.hasSelection).toBe(true);
    expect(contextMenu.position).toEqual({ x: 31, y: 47 });
  });

  it('opens the shared chat context menu when right-clicking the composer selection', async () => {
    wrapper = mount(ChatPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    const composer = wrapper.get('.chat-pane__input');
    await composer.setValue('draft text');
    (composer.element as HTMLTextAreaElement).setSelectionRange(0, 5);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 53, clientY: 71 });
    composer.element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(contextMenu.visible).toBe(true);
    expect(contextMenu.mode).toBe('chat');
    expect(contextMenu.sourceSessionId).toBe('one');
    expect(contextMenu.selectedText).toBe('draft');
    expect(contextMenu.hasSelection).toBe(true);
    expect(contextMenu.position).toEqual({ x: 53, y: 71 });
  });

  it('pastes clipboard text into the composer at its captured selection', async () => {
    wrapper = mount(ChatPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    const composer = wrapper.get('.chat-pane__input');
    const input = composer.element as HTMLTextAreaElement;
    await composer.setValue('draft text');
    input.setSelectionRange(0, 6);
    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 53, clientY: 71 }));

    pasteChatContextMenuText('pasted ');
    await flushPromises();

    expect(input.value).toBe('pasted text');
    expect(input.selectionStart).toBe(7);
    expect(input.selectionEnd).toBe(7);
  });

  it('grows and shrinks the composer at its 30vh limit and resets after sending', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    wrapper = mount(ChatPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    const composer = wrapper.get('.chat-pane__input');
    const input = composer.element as HTMLTextAreaElement;
    let measuredHeight = 64;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => measuredHeight });

    await composer.setValue('two\nlines');
    expect(input.style.height).toBe('64px');

    measuredHeight = 480;
    await composer.setValue('many\nlines\nnow');
    expect(input.style.height).toBe('300px');
    expect(input.style.overflowY).toBe('auto');

    measuredHeight = 44;
    await composer.setValue('short');
    expect(input.style.height).toBe('44px');
    expect(input.style.overflowY).toBe('hidden');

    measuredHeight = 40;
    const sendEvent = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(sendEvent);
    await flushPromises();
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.style.height).toBe('40px');
  });

  it('leaves plain Enter for a newline and sends on Ctrl+Enter', async () => {
    wrapper = mount(ChatPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    const composer = wrapper.get('.chat-pane__input');
    await composer.setValue('send this');
    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    composer.element.dispatchEvent(plainEnter);
    expect(plainEnter.defaultPrevented).toBe(false);
    expect((composer.element as HTMLTextAreaElement).value).toBe('send this');

    const ctrlEnter = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    composer.element.dispatchEvent(ctrlEnter);
    await flushPromises();
    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect((composer.element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.findAll('.chat-pane__text').map(node => node.text())).toContain('send this');
  });
});
