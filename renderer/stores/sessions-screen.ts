/**
 * Sessions screen store — single authoritative owner of sessions navigation state.
 *
 * The sessionsState reactive object is defined here and re-exported from
 * screens/sessions-state.ts for backward-compatible imports. Vue components
 * should use useSessionsScreenStore() for computed helpers and actions.
 */

import { defineStore } from 'pinia';
import { reactive, computed, watch } from 'vue';
import type { NavItem, SessionGroup, SessionGroupPrefs } from '../session-groups.js';
import { buildSessionGroups, buildFlatNavList, filterVisibleSessions } from '../session-groups.js';
import { buildSessionShortcutMap } from '../utils/session-shortcut-map.js';
import { state, type Session } from '../state.js';
import { useRuntimeGroups } from '../composables/useRuntimeGroups.js';
import type { ProjectDirectoryItem } from '../screens/planner-directories.js';

export type SessionsFocus = 'sessions' | 'spawn' | 'plans';

export interface SessionsScreenState {
  activeFocus: SessionsFocus;
  sessionsFocusIndex: number;
  spawnFocusIndex: number;
  cardColumn: 0 | 1 | 2 | 3 | 4 | 5;
  cliTypes: string[];
  directories: ProjectDirectoryItem[];
  editingSessionId: string | null;
  /** In-memory Session List filter toggle. */
  showHiddenSessions: boolean;
  /** Hidden local sessions not already visible as the active row. */
  readonly hiddenSessionCount: number;
  /** Shared session source for grouped rendering and sidebar navigation. */
  readonly visibleSessions: Session[];
  /** Flat navigation list (group headers + session cards) — derived, read-only. */
  readonly navList: NavItem[];
  /** Grouped session data for rendering — derived, read-only. */
  readonly groups: SessionGroup[];
  /** Persisted group preferences (order + collapse). */
  groupPrefs: SessionGroupPrefs;
  /** Focused button index within the plans grid. */
  plansFocusIndex: number;
}

/**
 * Resolve a session id to the working directory it groups under.
 *
 * The store cannot import the screen-level resolver (screens/* already import
 * this store), so the app injects it at bootstrap. The default reads the
 * session's own workingDir, which keeps the store usable standalone.
 */
let resolveSessionCwd: (sessionId: string) => string =
  sessionId => state.sessions.find(session => session.id === sessionId)?.workingDir ?? '';

/** Point group resolution at the live terminal cwd. Called once, at bootstrap. */
export function setSessionCwdResolver(resolver: (sessionId: string) => string): void {
  resolveSessionCwd = resolver;
}

/**
 * The sidebar's grouped view of state.sessions.
 *
 * Derived, never assigned. Sidebar cards used to render from a hand-rebuilt
 * snapshot, so any session change that skipped a full refresh — a lock toggle,
 * a snap-out, an MCP/peer spawn — left the cards showing stale data.
 */
const derivedGroups = computed<SessionGroup[]>(() => buildSessionGroups(
  sessionsState.visibleSessions,
  sessionId => resolveSessionCwd(sessionId),
  sessionsState.groupPrefs,
  useRuntimeGroups().groups.value,
));

const derivedNavList = computed<NavItem[]>(() => buildFlatNavList(
  derivedGroups.value,
  sessionsState.visibleSessions.find(session => session.role === 'operator')?.id ?? null,
  sessionsState.visibleSessions.filter(session => !!session.remote),
));

const visibleSessions = computed(() => filterVisibleSessions(
  state.sessions,
  state.activeSessionId,
  sessionsState.showHiddenSessions,
));

const hiddenSessionCount = computed(() => state.sessions.filter(session =>
  !session.remote && session.hidden && session.id !== state.activeSessionId,
).length);

export const sessionsState: SessionsScreenState = reactive({
  activeFocus: 'sessions',
  sessionsFocusIndex: 0,
  spawnFocusIndex: 0,
  cardColumn: 0,
  cliTypes: [],
  directories: [],
  editingSessionId: null,
  showHiddenSessions: false,
  get hiddenSessionCount() { return hiddenSessionCount.value; },
  get visibleSessions() { return visibleSessions.value; },
  get navList() { return derivedNavList.value; },
  get groups() { return derivedGroups.value; },
  groupPrefs: { order: [], collapsed: [], bookmarked: [] },
  plansFocusIndex: 0,
});

watch(hiddenSessionCount, count => {
  if (count === 0) sessionsState.showHiddenSessions = false;
});

export function toggleShowHiddenSessions(): void {
  sessionsState.showHiddenSessions = !sessionsState.showHiddenSessions;
}

export const useSessionsScreenStore = defineStore('sessionsScreen', () => {
  const activeNavItem = computed(() =>
    sessionsState.navList[sessionsState.sessionsFocusIndex] ?? null,
  );

  const focusedGroup = computed(() => {
    const item = activeNavItem.value;
    if (!item) return null;
    if (item.type === 'group-header') {
      return sessionsState.groups.find(g => g.dirPath === item.id) ?? null;
    }
    if (item.type === 'session-card') {
      return sessionsState.groups.find(g => g.sessions.some(s => s.id === item.id)) ?? null;
    }
    return null;
  });

  const snappedOutSessionIds = computed<Set<string>>(() => state.snappedOutSessions);

  const sessionShortcutMap = computed<Map<string, number>>(() =>
    buildSessionShortcutMap(sessionsState.navList, snappedOutSessionIds.value),
  );

  function setFocus(zone: SessionsFocus): void {
    sessionsState.activeFocus = zone;
  }

  function setEditingSession(id: string | null): void {
    sessionsState.editingSessionId = id;
  }

  return {
    sessionsState,
    activeNavItem,
    focusedGroup,
    sessionShortcutMap,
    setFocus,
    setEditingSession,
  };
});
