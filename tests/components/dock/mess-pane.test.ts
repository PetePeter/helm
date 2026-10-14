/** @vitest-environment jsdom */
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessPane from '../../../renderer/components/dock/MessPane.vue';
import { appState } from '../../../renderer/stores/app.js';
import type { MessHistoryEntry } from '../../../src/session/mess-manager.js';

// The main process decorates every entry with the target's cursor state; the
// pane renders that and never re-derives it.
const entry: MessHistoryEntry = {
  id: 'e1', projectId: 'p1', seq: 1, fromSessionId: 's1', fromLabelSnapshot: 'old planner',
  toSessionId: 's2', toLabelSnapshot: 'old memories', text: 'coordinate this', createdAt: 1_700_000_000_000,
  targetUnread: true,
};

describe('MessPane', () => {
  let history: ReturnType<typeof vi.fn>;
  let appendListener: ((event: { projectId: string; entry: MessHistoryEntry }) => void) | undefined;

  beforeEach(() => {
    appState.sessions = [
      { id: 's1', name: 'Planner', projectId: 'p1' },
      { id: 's2', name: 'Memories', projectId: 'p1' },
      { id: 's3', name: 'Other', projectId: 'p2' },
    ] as any;
    appState.projects = [
      { id: 'p1', name: 'Hub', canonicalPath: 'X:/hub', alternatePaths: [] },
      { id: 'p2', name: 'Other', canonicalPath: 'X:/other', alternatePaths: [] },
    ];
    appState.activeSessionId = 's1';
    appState.sessionActivityLevels = new Map([['s2', 'active']]);
    appendListener = undefined;
    history = vi.fn().mockResolvedValue({ entries: [entry], hasMore: false });
    (window as any).helm = {
      mess: {
        messHistory: history,
        onMessAppended: (listener: typeof appendListener) => {
          appendListener = listener;
          return () => { appendListener = undefined; };
        },
      },
    };
  });

  it('follows project identity, keeps same-project switches stable, and renders read-only rows', async () => {
    const wrapper = mount(MessPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(history).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Planner');
    expect(wrapper.text()).toContain('Memories');
    expect(wrapper.text()).toContain('not picked up');
    expect(wrapper.find('textarea').exists()).toBe(false);

    appState.activeSessionId = 's2';
    await flushPromises();
    expect(history).toHaveBeenCalledTimes(1);

    appState.activeSessionId = 's3';
    await flushPromises();
    expect(history).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('accepts only appends for the displayed project and updates live labels', async () => {
    const wrapper = mount(MessPane, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(appendListener).toBeTypeOf('function');

    appendListener!({ projectId: 'p2', entry: { ...entry, id: 'wrong', projectId: 'p2' } });
    expect(wrapper.text()).not.toContain('wrong');
    appendListener!({ projectId: 'p1', entry: { ...entry, id: 'new', text: 'new message' } });
    await flushPromises();
    expect(wrapper.text()).toContain('new message');

    appState.sessions = [{ id: 's1', name: 'Renamed planner', projectId: 'p1' }] as any;
    await flushPromises();
    expect(wrapper.text()).toContain('Renamed planner');
    wrapper.unmount();
  });

  it('pages older rows by sequence and preserves a scrolled-up position', async () => {
    history
      .mockResolvedValueOnce({ entries: [{ ...entry, id: 'newer', seq: 2, text: 'newer' }], hasMore: true })
      .mockResolvedValueOnce({ entries: [{ ...entry, id: 'older', seq: 1, text: 'older' }], hasMore: false });
    const wrapper = mount(MessPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    const scroller = wrapper.find('.mess-history').element as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    scroller.scrollTop = 0;
    await wrapper.find('.mess-older').trigger('click');
    await flushPromises();

    expect(history).toHaveBeenNthCalledWith(1, 'p1', {});
    expect(history).toHaveBeenLastCalledWith('p1', { beforeSeq: 2 });
    expect(wrapper.text()).toContain('older');
    expect(wrapper.text()).toContain('newer');
    expect(scroller.scrollTop).toBe(0);
    wrapper.unmount();
  });
});
