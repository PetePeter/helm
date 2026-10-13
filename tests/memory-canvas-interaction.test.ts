/**
 * Canvas interaction: selection, panning, and the internal index.
 *
 * The canvas used to call setPointerCapture on every pointerdown and never
 * release it, so the browser retargeted the follow-up click to the canvas and
 * the node handlers never ran — panning silently ate selection.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useAppStore } from '../renderer/stores/app.js';
import MemoryScreen from '../renderer/components/panels/MemoryScreen.vue';
import {
  disposeMemoryChangedSubscription,
  memoryScreenState,
  selectMemory,
} from '../renderer/memories/memory-screen.js';

const FOREST = {
  records: [
    { id: 'a', tldr: 'Alpha', createdAt: 1, updatedAt: 1, attachmentCount: 0 },
    { id: 'b', tldr: 'Beta', createdAt: 2, updatedAt: 2, attachmentCount: 0 },
    { id: 'lonely', tldr: 'Lonely', createdAt: 3, updatedAt: 3, attachmentCount: 0 },
  ],
  edges: [{ fromId: 'a', toId: 'b' }],
};

const RECORDS: Record<string, unknown> = {
  a: { id: 'a', tldr: 'Alpha', content: 'alpha body', createdAt: 1, updatedAt: 1, attachments: [] },
  b: { id: 'b', tldr: 'Beta', content: 'beta body', createdAt: 2, updatedAt: 2, attachments: [] },
  lonely: { id: 'lonely', tldr: 'Lonely', content: 'lonely body', createdAt: 3, updatedAt: 3, attachments: [] },
};

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    memoryList: vi.fn(async () => FOREST.records),
    memoryGraphAll: vi.fn(async () => FOREST),
    memoryGet: vi.fn(async (id: string) => RECORDS[id] ?? null),
    memoryGraph: vi.fn(async () => ({ rootId: 'a', graphDepth: 0, entries: [] })),
    memorySearch: vi.fn(async () => ({ query: '', regex: false, matched: 0, hits: [] })),
    onMemoryChanged: vi.fn(() => vi.fn()),
    ...overrides,
  };
  window.gamepadCli = api as never;
  return api;
}

async function mountScreen() {
  useAppStore().setActiveSessionId('s1');
  const wrapper = mount(MemoryScreen, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('memory canvas interaction', () => {
  beforeEach(() => {
    disposeMemoryChangedSubscription();
    memoryScreenState.selectedId = null;
    memoryScreenState.detail = null;
    memoryScreenState.forest = null;
    memoryScreenState.searchQuery = '';
    document.body.innerHTML = '';
  });

  it('draws every memory including unlinked ones', async () => {
    installApi();
    const wrapper = await mountScreen();

    expect(wrapper.findAll('.memory-graph-node')).toHaveLength(3);
    wrapper.unmount();
  });

  it('shows no memory list', async () => {
    installApi();
    const wrapper = await mountScreen();

    expect(wrapper.find('.memory-list').exists()).toBe(false);
    wrapper.unmount();
  });

  // `trigger` cannot set clientX on a synthetic pointer event, and the drag
  // threshold is entirely about coordinates, so dispatch real events.
  function pointer(el: Element, type: string, clientX: number, clientY: number): void {
    const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    el.dispatchEvent(event);
  }

  // The regression: a click with no pointer movement must select.
  it('selects a node on click', async () => {
    installApi();
    const wrapper = await mountScreen();
    const node = wrapper.findAll('.memory-graph-node')[0].element;

    pointer(node, 'pointerdown', 10, 10);
    pointer(node, 'pointerup', 10, 10);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(memoryScreenState.selectedId).toBeTruthy();
    wrapper.unmount();
  });

  it('pans without selecting when the pointer is dragged', async () => {
    installApi();
    const wrapper = await mountScreen();
    const canvas = wrapper.find('.memory-graph-canvas').element;

    pointer(canvas, 'pointerdown', 10, 10);
    pointer(canvas, 'pointermove', 120, 60);
    pointer(canvas, 'pointerup', 120, 60);
    await flushPromises();

    expect(memoryScreenState.selectedId).toBeNull();
    wrapper.unmount();
  });

  it('draws directed edges with an arrowhead marker', async () => {
    installApi();
    const wrapper = await mountScreen();

    expect(wrapper.find('marker').exists()).toBe(true);
    expect(wrapper.find('.memory-graph-edge').attributes('marker-end')).toBeTruthy();
    wrapper.unmount();
  });

  it('fills an inline detail pane on selection', async () => {
    installApi();
    const wrapper = await mountScreen();

    await selectMemory('a');
    await flushPromises();

    expect(wrapper.find('.memory-detail-pane').text()).toContain('alpha body');
    wrapper.unmount();
  });

  // Selecting must not re-fetch the whole forest; the canvas would flicker and
  // every click would cost a full graph read.
  it('does not reload the forest when selecting', async () => {
    const api = installApi();
    const wrapper = await mountScreen();
    const loadsAfterMount = (api.memoryGraphAll as ReturnType<typeof vi.fn>).mock.calls.length;

    await selectMemory('b');
    await flushPromises();

    expect((api.memoryGraphAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsAfterMount);
    wrapper.unmount();
  });

  it('keeps an internal index that resolves ids not currently drawn', async () => {
    installApi();
    const wrapper = await mountScreen();

    expect(memoryScreenState.summaries.map((s) => s.id)).toEqual(['a', 'b', 'lonely']);
    wrapper.unmount();
  });

  it('highlights search matches on the canvas', async () => {
    installApi({
      memorySearch: vi.fn(async () => ({
        query: 'alpha',
        regex: false,
        matched: 1,
        hits: [{ id: 'a', tldr: RECORDS.a.tldr, score: 1, foreign: false }],
      })),
    });
    const wrapper = await mountScreen();
    memoryScreenState.searchQuery = 'alpha';

    const { searchMemories } = await import('../renderer/memories/memory-screen.js');
    await searchMemories();
    await flushPromises();

    expect(wrapper.find('.memory-graph-node.match').exists()).toBe(true);
    wrapper.unmount();
  });
});
