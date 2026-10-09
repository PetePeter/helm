/**
 * Group Overview — 2-column grid of session preview cards.
 *
 * Renders into the terminal area (#mainArea) as a sibling to #terminalContainer.
 * Each card shows session name, activity dot, state label, and last 10 lines of PTY output.
 */

import { state, type Session } from '../state.js';
import { sessionsState } from './sessions-state.js';
import type { PtyOutputBuffer } from '../terminal/pty-output-buffer.js';
import { getVisibleSessions, type NavItem } from '../session-groups.js';
import { toDirection } from '../utils.js';
import { registerView, showView, currentView } from '../main-view/main-view-manager.js';

let outputBuffer: PtyOutputBuffer | null = null;
let sessionStateGetter: ((sessionId: string) => string) | null = null;
let activityLevelGetter: ((sessionId: string) => string) | null = null;
let previousActiveSessionId: string | null = null;
let selectedOnExit = false;
/** NavItem that had focus when overview opened — restored on dismiss, looked up by identity. */
let parentNavItem: NavItem | null = null;
let overviewDismissCallback: (() => void) | null = null;

/** Allow the navigation store to skip restore when navigating away. */
export function setSelectedOnExit(value: boolean): void {
  selectedOnExit = value;
}
const collapsedSessions = new Set<string>();

interface TerminalManagerLike {
  deselect(): void;
  switchTo(sessionId: string): void;
  getActiveSessionId(): string | null;
  hasTerminal(sessionId: string): boolean;
  getTerminalLines(sessionId: string, count: number): string[];
}

let terminalManagerGetter: (() => TerminalManagerLike | null) | null = null;

/** Inject terminal manager getter (called once from main.ts to avoid circular deps) */
export function setTerminalManagerGetter(fn: () => TerminalManagerLike | null): void {
  terminalManagerGetter = fn;
}

/** Inject the PtyOutputBuffer instance (called once from main.ts) */
export function setOutputBuffer(buffer: PtyOutputBuffer): void {
  outputBuffer = buffer;
}

/** Inject state getter to avoid circular deps with sessions.ts */
export function setSessionStateGetter(fn: (sessionId: string) => string): void {
  sessionStateGetter = fn;
}

/** Inject activity level getter to avoid circular deps with sessions.ts */
export function setActivityLevelGetter(fn: (sessionId: string) => string): void {
  activityLevelGetter = fn;
}

/** Show the overview grid for a specific group, or all visible sessions when no group is provided. Delegates through the main-view manager. */
export function showOverview(groupDirPath: string | null = null, initialSessionId?: string): void {
  void showView('overview', { groupDirPath, initialSessionId });
}

/** Internal — mount the overview view (called by the manager).
 *  DEPRECATED: App.vue now renders overview via Vue components.
 *  This function only sets up state for backward compat. */
function mountOverview(params?: unknown): void {
  const p = (params as { groupDirPath?: string | null; initialSessionId?: string } | undefined);
  const groupDirPath = p?.groupDirPath ?? null;
  const initialSessionId = p?.initialSessionId;

  sessionsState.overviewGroup = groupDirPath;
  sessionsState.overviewIsGlobal = groupDirPath === null;

  const overviewSessions = getOverviewSessions();
  const matchIdx = initialSessionId ? overviewSessions.findIndex(s => s.id === initialSessionId) : -1;
  sessionsState.overviewFocusIndex = matchIdx >= 0 ? matchIdx : 0;

  // Deselect the active terminal
  const tm = terminalManagerGetter?.();
  previousActiveSessionId = tm?.getActiveSessionId() ?? null;
  parentNavItem = sessionsState.navList[sessionsState.sessionsFocusIndex] ?? null;
  selectedOnExit = false;
  tm?.deselect();
}

/** Hide the overview grid and restore the terminal container. Delegates through the manager. */
export function hideOverview(): void {
  if (currentView() === 'overview') {
    void showView('terminal');
  } else {
    unmountOverview();
  }
}

/** Internal — unmount the overview view (called by the manager).
 *  DEPRECATED: App.vue now renders overview via Vue components.
 *  This function only handles cleanup for backward compat. */
function unmountOverview(): void {
  sessionsState.overviewGroup = null;
  sessionsState.overviewIsGlobal = false;

  // Restore the previously active terminal unless the exit already switched to a new session.
  const tm = terminalManagerGetter?.();
  const currentActive = tm?.getActiveSessionId() ?? null;
  const sessionAlreadySwitched = currentActive !== null && currentActive !== previousActiveSessionId;
  const shouldRestore = !selectedOnExit && !sessionAlreadySwitched;

  if (shouldRestore && tm && previousActiveSessionId && tm.hasTerminal(previousActiveSessionId)) {
    tm.switchTo(previousActiveSessionId);
  }

  // Restore sidebar focus to the nav item that opened the overview.
  if (!selectedOnExit) {
    if (parentNavItem) {
      const restoredIndex = sessionsState.navList.findIndex(
        item => item.type === parentNavItem!.type && item.id === parentNavItem!.id
      );
      if (restoredIndex >= 0) {
        sessionsState.sessionsFocusIndex = restoredIndex;
      } else {
        sessionsState.sessionsFocusIndex = Math.min(
          sessionsState.sessionsFocusIndex,
          Math.max(0, sessionsState.navList.length - 1),
        );
      }
    }
    overviewDismissCallback?.();
  }

  // Reset per-open state. Must happen after all restore logic above completes,
  // because selectedOnExit controls whether we restore previous terminal/focus.
  selectedOnExit = false;
  parentNavItem = null;
  previousActiveSessionId = null;
}

registerView('overview', { mount: mountOverview, unmount: unmountOverview });

/** Check if overview is currently visible */
export function isOverviewVisible(): boolean {
  return sessionsState.overviewIsGlobal || sessionsState.overviewGroup !== null;
}

/** Get the sessions shown in the current overview. */
export function getOverviewSessions(): Session[] {
  if (sessionsState.overviewIsGlobal) {
    return getVisibleOverviewGroups().flatMap(group => group.sessions);
  }
  if (!sessionsState.overviewGroup) return [];
  const group = sessionsState.groups.find(item => item.dirPath === sessionsState.overviewGroup);
  if (!group) {
    return state.sessions.filter(
      (session) => !session.remote && (session.projectPath ?? session.workingDir) === sessionsState.overviewGroup,
    );
  }
  return getVisibleSessions([group], sessionsState.groupPrefs);
}

/** Re-render overview cards if currently visible (e.g. after rename) */
export function refreshOverview(): void {
  if (!isOverviewVisible()) return;
  const sessionCount = getOverviewSessions().length;
  sessionsState.overviewFocusIndex = sessionCount > 0
    ? Math.max(0, Math.min(sessionsState.overviewFocusIndex, sessionCount - 1))
    : 0;
}

function getVisibleOverviewGroups(): Array<{ dirPath: string; sessions: Session[] }> {
  return sessionsState.groups
    .map(group => ({
      dirPath: group.dirPath,
      sessions: getVisibleSessions([group], sessionsState.groupPrefs),
    }))
    .filter(group => group.sessions.length > 0);
}

/** Select a card — exit overview and switch to the session */
export function selectOverviewCard(sessionId: string): void {
  selectedOnExit = true;
  hideOverview();
  selectCardCallback?.(sessionId);
}

export function handleOverviewInput(button: string): boolean {
  const dir = toDirection(button);
  const sessions = getOverviewSessions();
  const count = sessions.length;

  if (count === 0) {
    hideOverview();
    return true;
  }

  if (dir === 'left') {
    hideOverview();
    return true;
  }
  if (dir === 'right') {
    return true;
  }

  if (button === 'A') {
    const session = sessions[sessionsState.overviewFocusIndex];
    if (session) selectOverviewCard(session.id);
    return true;
  }

  if (button === 'X') {
    const session = sessions[sessionsState.overviewFocusIndex];
    if (session) {
      toggleCollapseCard(session.id);
      refreshOverview();
    }
    return true;
  }

  if (button === 'B') {
    hideOverview();
    return true;
  }

  return false;
}

/** Callback wired by useAppBootstrap.ts for switching session on card selection */
let selectCardCallback: ((sessionId: string) => void) | null = null;
export function setSelectCardCallback(fn: (sessionId: string) => void): void {
  selectCardCallback = fn;
}

/** Callback fired when overview is dismissed without a card selection (B/Left). Used to sync sidebar scroll. */
export function setOverviewDismissCallback(fn: () => void): void {
  overviewDismissCallback = fn;
}

/** Toggle collapse state for an overview card */
export function toggleCollapseCard(sessionId: string): void {
  if (collapsedSessions.has(sessionId)) {
    collapsedSessions.delete(sessionId);
  } else {
    collapsedSessions.add(sessionId);
  }
}

/** Check if an overview card is collapsed (exported for tests) */
export function isCardCollapsed(sessionId: string): boolean {
  return collapsedSessions.has(sessionId);
}
