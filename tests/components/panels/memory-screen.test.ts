/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { useAppStore } from '../../../renderer/stores/app.js';
import MemoryScreen from '../../../renderer/components/panels/MemoryScreen.vue';
import {
  disposeMemoryChangedSubscription,
  memoryScreenState,
} from '../../../renderer/memories/memory-screen.js';

const summary = (id: string, tldr: string) => ({
  id,
  tldr,
  createdAt: 1,
  updatedAt: 2,
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
    memoryScreenState.traversal = null;
    memoryScreenState.forest = null;
    memoryScreenState.matchedIds = [];
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

    const loading = wrapper.find('.empty-state[role="status"]');
    expect(loading.exists()).toBe(true);
    expect(loading.attributes('aria-busy')).toBe('true');
    expect(loading.text()).toContain('Loading memories');
    wrapper.unmount();
  });

  it('renders EmptyState when the session has no memories', async () => {
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('.memory-graph-canvas .empty-state').exists()).toBe(true);
    expect(wrapper.find('.memory-graph-canvas .empty-state').text()).toContain('No memories for this session.');
    wrapper.unmount();
  });

  it('renders the match count after a search has run', async () => {
    memoryScreenState.searchQuery = 'memory';
    memoryScreenState.matchedIds = ['a', 'b', 'c'];
    const wrapper = mountScreen();
    await flushPromises();

    expect(wrapper.find('.memory-search-count').text()).toBe('3 match(es)');
    wrapper.unmount();
  });

  // Filtering hides non-matches (and links touching them) instead of fading
  // them, so a search reduces the picture rather than just recolouring it.
  it('hides non-matching memories and their links while filtering', async () => {
    const records = [summary('a', 'Alpha'), summary('b', 'Beta'), summary('c', 'Gamma')];
    const edges = [{ fromId: 'a', toId: 'b', type: 'related' }, { fromId: 'b', toId: 'c', type: 'related' }];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges });
    const wrapper = mountScreen();
    await flushPromises();
    expect(wrapper.findAll('.memory-graph-node')).toHaveLength(3);
    expect(wrapper.findAll('.memory-graph-edge')).toHaveLength(2);

    memoryScreenState.searchQuery = 'a';
    memoryScreenState.matchedIds = ['a', 'b'];
    await nextTick();
    expect(wrapper.findAll('.memory-graph-node')).toHaveLength(2);
    expect(wrapper.findAll('.memory-graph-edge')).toHaveLength(1);

    memoryScreenState.searchQuery = '';
    memoryScreenState.matchedIds = [];
    await nextTick();
    expect(wrapper.findAll('.memory-graph-node')).toHaveLength(3);
    expect(wrapper.findAll('.memory-graph-edge')).toHaveLength(2);
    wrapper.unmount();
  });

  it('moves the selected marker between canvas nodes', async () => {
    const records = [summary('first', 'First memory'), summary('second', 'Second memory')];
    window.helm.memory.memoryList = vi.fn().mockResolvedValue(records);
    window.helm.memory.memoryGraphAll = vi.fn().mockResolvedValue({ records, edges: [] });
    window.helm.memory.memoryGet = vi.fn().mockResolvedValue({
      id: 'first', tldr: 'First memory', content: '', createdAt: 1, updatedAt: 2, attachments: [],
    });

    const wrapper = mountScreen();
    await flushPromises();

    // Nothing is selected until the user picks a node — the canvas shows the
    // whole forest, so auto-selecting one would be arbitrary.
    expect(wrapper.findAll('.memory-graph-node.selected')).toHaveLength(0);

    await wrapper.findAll('.memory-graph-node')[1].trigger('click');
    await flushPromises();

    const selected = wrapper.findAll('.memory-graph-node.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].text()).toContain('Second memory');
    wrapper.unmount();
  });
});
