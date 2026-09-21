import { configClient, plansClient, sessionsClient } from '../ipc/clients.js';
/**
 * Sessions screen — sidebar state, navigation handlers, and public API.
 *
 * Vue renders the grouped session list. This module owns the navigation state,
 * keyboard/gamepad routing, and non-visual session services.
 */

import { state } from '../state.js';
import { buildPlannerDirectories, buildPlannerDirectorySource } from './planner-directories.js';
import { sessionsState } from './sessions-state.js';
import { logEvent, getCliDisplayName, toDirection } from '../utils.js';
import type { Session } from '../state.js';
import { closeConfirm, setCloseConfirmCallback } from '../stores/modal-bridge.js';
import { sortSessions } from '../sort-logic.js';
import { getOrderedSessionIds } from '../utils/session-shortcut-map.js';
import {
  toggleCollapse,
  findNavIndexBySessionId, getSessionOverviewAliases, getSessionOverviewKey,
} from '../session-groups.js';
import { useRuntimeGroups } from '../composables/useRuntimeGroups.js';
import {
  getOverviewSessions, hideOverview, isOverviewVisible, refreshOverview,
} from './group-overview.js';
import { useNavigationStore } from '../stores/navigation.js';
import { isPlanScreenVisible, hidePlanScreen } from '../plans/plan-screen.js';
import { loadStoredSessions } from '../session-store.js';

// Sub-module imports — circular at module level, safe because all usages are in function bodies.
import {
  updateStatusCounts,
  startRename, commitRename, cancelRename,
  sessionsSortField, sessionsSortDirection,
} from '../sidebar/session-services.js';

import {
  getSessionCwd, getTerminalManager,
  handleSessionsZone, handleSpawnZone, handleSpawnZoneButton,
  clamp,
} from './sessions-spawn.js';

import {
  handlePlansZone, handlePlansZoneButton, updatePlansFocus, refreshPlanBadges,
} from './sessions-plans.js';

// Re-export public API from sub-modules so all consumers import from sessions.ts only.
export {
  doSpawn, showTerminalArea, hideTerminalArea,
  setDirPickerBridge, setTerminalManagerGetter, setPendingContextText,
  spawnNewSession, switchToSession,
  getSessionCwd, getTerminalManager,
} from './sessions-spawn.js';

// ============================================================================
// Session state maps
// ============================================================================

const sessionStates = new Map<string, string>();

// Draft count cache — updated on session load and draft changes
const draftCounts = new Map<string, number>();

export function getDraftCountCache(sessionId: string): number {
  return draftCounts.get(sessionId) ?? 0;
}

export function setDraftCountCache(sessionId: string, count: number): void {
  draftCounts.set(sessionId, count);
}

// Plan count caches — updated when plan chips refresh
const planCodingCounts = new Map<string, number>();
const planStartableCounts = new Map<string, number>();

export function getPlanCodingCountCache(sessionId: string): number {
  return planCodingCounts.get(sessionId) ?? 0;
}

export function setPlanCodingCountCache(sessionId: string, count: number): void {
  planCodingCounts.set(sessionId, count);
}

export function getPlanStartableCountCache(sessionId: string): number {
  return planStartableCounts.get(sessionId) ?? 0;
}

export function setPlanStartableCountCache(sessionId: string, count: number): void {
  planStartableCounts.set(sessionId, count);
}


export function getSessionState(sessionId: string): string {
  return sessionStates.get(sessionId) || 'idle';
}

export async function setSessionState(sessionId: string, newState: string): Promise<void> {
  const previous = sessionStates.get(sessionId) ?? state.sessionStates.get(sessionId) ?? 'idle';
  if (previous === newState) return;

  try {
    if (!sessionsClient.sessionSetState) return;
    const result = await sessionsClient.sessionSetState(sessionId, newState);
    if (result?.success === false) {
      logEvent(`State change failed: ${result.error}`);
      return;
    }

    sessionStates.set(sessionId, newState);

    const session = state.sessions.find(item => item.id === sessionId);
    if (!(session as any)?.aiagentState) {
      state.sessionStates.set(sessionId, newState);
    }
    if (session) {
      (session as any).state = newState;
    }

    if (sessionsSortField === 'state') {
      await loadSessionsData();
    }

    if (isOverviewVisible()) {
      refreshOverview();
    }

    updateSessionsFocus();
  } catch (error) {
    console.error('[Sessions] Failed to set session state:', error);
    logEvent('State change failed');
  }
}

export function removeSessionState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

/** Get session activity level — reads from reactive state updated by useAppBootstrap. */
export function getSessionActivity(sessionId: string): string {
  return state.sessionActivityLevels.get(sessionId) ?? 'idle';
}

function cleanupRendererSession(sessionId: string): void {
  removeSessionState(sessionId);
  draftCounts.delete(sessionId);
  planCodingCounts.delete(sessionId);
  planStartableCounts.delete(sessionId);
  state.sessionActivityLevels.delete(sessionId);
  state.lastOutputTimes.delete(sessionId);
  state.workingPlanLabels.delete(sessionId);
  state.workingPlanTooltips.delete(sessionId);
  state.pendingSchedules.delete(sessionId);
  state.snappedOutSessions.delete(sessionId);
}

export async function doCloseSession(sessionId: string): Promise<void> {

  try {
    const result = await sessionsClient.sessionClose(sessionId);
    if (!result?.success && result?.error !== 'Session not found') {
      console.error(`[Sessions] Failed to close session ${sessionId}:`, result?.error ?? 'unknown error');
      return;
    }
  } catch (error) {
    console.error(`[Sessions] Failed to close session ${sessionId}:`, error);
    return;
  }

  cleanupRendererSession(sessionId);
  await loadSessions();
}

// ============================================================================
// Group prefs
// ============================================================================

let groupPrefsLoaded = false;

async function initSessionGroupPrefs(): Promise<void> {
  if (groupPrefsLoaded) return;
  try {
        const prefs = await configClient.configGetSessionGroupPrefs();
    if (prefs) {
      sessionsState.groupPrefs = normalizeGroupPrefs(prefs);
    }
  } catch (e) {
    console.error('[Sessions] Failed to load group prefs:', e);
  }
  groupPrefsLoaded = true;
}

function normalizeGroupPrefs(prefs: Partial<typeof sessionsState.groupPrefs>): typeof sessionsState.groupPrefs {
  return {
    order: prefs.order ?? [],
    collapsed: prefs.collapsed ?? [],
    bookmarked: prefs.bookmarked ?? [],
    overviewHidden: prefs.overviewHidden ?? [],
    teamViewCollapsed: prefs.teamViewCollapsed ?? [],
  };
}

/** Ensure order array contains all current dir paths (appends missing ones). */
async function saveGroupPrefs(): Promise<void> {
  try {
        await configClient.configSetSessionGroupPrefs({
      order: [...sessionsState.groupPrefs.order],
      collapsed: [...sessionsState.groupPrefs.collapsed],
      overviewHidden: [...sessionsState.groupPrefs.overviewHidden],
      teamViewCollapsed: [...(sessionsState.groupPrefs.teamViewCollapsed ?? [])],
    });
  } catch (e) {
    console.error('[Sessions] Failed to save group prefs:', e);
  }
}

/**
 * Set or clear a session's closure lock. Shared by the card button and the
 * gamepad column so the two cannot diverge; the resulting state arrives back
 * through session:updated, so nothing is mirrored locally.
 */
export async function setSessionLocked(sessionId: string, locked: boolean): Promise<void> {
  try {
    await sessionsClient.sessionSetLocked?.(sessionId, locked);
  } catch (e) {
    console.error('[Sessions] Failed to set session lock:', e);
  }
}

/** Flip the lock of the session under the gamepad cursor. */
export function toggleLockForFocused(sessionId: string): void {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  void setSessionLocked(sessionId, !session.locked);
}

export async function toggleSessionOverviewVisibility(sessionId: string): Promise<void> {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;

  const hidden = new Set(sessionsState.groupPrefs.overviewHidden ?? []);
  const aliases = getSessionOverviewAliases(session);
  const hiddenFromOverview = aliases.some(key => hidden.has(key));

  aliases.forEach(key => hidden.delete(key));
  if (!hiddenFromOverview) {
    hidden.add(getSessionOverviewKey(session));
  }

  sessionsState.groupPrefs = {
    ...sessionsState.groupPrefs,
    overviewHidden: [...hidden],
  };
  await saveGroupPrefs();
  if (isOverviewVisible()) {
    const count = getOverviewSessions().length;
    if (count === 0) {
      hideOverview();
    } else {
      sessionsState.overviewFocusIndex = clamp(sessionsState.overviewFocusIndex, 0, count - 1);
      refreshOverview();
    }
  }
  updateSessionsFocus();
}

export async function toggleGroupCollapse(dirPath: string): Promise<void> {
  // Runtime groups own their collapse state in the runtime-group store (keyed by
  // group id, which is the nav header id). Directory collapse stays in prefs.
  const runtime = useRuntimeGroups().groups.value.find(g => g.id === dirPath);
  if (runtime) {
    await useRuntimeGroups().setCollapsed(runtime.id, !runtime.collapsed);
    await loadSessions();
    return;
  }
  sessionsState.groupPrefs = {
    ...sessionsState.groupPrefs,
    collapsed: toggleCollapse(sessionsState.groupPrefs.collapsed, dirPath),
  };
  await saveGroupPrefs();
  await loadSessions();
}

/** Persist Team View department collapse separately from Session List groups. */
export async function toggleTeamViewDepartmentCollapse(departmentId: string): Promise<void> {
  sessionsState.groupPrefs = {
    ...sessionsState.groupPrefs,
    teamViewCollapsed: toggleCollapse(sessionsState.groupPrefs.teamViewCollapsed ?? [], departmentId),
  };
  await saveGroupPrefs();
}

/** Remove a directory bookmark — empty group header disappears. */
export async function removeBookmark(dirPath: string): Promise<void> {
  try {
    await configClient.configRemoveBookmarkedDir(dirPath);
    const bookmarked = sessionsState.groupPrefs.bookmarked ?? [];
    sessionsState.groupPrefs = {
      ...sessionsState.groupPrefs,
      bookmarked: bookmarked.filter(d => d !== dirPath),
    };
    await loadSessions();
  } catch (e) {
    console.error('[Sessions] Failed to remove bookmark:', e);
  }
}

/** Get the session at the current nav focus (only if it's a session-card). */
function getSessionAtFocus(): Session | undefined {
  const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
  if (!navItem || navItem.type !== 'session-card') return undefined;
  return state.sessions.find(s => s.id === navItem.id);
}

function confirmCloseSession(): void {
  const session = getSessionAtFocus();
  if (!session) return;
  confirmCloseSessionById(session.id);
}

export function confirmCloseSessionById(sessionId: string): void {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;
  const displayName = session.name !== session.cliType
    ? session.name
    : getCliDisplayName(session.cliType);

  closeConfirm.visible = true;
  closeConfirm.sessionId = session.id;
  closeConfirm.sessionName = displayName;
  closeConfirm.draftCount = getDraftCountCache(session.id) ?? 0;
  setCloseConfirmCallback(doCloseSession);
}

function getFocusedRenderedSessionCard(): HTMLElement | null {
  const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
  if (!navItem || navItem.type !== 'session-card') return null;
  return document.querySelector(`.session-card[data-session-id="${navItem.id}"]`) as HTMLElement | null;
}

function getEditingRenameInput(): HTMLInputElement | null {
  if (sessionsState.editingSessionId) {
    const editingCard = document.querySelector(
      `.session-card[data-session-id="${sessionsState.editingSessionId}"]`
    ) as HTMLElement | null;
    const editingInput = editingCard?.querySelector('.session-rename-input') as HTMLInputElement | null;
    if (editingInput) return editingInput;
  }
  return document.querySelector('.session-rename-input') as HTMLInputElement | null;
}

function startRenameForFocused(): void {
  const session = getSessionAtFocus();
  if (!session) return;
  startRename(session.id);
}

function getDirPathForSession(sessionId: string): string | null {
  const session = state.sessions.find(item => item.id === sessionId);
  if (session?.projectPath) return session.projectPath;
  return session?.workingDir ?? getSessionCwd(sessionId) ?? null;
}

function isSessionHiddenFromOverview(session: Session): boolean {
  const hidden = new Set(sessionsState.groupPrefs.overviewHidden ?? []);
  return getSessionOverviewAliases(session).some(key => hidden.has(key));
}

function getFocusedGroupDirPath(): string | null {
  const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
  if (navItem?.type === 'group-header') return navItem.id;
  if (navItem?.type === 'session-card') {
    return getDirPathForSession(navItem.id) ?? sessionsState.groups[navItem.groupIndex]?.dirPath ?? null;
  }
  if (sessionsState.activeFocus === 'plans') {
    return buildPlannerDirectories(
      buildPlannerDirectorySource(sessionsState.directories, state.projects ?? []),
    )[sessionsState.plansFocusIndex]?.path ?? null;
  }
  return null;
}

function resolvePlanShortcutDirPath(preferredSessionId?: string): string | null {
  if (preferredSessionId) return getDirPathForSession(preferredSessionId);
  // When an overview is open, Ctrl+N targets that overview's directory.
  if (sessionsState.overviewGroup) return sessionsState.overviewGroup;
  return getFocusedGroupDirPath()
    ?? (state.activeSessionId ? getDirPathForSession(state.activeSessionId) : null)
    ?? sessionsState.groups[0]?.dirPath
    ?? buildPlannerDirectories(buildPlannerDirectorySource(sessionsState.directories, state.projects ?? []))[0]?.path
    ?? null;
}

export async function triggerNewPlanShortcut(preferredSessionId?: string): Promise<void> {
  const dirPath = resolvePlanShortcutDirPath(preferredSessionId);
  if (!dirPath || !plansClient.planCreate) return;
  try {
    await plansClient.planCreate(dirPath, 'New Plan', '');
    await loadSessions();
    void refreshPlanBadges();
  } catch (err) {
    console.error('[Sessions] Ctrl+N plan create failed:', err);
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function loadSessions(): Promise<void> {
  await initSessionGroupPrefs();
  await loadSessionsData();
  void refreshPlanBadges();
  updateStatusCounts();
}


export function handleSessionsScreenButton(button: string): boolean {
  // State dropdown intercepts all input when open
  const dropdown = document.querySelector('.session-state-dropdown');
  if (dropdown) {
    handleStateDropdownButton(button, dropdown as HTMLElement);
    return true; // consumed
  }

  // Rename mode intercepts all input
  if (sessionsState.editingSessionId) {
    const input = getEditingRenameInput();
    if (button === 'A') {
      if (input) commitRename(sessionsState.editingSessionId, input.value);
      return true;
    }
    if (button === 'B') {
      cancelRename();
      return true;
    }
    if (input && (button === 'DPadLeft' || button === 'DPadRight')) {
      const pos = input.selectionStart ?? 0;
      const newPos = button === 'DPadLeft' ? Math.max(0, pos - 1) : Math.min(input.value.length, pos + 1);
      input.setSelectionRange(newPos, newPos);
      return true;
    }
    return true; // consume all other buttons
  }

  const dir = toDirection(button);

  if (dir) {
    // D-pad navigation — always consumed
    if (sessionsState.activeFocus === 'sessions') {
      handleSessionsZone(button, dir);
    } else if (sessionsState.activeFocus === 'plans') {
      handlePlansZone(button, dir);
    } else {
      handleSpawnZone(button, dir);
    }
    return true;
  }

  // Non-directional buttons: check specific handlers
  if (sessionsState.activeFocus === 'sessions') {
    return handleSessionsZoneButton(button);
  } else if (sessionsState.activeFocus === 'plans') {
    return handlePlansZoneButton(button);
  } else {
    return handleSpawnZoneButton(button);
  }
}

export function updateSessionHighlight(): void {
  sessionsState.cardColumn = 0;
  updateSessionsFocus();
}

/** Sync sidebar session highlight after a tab switch (e.g. Ctrl+Tab) */
export function syncSessionHighlight(sessionId: string): void {
  const idx = findNavIndexBySessionId(sessionsState.navList, sessionId);
  if (idx >= 0) {
    sessionsState.sessionsFocusIndex = idx;
    sessionsState.cardColumn = 0;
    const result = useNavigationStore().activateSession(sessionId);
    if (result.kind === 'unavailable') return;
    useNavigationStore().syncSidebarToSession(sessionId);
    // Selecting a session is mutually exclusive with the planner screen.
    if (isPlanScreenVisible()) hidePlanScreen();
    updateSessionsFocus();
  }
}

/**
 * Returns session IDs in visual display order for Ctrl+Tab cycling.
 * Delegates to getOrderedSessionIds for a single ordering source shared
 * with the Ctrl+N shortcut map. Collapsed-group sessions are naturally
 * absent from navList and thus excluded.
 */
export function getTabCycleSessionIds(): string[] {
  const hiddenIds = new Set(
    state.sessions
      .filter(session => isSessionHiddenFromOverview(session))
      .map(session => session.id),
  );
  const snappedOutIds = state.snappedOutSessions;
  return getOrderedSessionIds(sessionsState.navList, hiddenIds, snappedOutIds);
}

// ============================================================================
// Data loading
// ============================================================================

export async function loadSessionsData(): Promise<void> {

  // Build the list in a local array and assign atomically at the end.
  // Previously we did `state.sessions = []` up-front and pushed after awaits,
  // which caused a race: concurrent callers (e.g. rapid PTY state changes
  // each firing loadSessions via setSessionState) would all reset to [] then
  // push N entries each, yielding N×callers duplicates on the session list.
  const nextSessions: Session[] = [];
  let managedSessions: Session[] = [];
  try {
    const tm = getTerminalManager() as (ReturnType<typeof getTerminalManager> & {
      hydrateFromStore?: () => Promise<Session[]>;
      getManagedSessions?: () => Session[];
    });
    managedSessions = tm?.hydrateFromStore
      ? await tm.hydrateFromStore()
      : (tm?.getManagedSessions?.() ?? await loadStoredSessions());
  } catch (e) {
    console.error('[Sessions] Failed to load managed sessions:', e);
  }
  for (const session of managedSessions) {
    nextSessions.push(session);
    if (!state.lastOutputTimes.has(session.id) && session.lastOutputAt && session.lastOutputAt > 0) {
      state.lastOutputTimes.set(session.id, session.lastOutputAt);
    }
  }

  // Sort sessions by user preference
  state.sessions = sortSessions(
    nextSessions,
    sessionsSortField,
    sessionsSortDirection,
    getSessionState,
    getSessionCwd,
    getSessionActivity,
  );

  // groups and navList derive from state.sessions (stores/sessions-screen.ts);
  // assigning state.sessions above is what rebuilds them.

  try {
    sessionsState.cliTypes = await configClient.configGetCliTypes();
  } catch (e) { console.error('[Sessions] Failed to load CLI types:', e); }

  try {
    sessionsState.directories = (await configClient.configGetWorkingDirs()) || [];
  } catch (e) { console.error('[Sessions] Failed to load directories:', e); }

  // Clamp focus indices after data reload
  const activeIdx = state.activeSessionId
    ? findNavIndexBySessionId(sessionsState.navList, state.activeSessionId)
    : -1;
  sessionsState.sessionsFocusIndex = activeIdx >= 0
    ? activeIdx
    : clamp(sessionsState.sessionsFocusIndex, 0, Math.max(0, sessionsState.navList.length - 1));
  sessionsState.spawnFocusIndex = clamp(
    sessionsState.spawnFocusIndex, 0, Math.max(0, sessionsState.cliTypes.length - 1),
  );
}

// ============================================================================
// State dropdown handlers
// ============================================================================

/** Open the state dropdown for the currently focused session card via Vue bridge. */
function openStateDropdownForFocused(): void {
  const session = getSessionAtFocus();
  if (!session) return;
  const card = getFocusedRenderedSessionCard()
    ?? document.querySelector(`.session-card[data-session-id="${session.id}"]`);
  if (!card) return;
  card.dispatchEvent(new CustomEvent('open-state-dropdown'));
}

/** Handle gamepad buttons while the state dropdown is open. */
function handleStateDropdownButton(button: string, dropdown: HTMLElement): void {
  const options = dropdown.querySelectorAll('.session-state-option') as NodeListOf<HTMLElement>;
  if (options.length === 0) return;

  // Find currently focused option via .dropdown-focused class
  let focusIndex = Array.from(options).findIndex(o => o.classList.contains('dropdown-focused'));
  if (focusIndex < 0) focusIndex = Array.from(options).findIndex(o => o.classList.contains('active'));
  if (focusIndex < 0) focusIndex = 0;

  const dir = toDirection(button);

  if (dir === 'up') {
    focusIndex = Math.max(0, focusIndex - 1);
    setDropdownFocus(options, focusIndex);
    return;
  }
  if (dir === 'down') {
    focusIndex = Math.min(options.length - 1, focusIndex + 1);
    setDropdownFocus(options, focusIndex);
    return;
  }
  if (button === 'A') {
    options[focusIndex]?.click();
    return;
  }
  if (button === 'B') {
    const card = dropdown.closest('.session-card');
    card?.dispatchEvent(new CustomEvent('close-state-dropdown'));
    return;
  }
  // Other buttons: ignore while dropdown is open
}

function setDropdownFocus(options: NodeListOf<HTMLElement>, index: number): void {
  options.forEach(o => o.classList.remove('dropdown-focused'));
  if (options[index]) {
    options[index].classList.add('dropdown-focused');
    options[index].scrollIntoView({ block: 'nearest' });
  }
}

// ============================================================================
// Gamepad navigation — sessions zone button actions
// ============================================================================

function handleSessionsZoneButton(button: string): boolean {
  const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
  if (!navItem) return false;

  if (button === 'A') {
    if (navItem.type === 'group-header') {
      if (sessionsState.cardColumn === 0) {
        toggleGroupCollapse(navItem.id);
        return true;
      }
      return true; // consumed
    }
    // session-card
    if (sessionsState.cardColumn === 1) {
      openStateDropdownForFocused();
      return true;
    }
    if (sessionsState.cardColumn === 2) {
      startRenameForFocused();
      return true;
    }
    if (sessionsState.cardColumn === 3) {
      toggleSessionOverviewVisibility(navItem.id);
      return true;
    }
    if (sessionsState.cardColumn === 4) {
      confirmCloseSession();
      return true;
    }
    // The lock sits left of ✕ on screen but keeps the highest column index, so
    // the existing 1-4 column numbering (and its muscle memory) is untouched.
    if (sessionsState.cardColumn === 5) {
      toggleLockForFocused(navItem.id);
      return true;
    }
    // col=0: fall through to config bindings
    return false;
  }
  if (button === 'B') {
    if (sessionsState.cardColumn > 0) {
      sessionsState.cardColumn = (sessionsState.cardColumn - 1) as 0 | 1 | 2 | 3 | 4 | 5;
      updateSessionsFocus();
      return true;
    }
    return false;
  }
  // X, Y, bumpers, triggers — fall through to config bindings
  return false;
}

// ============================================================================
// Focus update helpers
// ============================================================================

export function updateSessionsFocus(): void {
  // Vue renders the sidebar highlight from the identity-based focusedNavItem
  // (see isNavItemFocused). Keep that identity in lockstep with the numeric
  // stepping cursor for ALL nav item types (cards, group headers, overview
  // button) so D-pad/keyboard moves onto non-session rows highlight correctly.
  if (sessionsState.activeFocus === 'sessions') {
    try { useNavigationStore().captureCurrentFocus(); } catch { /* store not ready */ }
  }
  const list = document.getElementById('sessionsList');
  if (!list) return;
  // Vue owns the visual focused/card-column classes; this helper only keeps the
  // currently focused rendered row visible as navigation state changes.
  if (sessionsState.activeFocus !== 'sessions') return;
  const focused = list.querySelector<HTMLElement>(
    `[data-nav-index="${sessionsState.sessionsFocusIndex}"]`,
  );
  focused?.scrollIntoView({ block: 'nearest' });
}

export function updateSpawnFocus(): void {
  const grid = document.getElementById('spawnGrid');
  if (!grid) return;
  grid.querySelectorAll('.spawn-btn').forEach((el, i) => {
    el.classList.toggle('focused', i === sessionsState.spawnFocusIndex && sessionsState.activeFocus === 'spawn');
  });
}

export function updateAllFocus(): void {
  updateSessionsFocus();
  updateSpawnFocus();
  updatePlansFocus();
}

export function refreshSessions(): void {
  loadSessions().catch(e => console.error('[Sessions] Refresh failed:', e));
  logEvent('Sessions refreshed');
}

// ============================================================================
// Keyboard navigation
// ============================================================================

/**
 * Navigation keys, expressed as the gamepad buttons they stand for.
 *
 * Keyboard and gamepad navigation are the same operation, so they share one
 * router (`useInputRouter`) that dispatches by focused pane. This map used to
 * be a capture-phase `document` listener here that re-implemented that pane
 * dispatch — plan, overview and sessions branches inline — and gated it on
 * `state.currentScreen`, a concept the dock replaced.
 */
export const NAVIGATION_KEY_BUTTONS: Readonly<Record<string, string>> = Object.freeze({
  ArrowUp: 'DPadUp',
  ArrowDown: 'DPadDown',
  ArrowLeft: 'DPadLeft',
  ArrowRight: 'DPadRight',
  Enter: 'A',
  Escape: 'B',
  Delete: 'X',
  F5: 'Y',
});
