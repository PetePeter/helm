/**
 * App store — Pinia owner for renderer application state.
 */

import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';
import type { Session, AppState } from '../state.js';

export const appState: AppState = reactive({
  currentScreen: 'sessions',
  sessions: [],
  activeSessionId: null,
  recentSessionId: null,
  lastSelectedSessionId: null,
  gamepadCount: 0,
  eventLog: [],
  cliTypes: [],
  availableSpawnTypes: [],
  cliBindingsCache: {},
  cliToolsCache: {},
  projects: [],
  settingsTab: 'tools',
  sessionStates: new Map(),
  sessionActivityLevels: new Map(),
  lastOutputTimes: new Map(),
  draftCounts: new Map(),
  artifactCounts: new Map(),
  planCodingCounts: new Map(),
  planStartableCounts: new Map(),
  planDirStartableCounts: new Map(),
  planDirCodingCounts: new Map(),
  planDirBlockedCounts: new Map(),
  planDirReviewCounts: new Map(),
  planDirPlanningCounts: new Map(),
  workingPlanLabels: new Map(),
  workingPlanTooltips: new Map(),
  pendingSchedules: new Map(),
  snappedOutSessions: new Set(),
});

/**
 * Windows that exist to serve exactly one session (the snap-out popout) pin it.
 *
 * Module scope, not store state: each popout is its own BrowserWindow, so this
 * is already per-window, and keeping it out of `appState` means nothing that
 * serializes or resets the state tree can quietly unpin a window.
 */
let pinnedSessionId: string | null = null;
let refusedNavigationLogged = false;

/**
 * The one guard. Module scope rather than a store action so that the navigation
 * store — the renderer's other write authority for `activeSessionId` — funnels
 * through the same check without importing a Pinia instance. A window that
 * pinned its session therefore needs no `if (isPopout)` checks of its own, and a
 * stray navigation is refused rather than thrown, because a background nav
 * attempt must never take the window down with it.
 */
export function setActiveSessionId(id: string | null): void {
  if (pinnedSessionId !== null) {
    if (id !== pinnedSessionId && !refusedNavigationLogged) {
      refusedNavigationLogged = true;
      console.debug(`[App] Ignoring session navigation to ${id}; this window is pinned to ${pinnedSessionId}.`);
    }
    return;
  }
  appState.activeSessionId = id;
}

export const useAppStore = defineStore('app', () => {
  const state = appState;

  // ── Getters ──────────────────────────────────────────────────────────
  const activeSession = computed<Session | undefined>(
    () => state.sessions.find(s => s.id === state.activeSessionId),
  );

  const activeSessionDir = computed<string | null>(() => getActiveSessionDir());

  const sessionCount = computed(() => state.sessions.filter(session => !session.remote).length);

  const hasActiveSession = computed(() => state.activeSessionId !== null);

  // ── Actions ──────────────────────────────────────────────────────────
  function setScreen(screen: string) {
    state.currentScreen = screen;
  }

  /** Bind this window to one session for its lifetime. */
  function pinActiveSession(sessionId: string) {
    pinnedSessionId = null;
    setActiveSessionId(sessionId);
    pinnedSessionId = sessionId;
  }

  function isActiveSessionPinned(): boolean {
    return pinnedSessionId !== null;
  }

  function addSession(session: Session) {
    state.sessions.push(session);
  }

  function removeSession(id: string) {
    const idx = state.sessions.findIndex(s => s.id === id);
    if (idx !== -1) state.sessions.splice(idx, 1);
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const session = state.sessions.find(s => s.id === id);
    if (session) Object.assign(session, updates);
  }

  function setSessions(sessions: Session[]) {
    state.sessions = sessions;
  }

  function upsertSession(session: Session) {
    const idx = state.sessions.findIndex(s => s.id === session.id);
    if (idx !== -1) state.sessions[idx] = session;
    else state.sessions.push(session);
  }

  function setProjects(projects: AppState['projects']) {
    state.projects = projects;
  }

  function setGamepadCount(count: number) {
    state.gamepadCount = count;
  }

  function logEvent(event: { time: string; event: string }) {
    state.eventLog.push(event);
    if (state.eventLog.length > 100) state.eventLog.shift();
  }

  // Re-export reactive state fields + getters + actions
  return {
    state,
    activeSession,
    activeSessionDir,
    sessionCount,
    hasActiveSession,
    setScreen,
    setActiveSessionId,
    addSession,
    removeSession,
    updateSession,
    setSessions,
    pinActiveSession,
    isActiveSessionPinned,
    upsertSession,
    setProjects,
    setGamepadCount,
    logEvent,
  };
});

/**
 * Release the pin. A real window never unpins — it is destroyed instead — so
 * this exists purely so a test file can reuse the module across cases.
 */
export function resetActiveSessionPinForTests(): void {
  pinnedSessionId = null;
  refusedNavigationLogged = false;
}

/** Resolve the working directory for the currently selected session. */
export function getActiveSessionDir(): string | null {
  const session = appState.activeSessionId
    ? appState.sessions.find(entry => entry.id === appState.activeSessionId)
    : undefined;
  return session?.workingDir ?? null;
}
