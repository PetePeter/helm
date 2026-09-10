/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useAppStore } from '../renderer/stores/app.js';
import MemoryScreen from '../renderer/components/panels/MemoryScreen.vue';
import {
  disposeMemoryChangedSubscription,
  memoryScreenState,
  refreshMemories,
  resetMemoryChangedSubscriptionForTests,
  selectMemory,
} from '../renderer/memories/memory-screen.js';

describe('memory renderer state', () => {
  beforeEach(() => {
    resetMemoryChangedSubscriptionForTests();
    const store = useAppStore();
    store.setActiveSessionId(null);
    memoryScreenState.summaries = [];
    memoryScreenState.selectedId = null;
    memoryScreenState.detail = null;
    memoryScreenState.forest = null;
    memoryScreenState.detailVisible = false;
    memoryScreenState.loading = false;
    memoryScreenState.searchQuery = '';
    memoryScreenState.searchResults = [];
    memoryScreenState.matchedIds = [];
  });

  /** Empty project so a refresh resolves without clobbering the assertions. */
  function stubEmptyProject(): void {
    window.helm = {
      memory: {
        memoryList: vi.fn(async () => []),
        memoryGraphAll: vi.fn(async () => ({ records: [], edges: [] })),
      },
    } as any;
  }

  it('refreshes the mounted memory screen for the newly active session', async () => {
    const store = useAppStore();
    const loadedFor: string[] = [];
    window.gamepadCli = {
      memoryList: vi.fn(async () => {
        loadedFor.push(store.state.activeSessionId!);
        return [];
      }),
      onMemoryChanged: vi.fn(() => vi.fn()),
    } as any;
    store.setActiveSessionId('s1');
    const wrapper = mount(MemoryScreen, { shallow: true });
    await flushPromises();

    store.setActiveSessionId('s2');
    await flushPromises();

    expect(loadedFor).toEqual(['s1', 's2']);
    wrapper.unmount();
    disposeMemoryChangedSubscription();
  });

  it('clears session data when there is no active session', async () => {
    memoryScreenState.summaries = [{ id: 'old', tldr: 'old', createdAt: 1, updatedAt: 1, attachmentCount: 0 }];
    await refreshMemories();
    expect(memoryScreenState.summaries).toEqual([]);
  });

  it('drops a response that belongs to a session switched away from', async () => {
    const list = vi.fn(() => new Promise((resolve) => {
      window.setTimeout(() => resolve([{ id: 's1-memory', tldr: 'old session', createdAt: 1, updatedAt: 1, attachmentCount: 0 }]), 0);
    }));
    window.helm = { memory: { memoryList: list } } as any;
    const store = useAppStore();
    store.setActiveSessionId('s1');
    const pending = refreshMemories();
    store.setActiveSessionId('s2');
    await pending;
    expect(memoryScreenState.summaries).toEqual([]);
  });

  it('clears the previous project search results when the session switches', async () => {
    stubEmptyProject();
    const store = useAppStore();
    store.setActiveSessionId('projectA');
    await refreshMemories();
    memoryScreenState.searchQuery = 'alpha';
    memoryScreenState.searchResults = [{ rootId: 'a1', nodes: [], edges: [] }] as any;
    memoryScreenState.matchedIds = ['a1'];

    store.setActiveSessionId('projectB');
    await refreshMemories();

    expect(memoryScreenState.searchResults).toEqual([]);
    expect(memoryScreenState.matchedIds).toEqual([]);
    expect(memoryScreenState.searchQuery).toBe('');
  });

  it('clears a selection belonging to the session switched away from', async () => {
    stubEmptyProject();
    const store = useAppStore();
    store.setActiveSessionId('projectA');
    await refreshMemories();
    memoryScreenState.selectedId = 'a1';
    memoryScreenState.detail = { id: 'a1', tldr: 'alpha', content: 'A body', attachments: [] } as any;
    memoryScreenState.detailVisible = true;

    store.setActiveSessionId('projectB');
    await refreshMemories();

    expect(memoryScreenState.selectedId).toBeNull();
    expect(memoryScreenState.detail).toBeNull();
    expect(memoryScreenState.detailVisible).toBe(false);
  });

  it('drops an optimistic selection when the session changes mid-fetch', async () => {
    const store = useAppStore();
    window.helm = {
      memory: {
        memoryGet: vi.fn(() => new Promise((resolve) => {
          window.setTimeout(() => resolve({ id: 'a1', tldr: 'alpha', content: 'A body', attachments: [] }), 0);
        })),
      },
    } as any;
    store.setActiveSessionId('projectA');
    const pending = selectMemory('a1');
    store.setActiveSessionId('projectB');
    await pending;

    expect(memoryScreenState.selectedId).toBeNull();
    expect(memoryScreenState.detail).toBeNull();
  });

  it('keeps the memory-changed subscription alive while another screen is mounted', async () => {
    const store = useAppStore();
    const stop = vi.fn();
    let notify: ((event: { sessionId?: string }) => void) | undefined;
    const list = vi.fn(async () => []);
    window.helm = {
      memory: { memoryList: list, memoryGraphAll: vi.fn(async () => ({ records: [], edges: [] })) },
      events: {
        onMemoryChanged: vi.fn((handler: (event: { sessionId?: string }) => void) => {
          notify = handler;
          return stop;
        }),
      },
    } as any;
    store.setActiveSessionId('projectA');

    const dockPane = mount(MemoryScreen, { shallow: true });
    const popOut = mount(MemoryScreen, { shallow: true });
    await flushPromises();

    popOut.unmount();
    expect(stop).not.toHaveBeenCalled();

    const callsBefore = list.mock.calls.length;
    notify!({ sessionId: 'projectA' });
    await flushPromises();
    expect(list.mock.calls.length).toBeGreaterThan(callsBefore);

    dockPane.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
