import { configClient } from '../ipc/clients.js';
/**
 * Sessions screen — spawn flow, PTY creation, and terminal area management.
 *
 * Extracted from sessions.ts. Depends on sessions.ts for orchestrator state and focus helpers.
 */

import { state } from '../state.js';
import { sessionsState } from './sessions-state.js';
import { logEvent } from '../utils.js';
import type { TerminalManager } from '../terminal/terminal-manager.js';
import { findNavIndexBySessionId, isSessionNavItem } from '../session-groups.js';

// Circular import — safe: all usages are inside function bodies, not at module-evaluation time.
import {
  loadSessions, refreshSessions, getSessionState, updateSessionsFocus, updateSpawnFocus, updateAllFocus,
} from './sessions.js';
import { getPlannerDirectories, refreshPlanBadges } from './sessions-plans.js';

import { hideOverview } from './group-overview.js';
import { registerView } from '../main-view/main-view-manager.js';
import { useNavigationStore } from '../stores/navigation.js';
import { isPaneVisible } from '../dock-visibility-bridge.js';
import { PANE_PLAN_DIRECTORIES, PANE_QUICK_SPAWN } from '../dock-types.js';

// Register the terminal view with the main-view manager. mount/unmount are
// no-ops because sessions-spawn owns the terminal container's display via
// showTerminalArea/hideTerminalArea; transitions FROM overview/plan trigger
// their unmount which already restores the terminal container.
registerView('terminal', {
  mount: () => {
    const termContainer = document.getElementById('terminalContainer');
    if (termContainer) termContainer.style.display = '';
  },
  unmount: () => { /* overview/plan mount handlers hide what they need */ },
});

// ============================================================================
// Bridge state (set by main.ts to avoid circular imports)
// ============================================================================

let dirPickerBridge: ((cliType: string, dirs: Array<{ name: string; path: string; projectId?: string; projectName?: string }>, preselectedPath?: string) => void) | null = null;

export function setDirPickerBridge(fn: (cliType: string, dirs: Array<{ name: string; path: string; projectId?: string; projectName?: string }>, preselectedPath?: string) => void): void {
  dirPickerBridge = fn;
}

let terminalManagerGetter: (() => TerminalManager | null) | null = null;

export function setTerminalManagerGetter(fn: () => TerminalManager | null): void {
  terminalManagerGetter = fn;
}

let pendingContextText: string | null = null;

export function setPendingContextText(text: string | null): void {
  pendingContextText = text;
}

/** Track last session switch time to debounce false activity from focus-induced PTY responses */
export let lastSwitchTime = 0;

// ============================================================================
// Helpers
// ============================================================================

/** Get the terminal manager instance (if available). */
export function getTerminalManager(): TerminalManager | null {
  return terminalManagerGetter ? terminalManagerGetter() : null;
}

export function getSessionCwd(sessionId: string): string {
  const tm = getTerminalManager();
  if (!tm) return '';
  const session = tm.getSession(sessionId);
  return session?.cwd || '';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// Spawn flow
// ============================================================================

/**
 * Spawn a session. Returns the created session id on success, or null on any
 * failure path (no spawn command, no config, PTY creation failed, exception) so
 * callers such as recycle-bin restore can act transactionally — e.g. only
 * re-attach a restored session to its runtime group once it actually spawned.
 */
export async function doSpawn(cliType: string, workingDir?: string, contextText?: string, resumeSessionName?: string, sessionId?: string): Promise<string | null> {
  // Resume spawns never use context text (it was one-time context for the original spawn)
  const resolvedContextText = resumeSessionName
    ? undefined
    : (contextText ?? pendingContextText ?? undefined);
  if (!resumeSessionName) pendingContextText = null;

  let spawnedId: string | null = null;
  try {
    logEvent(`Spawning ${cliType}${workingDir ? ` in ${workingDir}` : ''}...`);
    if (!configClient.configGetSpawnCommand) {
      logEvent('Spawn failed: gamepadCli not available');
      return null;
    }

    const tm = getTerminalManager();
    if (tm) {
      // Embedded terminal path — use PTY
      const spawnInfo = await configClient.configGetSpawnCommand(cliType);
      if (!spawnInfo) {
        logEvent(`Spawn failed: no command configured for ${cliType}`);
        return null;
      }

      const resolvedSessionId = sessionId || `pty-${cliType}-${Date.now()}`;
      const success = await tm.createTerminal(
        resolvedSessionId,
        cliType,
        spawnInfo.command,
        spawnInfo.args || [],
        workingDir,
        resolvedContextText,
        resumeSessionName,
      );

      if (success) {
        spawnedId = resolvedSessionId;
        logEvent(`Spawned embedded terminal: ${cliType}`);
        // Auto-select the new session through the shared navigation owner.
        await useNavigationStore().navigateToSession(resolvedSessionId);

        setTimeout(async () => {
          try {
            await loadSessions();
            await refreshPlanBadges();
            // Focus the newly spawned session in the navList
            const newIndex = findNavIndexBySessionId(sessionsState.navList, resolvedSessionId);
            if (newIndex >= 0) {
              sessionsState.sessionsFocusIndex = newIndex;
              sessionsState.activeFocus = 'sessions';
              sessionsState.cardColumn = 0;
              updateSessionsFocus();
            }
          } catch (e) { console.error('[Sessions] Post-spawn refresh failed:', e); }
        }, 300);
      } else {
        logEvent(`Spawn FAILED: PTY creation returned false for ${cliType}`);
        console.error(`[doSpawn] PTY creation failed — likely node-pty native module issue`);
      }
    }
  } catch (error) {
    console.error('[Sessions] Failed to spawn session:', error);
    logEvent('Spawn failed');
  }
  return spawnedId;
}

// ============================================================================
// Terminal area visibility
// ============================================================================

export function showTerminalArea(): void {
  // Dismiss overview if it's showing — terminal takes priority
  hideOverview();

  const termContainer = document.getElementById('terminalContainer');
  if (termContainer) termContainer.style.display = '';
  const tm = getTerminalManager();
  if (tm) {
    requestAnimationFrame(() => {
      tm.focusActive();
      tm.fitActive();
    });
  }
}

export function hideTerminalArea(): void {
  const termContainer = document.getElementById('terminalContainer');
  if (termContainer) termContainer.style.display = 'none';
}

export async function spawnNewSession(cliType?: string, preselectedPath?: string): Promise<void> {
  const resolvedType = cliType || state.availableSpawnTypes[0] || 'generic-terminal';

  try {
    if (!configClient.configGetWorkingDirs) {
      logEvent('Spawn failed: gamepadCli not available');
      return;
    }
    const dirs = await configClient.configGetWorkingDirs();
    if (dirs && dirs.length > 0 && dirPickerBridge) {
      // pendingContextText survives through dirPicker — doSpawn consumes it
      dirPickerBridge(resolvedType, dirs, preselectedPath);
      return;
    }
    await doSpawn(resolvedType);
  } catch (error) {
    console.error('Spawn error:', error);
    logEvent(`Spawn error: ${error}`);
  }
}

// ============================================================================
// Terminal session switching
// ============================================================================

export async function switchToSession(sessionId: string): Promise<void> {
  // Route through the navigation store for consistent state management
  await useNavigationStore().navigateToSession(sessionId);
}

/** Auto-switch terminal based on what the D-pad just focused. */
export function autoSelectFocusedSession(): void {
  const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
  if (!navItem || !isSessionNavItem(navItem)) return;

  const session = state.sessions.find(s => s.id === navItem.id);
  if (!session) return;
  const navStore = useNavigationStore();
  navStore.activateSession(session.id);
  navStore.syncSidebarToSession(session.id);
}

// ============================================================================
// Gamepad navigation — sessions zone + spawn zone
// ============================================================================

export function handleSessionsZone(button: string, dir: string | null): void {
  const navList = sessionsState.navList;
  const count = navList.length;

  if (dir === 'right') {
    if (count === 0) return;
    const currentItem = navList[sessionsState.sessionsFocusIndex];
    // Right at col=0 on a group-header → drill into its overview
    if (currentItem?.type === 'group-header' && sessionsState.cardColumn === 0) {
      void useNavigationStore().openOverview(currentItem.id, state.activeSessionId ?? undefined);
      return;
    }
    const maxColumn = currentItem?.type === 'session-card'
      ? 5
      : currentItem?.type === 'group-header'
        ? 0
        : 0;
    if (sessionsState.cardColumn < maxColumn) {
      sessionsState.cardColumn = (sessionsState.cardColumn + 1) as 0 | 1 | 2 | 3 | 4 | 5;
      updateSessionsFocus();
    }
    return;
  }
  if (dir === 'left') {
    if (sessionsState.cardColumn > 0) {
      sessionsState.cardColumn = (sessionsState.cardColumn - 1) as 0 | 1 | 2 | 3 | 4 | 5;
      updateSessionsFocus();
    }
    return;
  }

  if (dir === 'up') {
    if (count === 0) return;
    if (sessionsState.cardColumn > 0) return; // no-op when on action buttons
    sessionsState.sessionsFocusIndex = Math.max(0, sessionsState.sessionsFocusIndex - 1);
    sessionsState.cardColumn = 0;
    updateSessionsFocus();
    autoSelectFocusedSession();
    return;
  }
  if (dir === 'down') {
    if (sessionsState.cardColumn > 0) return; // no-op when on action buttons
    if (count === 0 || sessionsState.sessionsFocusIndex >= count - 1) {
      // Skip collapsed zones
      if (isPaneVisible(PANE_QUICK_SPAWN)) {
        sessionsState.activeFocus = 'spawn';
        sessionsState.spawnFocusIndex = 0;
        sessionsState.cardColumn = 0;
        updateAllFocus();
        return;
      }
      if (isPaneVisible(PANE_PLAN_DIRECTORIES) && getPlannerDirectories().length > 0) {
        sessionsState.activeFocus = 'plans';
        sessionsState.plansFocusIndex = 0;
        sessionsState.cardColumn = 0;
        updateAllFocus();
        return;
      }
      // Both collapsed or no plans — stay put
      return;
    }
    sessionsState.sessionsFocusIndex++;
    sessionsState.cardColumn = 0;
    updateSessionsFocus();
    autoSelectFocusedSession();
    return;
  }
}

export function handleSpawnZone(button: string, dir: string | null): void {
  // If spawn is collapsed, redirect to adjacent zones
  if (!isPaneVisible(PANE_QUICK_SPAWN)) {
    if (dir === 'up') {
      sessionsState.activeFocus = 'sessions';
      sessionsState.sessionsFocusIndex = Math.max(0, sessionsState.navList.length - 1);
      sessionsState.cardColumn = 0;
      updateAllFocus();
    } else if (dir === 'down' && isPaneVisible(PANE_PLAN_DIRECTORIES) && getPlannerDirectories().length > 0) {
      sessionsState.activeFocus = 'plans';
      sessionsState.plansFocusIndex = 0;
      updateAllFocus();
    }
    return;
  }

  const count = sessionsState.cliTypes.length;
  const cols = 2;

  if (dir === 'up') {
    const newIndex = sessionsState.spawnFocusIndex - cols;
    if (newIndex < 0) {
      sessionsState.activeFocus = 'sessions';
      sessionsState.sessionsFocusIndex = Math.max(0, sessionsState.navList.length - 1);
      sessionsState.cardColumn = 0;
      updateAllFocus();
      return;
    }
    sessionsState.spawnFocusIndex = newIndex;
    updateSpawnFocus();
    return;
  }
  if (dir === 'down') {
    const newIndex = sessionsState.spawnFocusIndex + cols;
    if (newIndex < count) {
      sessionsState.spawnFocusIndex = newIndex;
      updateSpawnFocus();
    } else if (isPaneVisible(PANE_PLAN_DIRECTORIES) && getPlannerDirectories().length > 0) {
      sessionsState.activeFocus = 'plans';
      sessionsState.plansFocusIndex = 0;
      updateAllFocus();
    }
    return;
  }
  if (dir === 'left') {
    if (sessionsState.spawnFocusIndex % cols > 0) {
      sessionsState.spawnFocusIndex--;
      updateSpawnFocus();
    }
    return;
  }
  if (dir === 'right') {
    if (sessionsState.spawnFocusIndex % cols < cols - 1 && sessionsState.spawnFocusIndex + 1 < count) {
      sessionsState.spawnFocusIndex++;
      updateSpawnFocus();
    }
    return;
  }
}

export function handleSpawnZoneButton(button: string): boolean {
  switch (button) {
    case 'A': {
      const cliType = sessionsState.cliTypes[sessionsState.spawnFocusIndex];
      if (cliType) spawnNewSession(cliType);
      return true;
    }
    case 'B':
      sessionsState.activeFocus = 'sessions';
      updateAllFocus();
      return true;
    default:
      return false;
  }
}
