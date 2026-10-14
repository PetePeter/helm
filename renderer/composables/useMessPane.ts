import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import type { MessHistoryEntry } from '../../src/session/mess-manager.js';
import type { Session } from '../state.js';
import { messClient } from '../ipc/clients.js';
import { useAppStore } from '../stores/app.js';

export type MessFilterState = 'either' | 'yes' | 'no';

export interface MessFilters {
  senderId: string;
  broadcast: MessFilterState;
  unread: MessFilterState;
}

export function resolveMessLabel(sessionId: string | undefined, snapshot: string | undefined, sessions: readonly Session[]): string {
  if (!sessionId) return 'all';
  return sessions.find(session => session.id === sessionId)?.name ?? snapshot ?? sessionId;
}

/**
 * Whether the target AI has yet to pick a directed entry up.
 *
 * The main process decorates every entry from the target's ordered cursor — the
 * only authority on what was delivered. The renderer never guesses from session
 * activity: a busy session may already have read its mail, and an idle one may
 * not have. Absent decoration means unknown, and an unknown never claims a badge.
 */
export function isMessTargetUnread(entry: MessHistoryEntry): boolean {
  return Boolean(entry.toSessionId) && entry.targetUnread === true;
}

function matchesFilter(value: boolean, filter: MessFilterState): boolean {
  return filter === 'either' || value === (filter === 'yes');
}

export function filterMessEntries(entries: readonly MessHistoryEntry[], filters: MessFilters): MessHistoryEntry[] {
  return entries.filter(entry => {
    const senderMatches = !filters.senderId || entry.fromSessionId === filters.senderId;
    return senderMatches
      && matchesFilter(!entry.toSessionId, filters.broadcast)
      && matchesFilter(isMessTargetUnread(entry), filters.unread);
  });
}

export function useMessPane() {
  const appStore = useAppStore();
  const entries = ref<MessHistoryEntry[]>([]);
  const loading = ref(false);
  const scroller = ref<HTMLElement | null>(null);
  const filters = reactive<MessFilters>({ senderId: '', broadcast: 'either', unread: 'either' });
  let loadGeneration = 0;
  let stopAppend: (() => void) | undefined;

  const projectId = computed(() => {
    const id = appStore.activeSession?.projectId;
    return id && appStore.state.projects.some(project => project.id === id) ? id : null;
  });
  const projectName = computed(() => {
    const id = projectId.value;
    return id ? appStore.state.projects.find(project => project.id === id)?.name ?? id : null;
  });
  const senderOptions = computed(() => {
    const seen = new Set<string>();
    return entries.value
      .map(entry => ({ id: entry.fromSessionId, label: resolveMessLabel(entry.fromSessionId, entry.fromLabelSnapshot, appStore.state.sessions) }))
      .filter(option => {
        if (seen.has(option.id)) return false;
        seen.add(option.id);
        return true;
      });
  });
  const visibleEntries = computed(() => filterMessEntries(entries.value, filters));
  const hasMore = ref(false);

  function atBottom(): boolean {
    const element = scroller.value;
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }

  async function scrollToBottomIfNeeded(shouldScroll: boolean): Promise<void> {
    if (!shouldScroll) return;
    await nextTick();
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  }

  /** Re-seed the mirror for a project. A fresh transcript always opens at newest. */
  async function loadHistory(nextProjectId: string | null): Promise<void> {
    const generation = ++loadGeneration;
    if (!nextProjectId) {
      entries.value = [];
      hasMore.value = false;
      return;
    }
    loading.value = true;
    try {
      const result = await messClient.messHistory(nextProjectId, {});
      if (generation !== loadGeneration || projectId.value !== nextProjectId) return;
      const loadedIds = new Set(result.entries.map(entry => entry.id));
      const liveAppends = entries.value.filter(entry => entry.projectId === nextProjectId && !loadedIds.has(entry.id));
      entries.value = [...result.entries, ...liveAppends].sort((a, b) => a.seq - b.seq);
      hasMore.value = result.hasMore;
      await scrollToBottomIfNeeded(true);
    } catch (error) {
      if (generation === loadGeneration) {
        entries.value = [];
        hasMore.value = false;
        console.error('[MessPane] Failed to load history:', error);
      }
    } finally {
      if (generation === loadGeneration) loading.value = false;
    }
  }

  async function loadOlder(): Promise<void> {
    const id = projectId.value;
    const beforeSeq = entries.value[0]?.seq;
    if (!id || !hasMore.value || beforeSeq === undefined) return;
    const generation = ++loadGeneration;
    const element = scroller.value;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    loading.value = true;
    try {
      const result = await messClient.messHistory(id, { beforeSeq });
      if (generation !== loadGeneration || projectId.value !== id) return;
      const existingIds = new Set(entries.value.map(entry => entry.id));
      const olderEntries = result.entries.filter(entry => !existingIds.has(entry.id));
      entries.value = [...olderEntries, ...entries.value].sort((a, b) => a.seq - b.seq);
      hasMore.value = result.hasMore;
      await nextTick();
      if (element && scroller.value === element) element.scrollTop = previousTop + element.scrollHeight - previousHeight;
    } catch (error) {
      if (generation === loadGeneration) console.error('[MessPane] Failed to load older history:', error);
    } finally {
      if (generation === loadGeneration) loading.value = false;
    }
  }

  function onAppended(event: { projectId: string; entry: MessHistoryEntry }): void {
    if (event.projectId !== projectId.value || entries.value.some(entry => entry.id === event.entry.id)) return;
    const shouldScroll = atBottom();
    entries.value = [...entries.value, event.entry].sort((a, b) => a.seq - b.seq);
    void scrollToBottomIfNeeded(shouldScroll);
  }

  stopAppend = messClient.onMessAppended(onAppended);

  watch(projectId, (id, previousId) => {
    if (id === previousId) return;
    filters.senderId = '';
    filters.broadcast = 'either';
    filters.unread = 'either';
    void loadHistory(id);
  }, { immediate: true });

  onUnmounted(() => {
    stopAppend?.();
    stopAppend = undefined;
    loadGeneration += 1;
  });

  return {
    appState: appStore.state,
    entries,
    filters,
    hasMore,
    loading,
    loadOlder,
    projectId,
    projectName,
    resolveLabel: (sessionId: string | undefined, snapshot: string | undefined) =>
      resolveMessLabel(sessionId, snapshot, appStore.state.sessions),
    isTargetUnread: isMessTargetUnread,
    isSessionClosed: (sessionId: string) => !appStore.state.sessions.some(session => session.id === sessionId),
    scroller,
    senderOptions,
    visibleEntries,
  };
}
