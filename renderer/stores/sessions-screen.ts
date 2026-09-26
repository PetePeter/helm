/**
 * Sessions screen store — single authoritative owner of sessions navigation state.
 *
 * The sessionsState reactive object is defined here and re-exported from
 * screens/sessions-state.ts for backward-compatible imports. Vue components
 * should use useSessionsScreenStore() for computed helpers and actions.
 */

import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import type { NavItem, SessionGroup, SessionGroupPrefs } from '../session-groups.js';
import { isSessionHiddenFromOverview, buildSessionGroups, buildFlatNavList } from '../session-groups.js';
import { buildSessionShortcutMap } from '../utils/session-shortcut-map.js';
import { state } from '../state.js';
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
  /** Flat navigation list (group headers + session cards) — derived, read-only. */
  readonly navList: NavItem[];
  /** Grouped session data for rendering — derived, read-only. */
  readonly groups: SessionGroup[];
  /** Persisted group preferences (order + collapse). */
  groupPrefs: SessionGroupPrefs;
  /** Directory path of the group currently shown in overview (null = hidden). */
  overviewGroup: string | null;
  /** True when the current overview shows visible sessions across all folders. */
  overviewIsGlobal: boolean;
  /** Focused card index within the overview grid. */
  overviewFocusIndex: number;
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
  state.sessions,
  sessionId => resolveSessionCwd(sessionId),
  sessionsState.groupPrefs,
  useRuntimeGroups().groups.value,
));

const derivedNavList = computed<NavItem[]>(() => buildFlatNavList(
  derivedGroups.value,
  state.sessions.find(session => session.role === 'operator')?.id ?? null,
));

export const sessionsState: SessionsScreenState = reactive({
  activeFocus: 'sessions',
  sessionsFocusIndex: 0,
  spawnFocusIndex: 0,
  cardColumn: 0,
  cliTypes: [],
  directories: [],
  editingSessionId: null,
  get navList() { return derivedNavList.value; },
  get groups() { return derivedGroups.value; },
  groupPrefs: { order: [], collapsed: [], overviewHidden: [], bookmarked: [] },
  overviewGroup: null,
  overviewIsGlobal: false,
  overviewFocusIndex: 0,
  plansFocusIndex: 0,
});

export const useSessionsScreenStore = defineStore('sessionsScreen', () => {
  const isOverviewOpen = computed(() => sessionsState.overviewGroup !== null);

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

  const hiddenSessionIds = computed<Set<string>>(() => {
    const hidden = new Set<string>();
    for (const group of sessionsState.groups) {
      for (const session of group.sessions) {
        if (isSessionHiddenFromOverview(session, sessionsState.groupPrefs)) {
          hidden.add(session.id);
        }
      }
    }
    return hidden;
  });

  const snappedOutSessionIds = computed<Set<string>>(() => state.snappedOutSessions);

  const sessionShortcutMap = computed<Map<string, number>>(() =>
    buildSessionShortcutMap(sessionsState.navList, hiddenSessionIds.value, snappedOutSessionIds.value),
  );

  function setFocus(zone: SessionsFocus): void {
    sessionsState.activeFocus = zone;
  }

  function openOverview(dirPath: string, isGlobal = false): void {
    sessionsState.overviewGroup = dirPath;
    sessionsState.overviewIsGlobal = isGlobal;
    sessionsState.overviewFocusIndex = 0;
  }

  function closeOverview(): void {
    sessionsState.overviewGroup = null;
    sessionsState.overviewIsGlobal = false;
    sessionsState.overviewFocusIndex = 0;
  }

  function setEditingSession(id: string | null): void {
    sessionsState.editingSessionId = id;
  }

  return {
    sessionsState,
    isOverviewOpen,
    activeNavItem,
    focusedGroup,
    hiddenSessionIds,
    sessionShortcutMap,
    setFocus,
    openOverview,
    closeOverview,
    setEditingSession,
  };
});
