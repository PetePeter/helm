/**
 * App bootstrap composable — replaces the init() sequence from legacy main.ts.
 *
 * Handles all framework-agnostic startup: config warming, IPC listener setup,
 * terminal manager creation, session loading, and auto-resume. Vue components
 * react to state changes automatically via the reactive() singletons.
 */

import { watch } from 'vue';
import { state, type Session } from '../state.js';
import { sessionsState } from '../screens/sessions-state.js';
import { setSessionCwdResolver } from '../stores/sessions-screen.js';
import { initConfigCache } from '../bindings.js';
import { browserGamepad } from '../gamepad.js';
import { setupGamepad, teardownGamepad } from './useGamepadBootstrap.js';
import { startTimerRefresh, stopTimerRefresh } from './useTimerRefresh.js';
import { useFlashAttention } from './useFlashAttention.js';
import { TerminalManager } from '../terminal/terminal-manager.js';
import { formatElapsed } from '../../src/utils/time-parser.js';
import { setTerminalManager, getTerminalManager } from '../runtime/terminal-provider.js';
import { setupKeyboardRelay } from '../paste-handler.js';
import { resolveNextTerminalId } from '../tab-cycling.js';
import { sortSessions, type SessionSortField, type SortDirection } from '../sort-logic.js';
import { findNavIndexBySessionId } from '../session-groups.js';

// Side-effect imports — modules that call registerView() at top level
import '../screens/group-overview.js';
import '../plans/plan-screen.js';
import '../screens/sessions-spawn.js';
import { setTerminalManagerGetter as setSpawnTerminalManagerGetter } from '../screens/sessions-spawn.js';
import { getTabCycleSessionIds, updateSessionsFocus } from '../screens/sessions.js';
import {
  artifactsClient,
  configClient,
  draftsClient,
  eventsClient,
  plansClient,
  projectsClient,
  sessionsClient,
  terminalClient,
} from '../ipc/clients.js';

// Overview/plan setup functions
import {
  setOutputBuffer, setSessionStateGetter, setActivityLevelGetter,
  setTerminalManagerGetter as setOverviewTerminalManagerGetter,
  setSelectCardCallback, setOverviewDismissCallback,
} from '../screens/group-overview.js';
import {
  setPlanScreenFitCallback, setPlanScreenCloseCallback,
  refreshCanvasIfVisible,
} from '../plans/plan-screen.js';

import { refreshPlanBadges } from '../screens/sessions-plans.js';
import { useChipBarStore } from '../stores/chip-bar.js';
import { useNavigationStore } from '../stores/navigation.js';
import { refreshProjects, type RendererProjectRecord } from '../projects-sync.js';
import { normalizeCmdInput } from '../utils/shell-command.js';
import { hasCaseInsensitivePaths } from '../utils/platform.js';

export { startTimerRefresh, stopTimerRefresh } from './useTimerRefresh.js';
// The project mirror is shared with the pop-out shell, which cannot import this
// module; re-exported here so existing bootstrap callers keep one import site.
export { refreshProjects };

// Sort preferences (module-level state to match legacy behaviour)
let sortField: SessionSortField = 'name';
let sortDirection: SortDirection = 'asc';

export function getSortField(): SessionSortField { return sortField; }
export function getSortDirection(): SortDirection { return sortDirection; }
export function setSortField(f: SessionSortField): void { sortField = f; }
export function setSortDirection(d: SortDirection): void { sortDirection = d; }

// ============================================================================
// Helpers
// ============================================================================

function getSessionState(sessionId: string): string {
  return state.sessionStates.get(sessionId) || 'idle';
}

function getSessionActivity(sessionId: string): string {
  return state.sessionActivityLevels.get(sessionId) ?? 'idle';
}

function getPersistedSessionCwd(sessionId: string): string {
  return state.sessions.find(session => session.id === sessionId)?.workingDir || '';
}

function getSessionCwd(sessionId: string): string {
  const tm = getTerminalManager();
  const terminalSession = tm?.getSession(sessionId);
  if (terminalSession?.cwd) return terminalSession.cwd;
  return getPersistedSessionCwd(sessionId);
}

function pathsMatch(a: string, b: string): boolean {
  if (hasCaseInsensitivePaths()) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function findProjectForPath(dirPath?: string): RendererProjectRecord | undefined {
  if (!dirPath) return undefined;
  return state.projects.find(project =>
    pathsMatch(project.canonicalPath, dirPath)
    || (project.alternatePaths ?? []).some(alt => pathsMatch(alt, dirPath)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function logEvent(event: string): void {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  state.eventLog.unshift({ time, event });
  if (state.eventLog.length > 50) state.eventLog.pop();
}

// ============================================================================
// Session data loading (data-only, no DOM manipulation)
// ============================================================================

let stopNavListWatch: (() => void) | null = null;

/**
 * Restore sidebar focus whenever the derived nav list changes shape.
 *
 * navList is a derivation now, so a rebuild can happen without any call site
 * knowing — this watcher is the single place focus is re-anchored, replacing
 * the hand-placed onNavListRebuilt() calls that each rebuild site used to own.
 */
export function watchNavListRebuild(
  onRebuilt: () => void = () => useNavigationStore().onNavListRebuilt(),
): () => void {
  // Keyed on the nav item sequence, not the array: the derivation produces a
  // fresh array on every session field change, and focus only moves when the
  // order or membership of the list actually changes.
  return watch(
    () => sessionsState.navList.map(item => `${item.type}:${item.id}`).join('|'),
    () => {
      try { onRebuilt(); } catch { /* store may not be initialized yet */ }
    },
  );
}

export async function refreshSessions(): Promise<void> {

  await initGroupPrefs();

  const nextSessions: Session[] = [];
  await refreshProjects();

  const tm = getTerminalManager();
  const manager = tm as (TerminalManager & {
    getManagedSessions?: () => Session[];
    hydrateFromStore?: () => Promise<Session[]>;
  }) | null;
  let managedSessions = manager?.getManagedSessions?.() ?? [];
  try {
    managedSessions = manager?.hydrateFromStore ? await manager.hydrateFromStore() : managedSessions;
  } catch (e) {
    console.error('[Bootstrap] Failed to hydrate terminal sessions:', e);
  }

  for (const managed of managedSessions) {
    const terminalSession = tm?.getSession(managed.id);
    const workingDir = terminalSession?.cwd || managed.workingDir || '';
    const resolvedProject = managed.projectPath ? undefined : findProjectForPath(workingDir);
    nextSessions.push({
      id: managed.id,
      name: terminalSession?.name || managed.name || managed.cliType,
      cliType: terminalSession?.cliType || managed.cliType,
      processId: managed.processId ?? 0,
      workingDir,
      projectId: managed.projectId || resolvedProject?.id,
      projectPath: managed.projectPath || resolvedProject?.canonicalPath,
      title: terminalSession?.title || managed.title,
      cliSessionName: managed.cliSessionName,
      windowId: managed.windowId,
      state: managed.state,
      aiagentState: managed.aiagentState,
      questionPending: managed.questionPending,
      currentPlanId: managed.currentPlanId,
      lastOutputAt: managed.lastOutputAt,
      createdAt: managed.createdAt,
      lastActiveAt: managed.lastActiveAt,
      createdByPeerId: managed.createdByPeerId,
      // Without this the card falls back to "unlocked" on every refresh, and
      // its toggle can then only ever ask to lock.
      locked: managed.locked,
      // Same trap for the mission bar: this refresh runs on every plan change.
      mission: managed.mission,
      missionBarHeight: managed.missionBarHeight,
    } as Session);

    const displayState = managed.aiagentState ?? managed.state;
    if (displayState) {
      state.sessionStates.set(managed.id, displayState);
    } else if (!state.sessionStates.has(managed.id)) {
      state.sessionStates.set(managed.id, 'idle');
    }

    if (!state.sessionActivityLevels.has(managed.id)) {
      state.sessionActivityLevels.set(managed.id, 'idle');
    }
  }

  // Update snapped-out tracking based on session windowId
  state.snappedOutSessions.clear();
  for (const session of nextSessions) {
    if (session.windowId !== undefined) {
      state.snappedOutSessions.add(session.id);
    }
  }

  state.sessions = sortSessions(
    nextSessions, sortField, sortDirection, getSessionState, getSessionCwd, getSessionActivity,
  );

  // groups/navList derive from state.sessions — see stores/sessions-screen.ts.

  try {
    sessionsState.cliTypes = await configClient.configGetCliTypes();
  } catch (e) { console.error('[Bootstrap] Failed to load CLI types:', e); }

  try {
    sessionsState.directories = (await configClient.configGetWorkingDirs()) || [];
  } catch (e) { console.error('[Bootstrap] Failed to load directories:', e); }

  // Clamp focus indices
  const activeIdx = state.activeSessionId
    ? findNavIndexBySessionId(sessionsState.navList, state.activeSessionId) : -1;
  sessionsState.sessionsFocusIndex = activeIdx >= 0
    ? activeIdx
    : clamp(sessionsState.sessionsFocusIndex, 0, Math.max(0, sessionsState.navList.length - 1));
  sessionsState.spawnFocusIndex = clamp(
    sessionsState.spawnFocusIndex, 0, Math.max(0, sessionsState.cliTypes.length - 1),
  );

  // Refresh draft counts
  await refreshDraftCounts();
  await refreshArtifactCounts();
  await refreshPlanCounts();
}

/** Refresh the per-session artifact-count cache that drives the card badges. */
async function refreshArtifactCounts(): Promise<void> {
  if (!artifactsClient.artifactCounts) return;
  try {
    const counts = await artifactsClient.artifactCounts();
    state.artifactCounts.clear();
    for (const [sessionId, n] of Object.entries(counts)) {
      if (n > 0) state.artifactCounts.set(sessionId, n);
    }
  } catch { /* ignore */ }
}

async function refreshDraftCounts(): Promise<void> {
  if (!draftsClient.draftList) return;
  try {
    const allDrafts = await draftsClient.draftList();
    state.draftCounts.clear();
    for (const draft of allDrafts) {
      const count = state.draftCounts.get(draft.sessionId) ?? 0;
      state.draftCounts.set(draft.sessionId, count + 1);
    }
  } catch { /* ignore */ }
}

async function refreshPlanCounts(): Promise<void> {
  if (!plansClient.planStartableForDir) return;
  state.planCodingCounts.clear();
  state.planStartableCounts.clear();
  state.planDirStartableCounts.clear();
  state.planDirCodingCounts.clear();
  state.planDirBlockedCounts.clear();
  state.planDirReviewCounts.clear();
  state.planDirPlanningCounts.clear();

  const countedDirs = new Map<string, number>();

  for (const session of state.sessions) {
    const cwd = getSessionCwd(session.id) || getPersistedSessionCwd(session.id);
    if (!cwd) continue;

    let startableCount = countedDirs.get(cwd);
    if (startableCount === undefined) {
      try {
        startableCount = (await plansClient.planStartableForDir(cwd)).length;
      } catch {
        startableCount = 0;
      }
      countedDirs.set(cwd, startableCount);
    }
    if (startableCount > 0) {
      state.planStartableCounts.set(session.id, startableCount);
    }

    try {
      const doing = await plansClient.planDoingForSession(session.id);
      if (doing.length > 0) state.planCodingCounts.set(session.id, doing.length);
      const plan = session.currentPlanId
        ? (doing.find((entry) => entry.id === session.currentPlanId) ?? doing[0])
        : doing[0];
      if (plan) {
        const prefix = plan.status === 'blocked' ? '⛔' : plan.status === 'review' ? '⏳' : '🗺️';
        const planRef = plan.humanId ? `${plan.humanId} · ${plan.title}` : plan.title;
        state.workingPlanLabels.set(session.id, `${prefix} ${planRef}`);
        state.workingPlanTooltips.set(session.id, plan.stateInfo ? `${planRef}\n${plan.stateInfo}` : planRef);
      } else {
        state.workingPlanLabels.delete(session.id);
        state.workingPlanTooltips.delete(session.id);
      }
    } catch {
      state.workingPlanLabels.delete(session.id);
      state.workingPlanTooltips.delete(session.id);
    }
  }

  // Populate all 5 planDir* Maps for every configured directory (active or not).
  await refreshPlanBadges();
}

// Group prefs
let groupPrefsLoaded = false;

async function initGroupPrefs(): Promise<void> {
  if (groupPrefsLoaded) return;
  try {
        const prefs = await configClient.configGetSessionGroupPrefs();
    if (prefs) {
      sessionsState.groupPrefs = {
        order: prefs.order ?? [],
        collapsed: prefs.collapsed ?? [],
        bookmarked: prefs.bookmarked ?? [],
        overviewHidden: prefs.overviewHidden ?? [],
      };
    }
  } catch (e) {
    console.error('[Bootstrap] Failed to load group prefs:', e);
  }
  groupPrefsLoaded = true;
}

// ============================================================================
// Spawn
// ============================================================================

let pendingContextText: string | null = null;

export function setPendingContextText(text: string | null): void {
  pendingContextText = text;
}

export async function doSpawn(
  cliType: string,
  workingDir?: string,
  contextText?: string,
  resumeSessionName?: string,
  sessionId?: string,
): Promise<boolean> {
  const resolvedContextText = resumeSessionName
    ? undefined
    : (contextText ?? pendingContextText ?? undefined);
  if (!resumeSessionName) pendingContextText = null;

  try {
    logEvent(`Spawning ${cliType}${workingDir ? ` in ${workingDir}` : ''}...`);
    if (!configClient.configGetSpawnCommand) {
      logEvent('Spawn failed: gamepadCli not available');
      return false;
    }

    const tm = getTerminalManager();
    if (!tm) return false;

    const spawnInfo = await configClient.configGetSpawnCommand(cliType);
    if (!spawnInfo) {
      logEvent(`Spawn failed: no command configured for ${cliType}`);
      return false;
    }

    const resolvedSessionId = sessionId || `pty-${cliType}-${Date.now()}`;
    const success = await tm.createTerminal(
      resolvedSessionId, cliType, spawnInfo.command, spawnInfo.args || [],
      workingDir, resolvedContextText, resumeSessionName,
    );

    if (success) {
      state.lastOutputTimes.set(resolvedSessionId, Date.now());
      logEvent(`Spawned embedded terminal: ${cliType}`);
      await useNavigationStore().navigateToSession(resolvedSessionId);

      setTimeout(async () => {
        try {
          await refreshSessions();
          const navStore = useNavigationStore();
          navStore.syncSidebarToSession(resolvedSessionId);
          sessionsState.activeFocus = 'sessions';
          await useChipBarStore().refresh(resolvedSessionId);
        } catch (e) { console.error('[Bootstrap] Post-spawn refresh failed:', e); }
      }, 300);
      return true;
    } else {
      logEvent(`Spawn FAILED: PTY creation returned false for ${cliType}`);
      return false;
    }
  } catch (error) {
    console.error('[Bootstrap] Failed to spawn session:', error);
    logEvent('Spawn failed');
    return false;
  }
}

export async function doSpawnShell(command: string): Promise<void> {
  try {
    const tm = getTerminalManager();
    if (!tm) return;

    const sessionId = `pty-shell-${Date.now()}`;
    // No initial command: resolvePtyShell() in the main process already opens
    // the platform's shell (cmd.exe on Windows, $SHELL -il on macOS/Linux).
    // Passing 'cmd.exe' here typed it as a COMMAND into that shell, which the
    // POSIX shell answered with "command not found". The real command is
    // written below, once the shell is ready.
    const success = await tm.createTerminal(sessionId, 'shell', '', [], undefined);

    if (success) {
      state.lastOutputTimes.set(sessionId, Date.now());
      logEvent('Spawned embedded shell terminal');
      await useNavigationStore().navigateToSession(sessionId);

      setTimeout(async () => {
        try {
          await terminalClient.ptyWrite(sessionId, normalizeCmdInput(command));
        } catch (e) { console.error('[Bootstrap] Failed to write command to shell:', e); }
      }, 300);

      setTimeout(async () => {
        try {
          await refreshSessions();
          const navStore = useNavigationStore();
          navStore.syncSidebarToSession(sessionId);
          sessionsState.activeFocus = 'sessions';
        } catch (e) { console.error('[Bootstrap] Post-shell-spawn refresh failed:', e); }
      }, 400);
    } else {
      logEvent('Spawn FAILED: PTY creation returned false for shell');
    }
  } catch (error) {
    console.error('[Bootstrap] Failed to spawn shell:', error);
    logEvent('Shell spawn failed');
  }
}

export async function switchToSession(sessionId: string): Promise<void> {
  const tm = getTerminalManager();
  if (tm && tm.hasTerminal(sessionId)) {
    useNavigationStore().activateSession(sessionId);
    return;
  }
  logEvent(`Session ${sessionId} is not an embedded terminal`);
}

function cleanupRendererSession(sessionId: string, detachTerminal = false): void {
  const tm = getTerminalManager();
  if (detachTerminal && tm?.hasTerminal(sessionId)) {
    tm.detachTerminal(sessionId);
  }
  tm?.removeManagedSession?.(sessionId);

  state.sessionStates.delete(sessionId);
  state.sessionActivityLevels.delete(sessionId);
  state.lastOutputTimes.delete(sessionId);
  state.draftCounts.delete(sessionId);
  state.artifactCounts.delete(sessionId);
  state.planCodingCounts.delete(sessionId);
  state.planStartableCounts.delete(sessionId);
  state.workingPlanLabels.delete(sessionId);
  state.workingPlanTooltips.delete(sessionId);
  state.pendingSchedules.delete(sessionId);
  state.snappedOutSessions.delete(sessionId);
  // Drop any pending flash so a closed/exited session leaves no lingering singleton entry.
  useFlashAttention().clear(sessionId);
}

/**
 * Close a session through the canonical main-process path. Returns true when the
 * session is confirmed gone (closed, or already "not found"), false on a real
 * failure — callers such as the runtime-group close-all flow rely on this to
 * abort before removing the group so a still-running member keeps its tag.
 */
export async function doCloseSession(sessionId: string): Promise<boolean> {
  try {
    const result = await sessionsClient.sessionClose(sessionId);
    if (!result?.success && result?.error !== 'Session not found') {
      console.error(`[Bootstrap] Failed to close session ${sessionId}:`, result?.error ?? 'unknown error');
      return false;
    }
  } catch (error) {
    console.error(`[Bootstrap] Failed to close session ${sessionId}:`, error);
    return false;
  }

  cleanupRendererSession(sessionId, true);
  await refreshSessions();
  return true;
}

export async function restoreSnappedBackSession(sessionId: string): Promise<void> {
  state.snappedOutSessions.delete(sessionId);

  try {
    await refreshSessions();
  } catch (error) {
    console.error('[Bootstrap] Failed to refresh sessions after snap-back:', error);
  }

  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) {
    console.warn(`[Bootstrap] Snap-back session ${sessionId} missing after refresh`);
    return;
  }

  const tm = getTerminalManager();
  if (!tm) return;

  if (!tm.has(sessionId)) {
    tm.adoptTerminal(sessionId, session.cliType, session.workingDir, session.name);
  }
  tm.switchTo(sessionId);
}

// ============================================================================
// IPC Listeners
// ============================================================================

function setupIpcListeners(): void {
  eventsClient.onPtyActivityChange((event) => {
    if (event.lastOutputAt !== undefined && event.lastOutputAt > 0) {
      state.lastOutputTimes.set(event.sessionId, event.lastOutputAt);
    }
    const previous = state.sessionActivityLevels.get(event.sessionId) ?? 'idle';
    if (previous !== event.level) {
      state.sessionActivityLevels.set(event.sessionId, event.level);
    }
  });

  eventsClient.onPtyExit((sessionId) => {
    cleanupRendererSession(sessionId, true);
    void refreshSessions();
  });

  // Keep the session-card artifact badges live.
  eventsClient.onArtifactChanged?.(() => { void refreshArtifactCounts(); });

  eventsClient.onNotificationClick((event) => {
    const session = state.sessions.find(s => s.id === event.sessionId);
    if (session) {
      sessionsClient.sessionSetActive?.(session.id);
      void useNavigationStore().navigateToSession(session.id);
    }
  });

  eventsClient.onSessionSpawned(async (session) => {
    const tm = getTerminalManager();
    if (!tm || tm.has(session.id)) return;
    console.log(`[ExternalSpawn] Adopting session: ${session.id} (${session.cliType})`);
    state.lastOutputTimes.set(session.id, session.lastOutputAt ?? Date.now());
    await configClient.configGetSpawnCommand(session.cliType);
    tm.adoptTerminal(session.id, session.cliType, session.workingDir, session.name);
    await refreshSessions();
  });

  eventsClient.onSessionUpdated?.((session) => {
    const idx = state.sessions.findIndex(existing => existing.id === session.id);
    if (idx !== -1) {
      state.sessions[idx] = { ...state.sessions[idx], ...session };
    }
    const displayState = session.aiagentState ?? session.state;
    if (displayState) {
      state.sessionStates.set(session.id, displayState);
    }
    if (session.lastOutputAt !== undefined) {
      state.lastOutputTimes.set(session.id, session.lastOutputAt);
    }
    if (session.windowId !== undefined) {
      state.snappedOutSessions.add(session.id);
    } else {
      state.snappedOutSessions.delete(session.id);
    }
  });

  // Plan change listener — debounced to coalesce rapid events
  if (eventsClient.onPlanChanged) {
    let planDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingPlanDirs = new Set<string>();
    eventsClient.onPlanChanged((dirPath: string) => {
      pendingPlanDirs.add(dirPath);
      if (planDebounceTimer) clearTimeout(planDebounceTimer);
      planDebounceTimer = setTimeout(() => {
        planDebounceTimer = null;
        const chipBarStore = useChipBarStore();
        void refreshSessions();
        void refreshCanvasIfVisible();
        const activeSessionId = state.activeSessionId;
        for (const dp of pendingPlanDirs) {
          if (activeSessionId && getSessionCwd(activeSessionId) === dp) {
            void chipBarStore.refresh(activeSessionId);
          }
        }
        pendingPlanDirs.clear();
      }, 50);
    });
  }

  // Pattern schedule listeners
  if (eventsClient.onPatternScheduleCreated) {
    eventsClient.onPatternScheduleCreated(({ sessionId, scheduledAt }) => {
      const formatted = new Date(scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      state.pendingSchedules.set(sessionId, formatted);
    });
  }
  if (eventsClient.onPatternScheduleFired) {
    eventsClient.onPatternScheduleFired(({ sessionId }) => {
      state.pendingSchedules.delete(sessionId);
    });
  }
  if (eventsClient.onPatternScheduleCancelled) {
    eventsClient.onPatternScheduleCancelled(({ sessionId }) => {
      state.pendingSchedules.delete(sessionId);
    });
  }
}

async function loadRepeatConfig(): Promise<void> {
  try {
    if (!configClient.configGetDpadConfig || !configClient.configGetStickConfig) return;
    const dpadConfig = await configClient.configGetDpadConfig();
    const leftStick = await configClient.configGetStickConfig('left');
    const rightStick = await configClient.configGetStickConfig('right');

    browserGamepad.setRepeatConfig({
      dpad: {
        initialDelay: dpadConfig?.initialDelay ?? 400,
        repeatRate: dpadConfig?.repeatRate ?? 120,
      },
      sticks: {
        left: { deadzone: leftStick?.deadzone ?? 0.25, repeatRate: leftStick?.repeatRate ?? 100 },
        right: { deadzone: rightStick?.deadzone ?? 0.25, repeatRate: rightStick?.repeatRate ?? 150 },
      },
    });
  } catch (error) {
    console.error('[Bootstrap] Failed to load repeat config:', error);
  }
}

// ============================================================================
// Session cycling
// ============================================================================

/**
 * Move the session spine one step in visual sidebar order.
 *
 * Sessions are the spine; terminal/overview/memories/artifacts/plans are
 * aspects onto whichever session is selected. Cycling therefore moves the
 * selection and deliberately leaves the focused pane alone, so you keep looking
 * at the same aspect of the next session.
 *
 * `activateSession` (not `navigateToSession`) is what preserves that: it swaps
 * the terminal and sidebar without dismissing the overlays a full navigation
 * would.
 */
export function cycleActiveSession(direction: 1 | -1): void {
  const tm = getTerminalManager();
  if (!tm) return;

  const nextId = resolveNextTerminalId(
    getTabCycleSessionIds(), tm.getSessionIds(), tm.getActiveSessionId(), direction,
  );
  if (!nextId) return;

  const navStore = useNavigationStore();
  navStore.activateSession(nextId);
  navStore.syncSidebarToSession(nextId);
}

// ============================================================================
// Main bootstrap
// ============================================================================

export interface BootstrapOptions {
  terminalContainer: HTMLElement;
  handleButton: (button: string) => void;
  handleRelease: (button: string) => void;
  onTerminalSwitch?: (sessionId: string | null) => void;
  onTerminalEmpty?: () => void;
  onTerminalTitleChange?: (sessionId: string, title: string) => void;
}

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  const {
    terminalContainer, handleButton, handleRelease,
    onTerminalSwitch, onTerminalEmpty, onTerminalTitleChange,
  } = opts;

  // Group resolution follows the live terminal cwd, not just the stored one.
  setSessionCwdResolver(getSessionCwd);
  stopNavListWatch?.();
  stopNavListWatch = watchNavListRebuild();

  // Config warmup
  try {
    await configClient.configGetAll();
  } catch (error) {
    console.warn('[Bootstrap] Failed to warm up config:', error);
  }

  // CLI types
  try {
    state.cliTypes = await configClient.configGetCliTypes();
    state.availableSpawnTypes = state.cliTypes;
  } catch (error) {
    console.error('[Bootstrap] Failed to load CLI types:', error);
  }

  // Config binding cache
  try { await initConfigCache(); }
  catch (error) { console.error('[Bootstrap] Failed to init config cache:', error); }

  // Gamepad repeat config
  await loadRepeatConfig();

  // Terminal manager
  const tm = new TerminalManager(terminalContainer);
  setTerminalManager(tm);
  setSpawnTerminalManagerGetter(() => tm); // wire sessions-spawn.ts getTerminalManager()

  if (onTerminalEmpty) tm.setOnEmpty(onTerminalEmpty);
  // Auto-select after a close follows the sidebar's visible order — the same
  // navList-derived list Ctrl+Tab and Ctrl+N use, so collapsed-group, hidden,
  // and snapped-out sessions are never picked.
  tm.setVisibleOrderProvider(getTabCycleSessionIds);
  if (onTerminalSwitch) {
    tm.setOnSwitch((sessionId) => {
      // Reconciliation only — don't call tm.switchTo (avoids re-entrancy).
      // state/sidebar/chipbar sync handled by the navigation store.
      onTerminalSwitch(sessionId ?? null);
    });
  }
  if (onTerminalTitleChange) {
    tm.setOnTitleChange((sessionId, title) => {
      const session = state.sessions.find(s => s.id === sessionId);
      if (session) session.title = title;
      onTerminalTitleChange(sessionId, title);
    });
  }

  // Overview + Plan screen dependencies
  setOverviewTerminalManagerGetter(() => tm);
  setOutputBuffer(tm.getOutputBuffer());
  setSessionStateGetter(getSessionState);
  setActivityLevelGetter(getSessionActivity);
  setSelectCardCallback((sessionId) => { void useNavigationStore().navigateToSession(sessionId); });
  setOverviewDismissCallback(() => updateSessionsFocus());
  setPlanScreenFitCallback(() => tm.fitActive());
  setPlanScreenCloseCallback(() => {
    const activeId = getTerminalManager()?.getActiveSessionId() ?? null;
    void useChipBarStore().refresh(activeId);
  });

  // IPC push listeners
  setupIpcListeners();

  // Gamepad
  setupGamepad(handleButton, handleRelease);

  // Auto-resume
  await autoResumeSessions(tm);

  // Load reconciled session state after resume attempts settle.
  await refreshSessions();

  // Timer refresh
  startTimerRefresh();

  logEvent('Helm ready');
  console.log('[Bootstrap] Ready');
}

async function autoResumeSessions(tm: TerminalManager): Promise<void> {
  try {
    const manager = tm as TerminalManager & {
      hydrateFromStore?: () => Promise<Session[]>;
      getManagedSessions?: () => Session[];
    };
    const restoredSessions = manager.hydrateFromStore
      ? await manager.hydrateFromStore()
      : (manager.getManagedSessions?.() ?? []);
    if (!restoredSessions || restoredSessions.length === 0) return;

    const terminalIds = new Set(tm.getSessionIds());
    for (const session of restoredSessions) {
      // Skip sessions that are snapped out to child windows
      if (session.windowId !== undefined) {
        state.snappedOutSessions.add(session.id);
        continue;
      }
      if (session.cliSessionName && !terminalIds.has(session.id)) {
        try {
          console.log(`[AutoResume] Resuming session: ${session.id} (${session.cliType}) with name ${session.cliSessionName}`);
          const resumed = await doSpawn(session.cliType, session.workingDir, undefined, session.cliSessionName, session.id);
          if (!resumed) {
            console.warn(`[AutoResume] Resume failed for session ${session.id}; keeping persisted entry visible`);
            continue;
          }
          terminalIds.add(session.id);
          if (session.name && session.name !== session.cliType) {
            await sessionsClient.sessionRename?.(session.id, session.name);
            tm.renameSession(session.id, session.name);
          }
        } catch (err) {
          console.error(`[AutoResume] Failed to resume session ${session.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[AutoResume] Failed:', err);
  }
}

// Cleanup
export function teardown(): void {
  stopNavListWatch?.();
  stopNavListWatch = null;
  stopTimerRefresh();
  const tm = getTerminalManager();
  tm?.dispose();
  teardownGamepad();
  setTerminalManager(null);
}
