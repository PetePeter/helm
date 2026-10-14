/**
 * ScratchpadPane.vue + useScratchpad: the user's side of the per-session pad.
 *
 * The preload surface is faked, but what answers behind it is the real
 * ScratchpadManager (in-memory store), so stale-write refusals, the size cap
 * and the change events are the production ones.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { Scratchpad } from '../../../src/types/scratchpad.js';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ScratchpadManager } = await import('../../../src/session/scratchpad-manager.js');
const { SCRATCHPAD_MAX_BYTES } = await import('../../../src/types/scratchpad.js');
const { SCRATCHPAD_SAVE_DELAY_MS } = await import('../../../renderer/composables/useScratchpad.js');

describe('ScratchpadPane.vue', () => {
  let main: InstanceType<typeof ScratchpadManager>;
  let wrapper: VueWrapper | null;
  /** Lets a test hold the user's save "on the wire" while something else happens in main. */
  let holdSaves: Promise<void> | null;
  let ScratchpadPane: typeof import('../../../renderer/components/dock/ScratchpadPane.vue').default;
  let setActiveSessionId: typeof import('../../../renderer/stores/app.js').setActiveSessionId;

  beforeEach(async () => {
    // A fresh renderer per test: typing parked behind an open conflict lives for the window's lifetime.
    vi.resetModules();
    ({ default: ScratchpadPane } = await import('../../../renderer/components/dock/ScratchpadPane.vue'));
    ({ setActiveSessionId } = await import('../../../renderer/stores/app.js'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const files = new Map<string, Scratchpad>();
    main = new ScratchpadManager({
      load: id => files.get(id) ?? null,
      save: pad => { files.set(pad.sessionId, pad); },
      remove: id => { files.delete(id); },
      list: () => [...files.keys()],
    });
    holdSaves = null;
    wrapper = null;
    (window as unknown as { helm: unknown }).helm = {
      sessions: {
        scratchpadGet: async (sessionId: string) => main.get(sessionId),
        scratchpadSet: async (sessionId: string, text: string, baseRevision: number) => {
          await holdSaves;
          return main.set(sessionId, text, 'user', baseRevision);
        },
      },
      events: {
        onScratchpadChanged: (callback: (pad: Scratchpad) => void) => {
          main.on('scratchpad:changed', callback);
          return () => main.off('scratchpad:changed', callback);
        },
      },
      time: { timeActivity: vi.fn() },
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    setActiveSessionId(null);
    vi.useRealTimers();
  });

  async function open(sessionId: string | null = 's1') {
    setActiveSessionId(sessionId);
    wrapper = mount(ScratchpadPane, { global: { plugins: [createPinia()] }, attachTo: document.body });
    await flushPromises();
    return wrapper;
  }

  const input = () => wrapper!.find('textarea').element as HTMLTextAreaElement;

  async function type(text: string) {
    await wrapper!.find('textarea').setValue(text);
  }

  async function pause() {
    vi.advanceTimersByTime(SCRATCHPAD_SAVE_DELAY_MS);
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

    await wrapper!.find('[data-scratchpad-keep-mine]').trigger('click');
    await flushPromises();
    expect(main.get('s1')).toMatchObject({ text: 'base + my half-typed thought', updatedBy: 'user' });
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  });

  it('"Take theirs" drops the unsaved text for the other edit', async () => {
    await open();
    await type('mine');
    main.set('s1', 'theirs', 'ai', 0);
    await flushPromises();

    await wrapper!.find('[data-scratchpad-take-theirs]').trigger('click');
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

    await wrapper!.find('[data-scratchpad-keep-mine]').trigger('click');
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
    const big = 'x'.repeat(SCRATCHPAD_MAX_BYTES + 1);
    await type(big);
    setActiveSessionId('s2'); // before the pause is over
    await flushPromises();
    expect(input().value).toBe('');
    expect(wrapper!.find('.scratchpad-pane__error').exists()).toBe(false);

    wrapper!.unmount();
    await open('s1');
    expect(input().value).toBe(big);
    expect(wrapper!.find('.scratchpad-pane__error').text()).toContain(String(SCRATCHPAD_MAX_BYTES));
    expect(wrapper!.find('[data-scratchpad-keep-mine]').exists()).toBe(false); // nobody else changed it
    expect(main.get('s1').text).toBe('keep');

    await type('short enough now');
    await pause();
    expect(main.get('s1').text).toBe('short enough now');
    expect(wrapper!.find('.scratchpad-pane__error').exists()).toBe(false);
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
    const big = 'x'.repeat(SCRATCHPAD_MAX_BYTES + 1);
    await type(big);
    await pause();

    expect(main.get('s1').text).toBe('keep');
    expect(wrapper!.find('.scratchpad-pane__error').text()).toContain(String(SCRATCHPAD_MAX_BYTES));
    expect(wrapper!.find('.scratchpad-pane__size').classes()).toContain('is-over');
    expect(input().value).toBe(big);
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
