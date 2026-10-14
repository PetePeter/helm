/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { useAppStore } from '../../../renderer/stores/app.js';
import MemoryScreen from '../../../renderer/components/panels/MemoryScreen.vue';
import {
  disposeMemoryChangedSubscription,
  memoryScreenState,
  setMemoryTimelineRange,
} from '../../../renderer/memories/memory-screen.js';

const summary = (id: string, tldr: string, createdAt = 1) => ({
  id,
  tldr,
  createdAt,
  updatedAt: createdAt + 1,
  attachmentCount: 0,
});

function mountScreen() {
  return mount(MemoryScreen, {
    global: {
      stubs: {
        ConfirmDialog: true,
        MemoryDetailPopOutWindow: true,
      },
    },
  });
}

describe('MemoryScreen shared-primitives anatomy', () => {
  beforeEach(() => {
    disposeMemoryChangedSubscription();
    const store = useAppStore();
    store.setActiveSessionId('session-1');
    memoryScreenState.summaries = [];
    memoryScreenState.searchQuery = '';
    memoryScreenState.selectedId = null;
    memoryScreenState.detail = null;
    memoryScreenState.forest = null;
    memoryScreenState.matchedIds = [];
    memoryScreenState.timelinePreset = '30d';
    memoryScreenState.timelineStart = null;
    memoryScreenState.timelineEnd = null;
    memoryScreenState.loading = false;
    window.helm = {
      memory: {
        memoryList: vi.fn().mockResolvedValue([]),
        memoryGet: vi.fn().mockResolvedValue(null),
        memoryGraph: vi.fn().mockResolvedValue({ rootId: '', graphDepth: 1, entries: [] }),
        memoryGraphAll: vi.fn().mockResolvedValue({ records: [], edges: [] }),
      },
      events: { onMemoryChanged: vi.fn(() => vi.fn()) },
    } as any;
  });

  it('renders the PanelHeader and SearchField DOM', async () => {
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('header.panel-header').exists()).toBe(true);
    expect(wrapper.find('.search-field input[type="search"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('renders the loading EmptyState affordance while memories load', async () => {
    window.helm.memory.memoryList = vi.fn(() => new Promise(() => {}));
    const wrapper = mountScreen();
    await nextTick();

    const loading = wrapper.find('.memory-list .empty-state[role="status"]');
    expect(loading.exists()).toBe(true);
    expect(loading.attributes('aria-busy')).toBe('true');
    expect(loading.text()).toContain('Loading memories');
    wrapper.unmount();
  });

  it('renders EmptyState when the session has no memories', async () => {
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('.memory-list .empty-state').exists()).toBe(true);
    expect(wrapper.find('.memory-list .empty-state').text()).toContain('No memories in this range.');
    wrapper.unmount();
  });

  it('shows the timeline list and keeps relationship data loaded internally', async () => {
    const records = [summary('older', 'Older memory', 1), summary('newest', 'Newest memory', 3)];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [{ fromId: 'older', toId: 'newest' }] });
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('.memory-timeline-card').exists()).toBe(true);
    expect(wrapper.find('.memory-graph-canvas').exists()).toBe(false);
    expect(window.helm.memory.memoryGraphAll).toHaveBeenCalledWith('session-1');
    expect(wrapper.findAll('.memory-row').map((row) => row.text())).toEqual([
      expect.stringContaining('Newest memory'),
      expect.stringContaining('Older memory'),
    ]);
    wrapper.unmount();
  });

  it('intersects text and date filters in the timeline list and histogram', async () => {
    const records = [
      summary('older', 'Older memory', 1),
      summary('middle', 'Middle memory', 2),
      summary('newest', 'Newest memory', 3),
    ];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [] });
    const wrapper = mountScreen();
    await flushPromises();

    memoryScreenState.searchQuery = 'memory';
    memoryScreenState.matchedIds = ['older', 'middle'];
    setMemoryTimelineRange(2, 3);
    await nextTick();

    expect(wrapper.findAll('.memory-row')).toHaveLength(1);
    expect(wrapper.find('.memory-row').text()).toContain('Middle memory');
    expect(wrapper.findAll('.memory-bar').reduce((sum, bar) => {
      const label = bar.attributes('aria-label') ?? '';
      return sum + (label.includes(': 1 memory') ? 1 : 0);
    }, 0)).toBe(1);
    wrapper.unmount();
  });

  it('adjusts the visible memories from the date slider and histogram', async () => {
    const day = 24 * 60 * 60 * 1000;
    const records = [
      summary('old', 'Old memory', 0),
      summary('middle', 'Middle memory', 20 * day),
      summary('newest', 'Newest memory', 40 * day),
    ];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [] });
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.findAll('.memory-row')).toHaveLength(2);
    await wrapper.find('input[aria-label="Start of visible date range"]').setValue(String(32 * day));
    await nextTick();
    expect(wrapper.findAll('.memory-row')).toHaveLength(1);
    expect(wrapper.find('.memory-row').text()).toContain('Newest memory');

    const allTime = wrapper.findAll('.memory-quick-ranges button').find((button) => button.text() === 'All time');
    await allTime!.trigger('click');
    await nextTick();
    expect(wrapper.findAll('.memory-row')).toHaveLength(3);

    await wrapper.findAll('.memory-bar').at(-1)!.trigger('click');
    await nextTick();
    expect(wrapper.findAll('.memory-row')).toHaveLength(1);
    expect(wrapper.find('.memory-row').text()).toContain('Newest memory');
    wrapper.unmount();
  });

  it('selects a memory from its list row and shows its detail', async () => {
    const records = [summary('first', 'First memory'), summary('second', 'Second memory', 3)];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [] });
    window.helm.memory.memoryGet = vi.fn().mockResolvedValue({
      id: 'second', tldr: 'Second memory', content: '', createdAt: 3, updatedAt: 4, attachments: [],
    });

    const wrapper = mountScreen();
    await flushPromises();
    await wrapper.findAll('.memory-row')[0].trigger('click');
    await flushPromises();

    expect(wrapper.find('.memory-row.selected').text()).toContain('Second memory');
    expect(wrapper.find('.memory-detail-title').text()).toBe('Second memory');
    wrapper.unmount();
  });

  it('renders the visible match count after a search has run', async () => {
    const records = [summary('a', 'Memory A'), summary('b', 'Memory B'), summary('c', 'Memory C')];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [] });
    memoryScreenState.searchQuery = 'memory';
    memoryScreenState.matchedIds = ['a', 'b'];
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('.memory-list-heading span').text()).toBe('2 in this range');
    wrapper.unmount();
  });

});
