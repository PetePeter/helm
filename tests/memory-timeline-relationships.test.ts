/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useAppStore } from '../renderer/stores/app.js';
import MemoryScreen from '../renderer/components/panels/MemoryScreen.vue';
import {
  disposeMemoryChangedSubscription,
  memoryScreenState,
} from '../renderer/memories/memory-screen.js';

const DAY = 24 * 60 * 60 * 1000;

function summary(id: string, tldr: string, createdAt: number) {
  return { id, tldr, createdAt, updatedAt: createdAt, attachmentCount: 0 };
}

function installApi(records: ReturnType<typeof summary>[], edges: Array<{ fromId: string; toId: string }> = []) {
  const api = {
    memoryList: vi.fn(async () => records),
    memoryGraphAll: vi.fn(async () => ({ records, edges })),
    memoryGet: vi.fn(async (id: string) => ({
      ...records.find((record) => record.id === id)!,
      content: `${id} body`,
      attachments: [],
    })),
    memorySearch: vi.fn(async () => ({ query: '', regex: false, matched: 0, hits: [] })),
    onMemoryChanged: vi.fn(() => vi.fn()),
  };
  window.helm = {
    memory: api,
    events: { onMemoryChanged: api.onMemoryChanged },
  } as never;
  return api;
}

async function mountScreen() {
  useAppStore().setActiveSessionId('s1');
  const wrapper = mount(MemoryScreen, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('memory list with internal graph relationships', () => {
  beforeEach(() => {
    disposeMemoryChangedSubscription();
    memoryScreenState.summaries = [];
    memoryScreenState.selectedId = null;
    memoryScreenState.detail = null;
    memoryScreenState.detailVisible = false;
    memoryScreenState.forest = null;
    memoryScreenState.searchQuery = '';
    memoryScreenState.matchedIds = [];
    memoryScreenState.timelinePreset = '30d';
    memoryScreenState.timelineStart = null;
    memoryScreenState.timelineEnd = null;
    document.body.innerHTML = '';
  });

  it('keeps the graph internal and shows neighbors in the detail list', async () => {
    const records = [summary('a', 'Alpha', 1), summary('b', 'Beta', 2), summary('lonely', 'Lonely', 3)];
    installApi(records, [{ fromId: 'a', toId: 'b' }]);
    const wrapper = await mountScreen();

    expect(wrapper.find('.memory-graph-canvas').exists()).toBe(false);
    expect(wrapper.findAll('.memory-row').map((row) => row.text())).toEqual([
      expect.stringContaining('Lonely'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Alpha'),
    ]);

    await wrapper.findAll('.memory-row')[2].trigger('click');
    await flushPromises();
    await wrapper.find('.memory-detail-actions button').trigger('click');
    await flushPromises();

    const popout = document.body.querySelector('.memory-detail-popout');
    expect(popout?.textContent).toContain('Beta');
    expect(popout?.textContent).toContain('outgoing');
    wrapper.unmount();
  });

  it('defaults to the newest 30 days of available history', async () => {
    const records = [summary('old', 'Old memory', 0), summary('recent', 'Recent memory', 40 * DAY)];
    installApi(records);
    const wrapper = await mountScreen();

    expect(memoryScreenState.timelinePreset).toBe('30d');
    expect(wrapper.findAll('.memory-row')).toHaveLength(1);
    expect(wrapper.find('.memory-row').text()).toContain('Recent memory');
    wrapper.unmount();
  });

  it('does not reload the relationship graph when a list item is selected', async () => {
    const api = installApi([summary('a', 'Alpha', 1)]);
    const wrapper = await mountScreen();
    const graphLoads = api.memoryGraphAll.mock.calls.length;

    await wrapper.find('.memory-row').trigger('click');
    await flushPromises();

    expect(api.memoryGraphAll).toHaveBeenCalledTimes(graphLoads);
    wrapper.unmount();
  });
});
