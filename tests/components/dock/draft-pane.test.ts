/**
 * DraftPane.vue + useDraft: the user's side of the per-session pad.
 *
 * The preload surface is faked, but what answers behind it is the real
 * DraftManager (in-memory store), so stale-write refusals, the size cap
 * and the change events are the production ones.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { Draft, DraftSend } from '../../../src/types/draft.js';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DraftManager } = await import('../../../src/session/draft-manager.js');
const { DRAFT_MAX_BYTES } = await import('../../../src/types/draft.js');
const { DRAFT_SAVE_DELAY_MS } = await import('../../../renderer/composables/useDraft.js');

describe('DraftPane.vue', () => {
  let main: InstanceType<typeof DraftManager>;
  let wrapper: VueWrapper | null;
  /** Lets a test hold the user's save "on the wire" while something else happens in main. */
  let holdSaves: Promise<void> | null;
  /** What reached the session's PTY stdin. */
  let ptyWrites: Array<{ sessionId: string; data: string }>;
  let chatSends: Array<{ sessionId: string; text: string }>;
  let DraftPane: typeof import('../../../renderer/components/dock/DraftPane.vue').default;
  let setActiveSessionId: typeof import('../../../renderer/stores/app.js').setActiveSessionId;

  beforeEach(async () => {
    // A fresh renderer per test: typing parked behind an open conflict lives for the window's lifetime.
    vi.resetModules();
    ({ default: DraftPane } = await import('../../../renderer/components/dock/DraftPane.vue'));
    ({ setActiveSessionId } = await import('../../../renderer/stores/app.js'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const files = new Map<string, Draft>();
    const histories = new Map<string, DraftSend[]>();
    main = new DraftManager({
      load: id => files.get(id) ?? null,
      save: pad => { files.set(pad.sessionId, pad); },
      remove: id => { files.delete(id); },
      list: () => [...files.keys()],
      loadHistory: id => histories.get(id) ?? [],
      saveHistory: (id, entries) => { histories.set(id, entries); },
    });
    holdSaves = null;
    wrapper = null;
    (window as unknown as { helm: unknown }).helm = {
      sessions: {
        draftGet: async (sessionId: string) => main.get(sessionId),
        draftSet: async (sessionId: string, text: string, baseRevision: number) => {
          await holdSaves;
          return main.set(sessionId, text, 'user', baseRevision);
        },
        draftHistory: async (sessionId: string) => main.history(sessionId),
        draftRecordSend: async (sessionId: string, text: string, via: DraftSend['via']) => main.recordSend(sessionId, text, via),
      },
      events: {
        onDraftChanged: (callback: (pad: Draft) => void) => {
          main.on('draft:changed', callback);
          return () => main.off('draft:changed', callback);
        },
      },
      time: { timeActivity: vi.fn() },
      terminal: { ptyWrite: async (sessionId: string, data: string) => { ptyWrites.push({ sessionId, data }); } },
      chat: { chatSend: async (input: { sessionId: string; text: string }) => { chatSends.push(input); return { ok: true }; } },
    };
    ptyWrites = [];
    chatSends = [];
  });

  afterEach(() => {
    wrapper?.unmount();
    setActiveSessionId(null);
    vi.useRealTimers();
  });

  async function open(sessionId: string | null = 's1') {
    setActiveSessionId(sessionId);
    wrapper = mount(DraftPane, { global: { plugins: [createPinia()] }, attachTo: document.body });
    await flushPromises();
    return wrapper;
  }

  const input = () => wrapper!.find('textarea').element as HTMLTextAreaElement;

  async function type(text: string) {
    await wrapper!.find('textarea').setValue(text);
  }

  async function showDraft() {
    await wrapper!.find('.draft-pane__tabs button').trigger('click');
    await flushPromises();
  }

  async function showHistory() {
    await wrapper!.findAll('.draft-pane__tabs button')[1].trigger('click');
    await flushPromises();
  }

  async function pause() {
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    await flushPromises();
  }

  it('shows the active session\'s pad and swaps it when the session changes', async () => {
    main.set('s1', 'notes of one', 'user', 0);
    main.set('s2', 'notes of two', 'ai', 0);
    await open('s1');
    expect(input().value).toBe('notes of one');

    setActiveSessionId('s2');
    await flushPromises();
    expect(input().value).toBe('notes of two');
    expect(wrapper!.text()).toContain('Last edit by the AI');
  });

  it('saves what the user types after a pause, as the user', async () => {
    await open();
    await type('todo: ship');
    expect(main.get('s1').revision).toBe(0); // not on every keystroke
    await pause();
    expect(main.get('s1')).toMatchObject({ text: 'todo: ship', revision: 1, updatedBy: 'user' });
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper!.text()).toContain('Saved');
  });

  it('shows an AI edit as it lands and leaves the caret where it was', async () => {
    main.set('s1', 'first line', 'user', 0);
    await open();
    input().focus();
    input().setSelectionRange(5, 5);

    main.append('s1', 'added by the AI', 'ai');
    await flushPromises();

    expect(input().value).toBe('first line\nadded by the AI');
    expect([input().selectionStart, input().selectionEnd]).toEqual([5, 5]);
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  });

  it('overwrites neither side when the AI writes while the user has unsaved text', async () => {
    main.set('s1', 'base', 'user', 0);
    await open();
    await type('base + my half-typed thought');
    main.set('s1', 'base + AI rewrite', 'ai', 1);
    await pause();

    expect(input().value).toBe('base + my half-typed thought');
    expect(main.get('s1').text).toBe('base + AI rewrite');
    expect(wrapper!.find('[role="alert"]').text()).toContain('changed while you were typing');

    await wrapper!.find('[data-draft-keep-mine]').trigger('click');
    await flushPromises();
    expect(main.get('s1')).toMatchObject({ text: 'base + my half-typed thought', updatedBy: 'user' });
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  });

  it('"Take theirs" drops the unsaved text for the other edit', async () => {
    await open();
    await type('mine');
    main.set('s1', 'theirs', 'ai', 0);
    await flushPromises();

    await wrapper!.find('[data-draft-take-theirs]').trigger('click');
    await pause();
    expect(input().value).toBe('theirs');
    expect(main.get('s1')).toMatchObject({ text: 'theirs', updatedBy: 'ai' });
  });

  it('a save that reaches main after an AI edit is refused, not applied', async () => {
    main.set('s1', 'base', 'user', 0);
    await open();
    let release!: () => void;
    holdSaves = new Promise<void>((resolve) => { release = resolve; });
    await type('base, user edit');
    await pause(); // the save is now on the wire, based on revision 1
    main.append('s1', 'AI line', 'ai');
    release();
    await flushPromises();

    expect(main.get('s1').text).toBe('base\nAI line');
    expect(input().value).toBe('base, user edit');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(true);
  });

  it('a save queued behind a refused one does not write over the AI edit either', async () => {
    main.set('s1', 'base', 'user', 0);
    await open();
    let release!: () => void;
    holdSaves = new Promise<void>((resolve) => { release = resolve; });
    await type('base, first');
    await pause(); // save 1 on the wire, based on revision 1
    await type('base, first, second');
    await wrapper!.find('textarea').trigger('blur'); // save 2 queued behind it
    main.set('s1', 'AI rewrite', 'ai', 1);
    release();
    holdSaves = null;
    await flushPromises();
    await pause();

    expect(main.get('s1')).toMatchObject({ text: 'AI rewrite', updatedBy: 'ai' });
    expect(input().value).toBe('base, first, second');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(true);
  });

  it('keeps unresolved typing when the user leaves the session or closes the pane, and asks again', async () => {
    main.set('s1', 'base', 'user', 0);
    await open('s1');
    await type('base + mine');
    main.set('s1', 'base + theirs', 'ai', 1);
    await flushPromises();

    setActiveSessionId('s2');
    await flushPromises();
    expect(input().value).toBe('');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);

    setActiveSessionId('s1');
    await flushPromises();
    expect(input().value).toBe('base + mine');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(true);
    expect(main.get('s1').text).toBe('base + theirs');

    wrapper!.unmount(); // the pane is closed with the choice still open
    await flushPromises();
    await open('s1');
    expect(input().value).toBe('base + mine');

    await wrapper!.find('[data-draft-keep-mine]').trigger('click');
    await flushPromises();
    expect(main.get('s1').text).toBe('base + mine');

    wrapper!.unmount(); // resolved: nothing is offered again
    await open('s1');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows the conflict when the user is back on a session before its refused save returns', async () => {
    main.set('s1', 'base', 'user', 0);
    await open('s1');
    let release!: () => void;
    holdSaves = new Promise<void>((resolve) => { release = resolve; });
    await type('base + mine');
    setActiveSessionId('s2'); // the save for s1 leaves, and stays on the wire
    await flushPromises();
    setActiveSessionId('s1');
    await flushPromises();
    main.set('s1', 'base + theirs', 'ai', 1);
    release();
    holdSaves = null;
    await flushPromises();
    await pause();

    expect(main.get('s1').text).toBe('base + theirs');
    expect(input().value).toBe('base + mine');
    expect(wrapper!.find('[role="alert"]').exists()).toBe(true);
  });

  it('keeps an over-size pad that could not be saved when the user leaves and comes back', async () => {
    main.set('s1', 'keep', 'user', 0);
    await open('s1');
    const big = 'x'.repeat(DRAFT_MAX_BYTES + 1);
    await type(big);
    setActiveSessionId('s2'); // before the pause is over
    await flushPromises();
    expect(input().value).toBe('');
    expect(wrapper!.find('.draft-pane__error').exists()).toBe(false);

    wrapper!.unmount();
    await open('s1');
    expect(input().value).toBe(big);
    expect(wrapper!.find('.draft-pane__error').text()).toContain(String(DRAFT_MAX_BYTES));
    expect(wrapper!.find('[data-draft-keep-mine]').exists()).toBe(false); // nobody else changed it
    expect(main.get('s1').text).toBe('keep');

    await type('short enough now');
    await pause();
    expect(main.get('s1').text).toBe('short enough now');
    expect(wrapper!.find('.draft-pane__error').exists()).toBe(false);
  });

  it('does not mistake its own save for someone else\'s edit, and saves what was typed meanwhile', async () => {
    await open();
    let release!: () => void;
    holdSaves = new Promise<void>((resolve) => { release = resolve; });
    await type('one');
    await pause();
    await type('one two'); // typed while the first save is in flight
    release();
    holdSaves = null;
    await flushPromises();
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
    expect(input().value).toBe('one two');

    await pause();
    expect(main.get('s1')).toMatchObject({ text: 'one two', revision: 2 });
  });

  it('saves the pad being left when the session changes before the pause is over', async () => {
    await open('s1');
    await type('typed just before switching');
    setActiveSessionId('s2');
    await flushPromises();

    expect(main.get('s1').text).toBe('typed just before switching');
    expect(main.get('s2').text).toBe('');
    expect(input().value).toBe('');
  });

  it('saves on blur and when the pane goes away', async () => {
    await open();
    await type('blurred');
    await wrapper!.find('textarea').trigger('blur');
    await flushPromises();
    expect(main.get('s1').text).toBe('blurred');

    await type('closing');
    wrapper!.unmount();
    wrapper = null;
    await flushPromises();
    expect(main.get('s1').text).toBe('closing');
  });

  it('says why an over-size pad was not saved and keeps the typed text', async () => {
    main.set('s1', 'keep', 'user', 0);
    await open();
    const big = 'x'.repeat(DRAFT_MAX_BYTES + 1);
    await type(big);
    await pause();

    expect(main.get('s1').text).toBe('keep');
    expect(wrapper!.find('.draft-pane__error').text()).toContain(String(DRAFT_MAX_BYTES));
    expect(wrapper!.find('.draft-pane__size').classes()).toContain('is-over');
    expect(input().value).toBe(big);
  });

  describe('Send', () => {
    const sent = () => ptyWrites.filter(w => w.sessionId === 's1').map(w => w.data).join('');

    async function settle() {
      await vi.runAllTimersAsync();
      await flushPromises();
    }

    it('the Send button types the pad into the session\'s CLI, submits it and clears the pad', async () => {
      await open();
      await type('please review the diff');
      await wrapper!.find('[data-draft-send]').trigger('click');
      await settle();

      expect(sent()).toContain('please review the diff');
      expect(sent()).toMatch(/\r$/);
      expect(input().value).toBe('');
      await showHistory();
      expect(wrapper!.find('.draft-pane__history').text()).toContain('please review the diff');
      expect(main.get('s1').text).toBe('');
    });

    it('sends through Chat when the last prompt came from a phone', async () => {
      await open();
      const { useAppStore } = await import('../../../renderer/stores/app.js');
      useAppStore().state.sessions.push({
        id: 's1', name: 'Session 1', cliType: 'claude-code', processId: 1, lastUserPromptSource: 'phone',
      } as never);
      await type('continue from my phone');

      await wrapper!.find('[data-draft-send]').trigger('click');
      await settle();

      expect(chatSends).toHaveLength(1);
      expect(chatSends[0]).toMatchObject({ sessionId: 's1', text: 'continue from my phone' });
      expect(ptyWrites).toHaveLength(0);
      expect(input().value).toBe('');
      await showHistory();
      expect(wrapper!.find('.draft-pane__history').text()).toContain('via Chat');
    });

    it('sends through Chat when the last prompt came from desktop Chat', async () => {
      await open();
      const { useAppStore } = await import('../../../renderer/stores/app.js');
      useAppStore().state.sessions.push({
        id: 's1', name: 'Session 1', cliType: 'claude-code', processId: 1, lastUserPromptSource: 'chat',
      } as never);
      await type('continue in Chat');

      await wrapper!.find('[data-draft-send]').trigger('click');
      await settle();

      expect(chatSends).toHaveLength(1);
      expect(chatSends[0]).toMatchObject({ sessionId: 's1', text: 'continue in Chat' });
      expect(ptyWrites).toHaveLength(0);
      await showDraft();
      expect(input().value).toBe('');
    });

    it('does not record a failed Chat send or clear its draft', async () => {
      await open();
      const { useAppStore } = await import('../../../renderer/stores/app.js');
      useAppStore().state.sessions.push({
        id: 's1', name: 'Session 1', cliType: 'claude-code', processId: 1, lastUserPromptSource: 'chat',
      } as never);
      (window as unknown as { helm: { chat: { chatSend: () => Promise<{ ok: boolean }> } } }).helm.chat.chatSend =
        async () => ({ ok: false });
      await type('keep this');
      await wrapper!.find('[data-draft-send]').trigger('click');
      await settle();
      expect(main.history('s1')).toEqual([]);
      expect(input().value).toBe('keep this');
    });

    it('loads each session history independently and copying does not change the draft', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      main.recordSend('s1', '<b>earlier</b>', 'cli');
      main.recordSend('s2', 'other session', 'chat');
      main.set('s1', 'current draft', 'user', 0);
      await open('s1');
      await wrapper!.find('.draft-pane__tabs button:last-child').trigger('click');
      expect(wrapper!.find('.draft-pane__history').text()).toContain('<b>earlier</b>');
      expect(wrapper!.find('.draft-pane__history b').exists()).toBe(false);
      await wrapper!.find('.draft-pane__entry button').trigger('click');
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith('<b>earlier</b>');
      expect(main.get('s1').text).toBe('current draft');
      setActiveSessionId('s2');
      await flushPromises();
      await wrapper!.find('.draft-pane__tabs button:last-child').trigger('click');
      expect(wrapper!.find('.draft-pane__history').text()).toContain('other session');
      expect(wrapper!.find('.draft-pane__entry').text()).not.toContain('<b>earlier</b>');
      setActiveSessionId('s1');
      await flushPromises();
      await showDraft();
      expect(input().value).toBe('current draft');
    });

    it('Ctrl+Enter sends; a plain Enter is just a new line', async () => {
      await open();
      await type('line one');
      await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
      await settle();
      expect(ptyWrites).toHaveLength(0);

      await wrapper!.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
      await settle();
      expect(sent()).toContain('line one');
      await showDraft();
      expect(input().value).toBe('');
    });

    it('an empty pad sends nothing', async () => {
      await open();
      await type('   ');
      await wrapper!.find('[data-draft-send]').trigger('click');
      await settle();
      expect(ptyWrites).toHaveLength(0);
      expect(input().value).toBe('   ');
    });

    it('a frozen session refuses the send silently and keeps the pad', async () => {
      await open();
      const { useAppStore } = await import('../../../renderer/stores/app.js');
      useAppStore().state.sessions.push({ id: 's1', name: 's1', cliType: 'claude-code', processId: 1, frozen: true } as never);
      await type('hold this thought');
      await wrapper!.find('[data-draft-send]').trigger('click');
      await wrapper!.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
      await settle();

      expect(ptyWrites).toHaveLength(0);
      expect(input().value).toBe('hold this thought');
      expect(main.get('s1').text).toBe('hold this thought');
    });
  });

  it('keeps AI-written markup as text in the editor, never as elements', async () => {
    main.set('s1', '<img src=x onerror=alert(1)><b>bold</b>', 'ai', 0);
    await open();
    expect(input().value).toBe('<img src=x onerror=alert(1)><b>bold</b>');
    expect(wrapper!.find('img').exists()).toBe(false);
    expect(wrapper!.find('b').exists()).toBe(false);
  });

  it('ignores another session\'s changes and shows nothing without a session', async () => {
    await open('s1');
    main.set('s2', 'not mine', 'ai', 0);
    await flushPromises();
    expect(input().value).toBe('');

    setActiveSessionId(null);
    await flushPromises();
    expect(wrapper!.find('textarea').exists()).toBe(false);
    expect(wrapper!.text()).toContain('No session selected');
  });
});
