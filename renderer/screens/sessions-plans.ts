/**
 * Sessions screen — plans grid zone (3rd navigation zone below spawn).
 *
 * Shows configured working directories as compact buttons with plan badge counts.
 * Follows the same patterns as sessions-spawn.ts.
 */

import { sessionsState } from './sessions-state.js';
import { useNavigationStore } from '../stores/navigation.js';
import { isPaneVisible } from '../dock-visibility-bridge.js';
import { PANE_QUICK_SPAWN } from '../dock-types.js';
import { state } from '../state.js';
import { plansClient } from '../ipc/clients.js';
import { buildPlannerDirectories, buildPlannerDirectorySource } from './planner-directories.js';

// Circular import — safe: all usages are inside function bodies, not at module-evaluation time.
import { updateAllFocus } from './sessions.js';

export function getPlannerDirectories() {
  return buildPlannerDirectories(buildPlannerDirectorySource(sessionsState.directories, state.projects ?? []));
}

// ============================================================================
// Gamepad navigation — plans zone (2-column grid, same as spawn)
// ============================================================================

export function handlePlansZone(button: string, dir: string | null): void {
  // Read directory count from state — Vue owns the DOM so we can't rely on DOM button count.
  const plannerDirs = getPlannerDirectories();
  const total = plannerDirs.length;
  if (total === 0) return;

  const cols = 2;

  if (dir === 'up') {
    const newIndex = sessionsState.plansFocusIndex - cols;
    if (newIndex < 0) {
      // Skip to sessions if spawn is collapsed
      if (!isPaneVisible(PANE_QUICK_SPAWN)) {
        sessionsState.activeFocus = 'sessions';
        sessionsState.sessionsFocusIndex = Math.max(0, sessionsState.navList.length - 1);
        sessionsState.cardColumn = 0;
      } else {
        sessionsState.activeFocus = 'spawn';
        const spawnCount = sessionsState.cliTypes.length;
        sessionsState.spawnFocusIndex = Math.max(0, spawnCount - 1);
      }
      updateAllFocus();
      return;
    }
    sessionsState.plansFocusIndex = newIndex;
    updatePlansFocus();
    return;
  }
  if (dir === 'down') {
    const newIndex = sessionsState.plansFocusIndex + cols;
    if (newIndex < total) {
      sessionsState.plansFocusIndex = newIndex;
      updatePlansFocus();
    }
    return;
  }
  if (dir === 'left') {
    if (sessionsState.plansFocusIndex % cols > 0) {
      sessionsState.plansFocusIndex--;
      updatePlansFocus();
    }
    return;
  }
  if (dir === 'right') {
    if (sessionsState.plansFocusIndex % cols < cols - 1 && sessionsState.plansFocusIndex + 1 < total) {
      sessionsState.plansFocusIndex++;
      updatePlansFocus();
    }
    return;
  }
}

export function handlePlansZoneButton(button: string): boolean {
  switch (button) {
    case 'A': {
      // Read from state — Vue owns the DOM, so we can't rely on DOM button order.
      const dir = getPlannerDirectories()[sessionsState.plansFocusIndex];
      if (dir?.path) {
        void useNavigationStore().openPlan(dir.path);
      }
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

// ============================================================================
// Focus update
// ============================================================================

export function updatePlansFocus(): void {
  const grid = document.getElementById('plansGrid');
  if (!grid) return;
  grid.querySelectorAll('.plans-grid-btn').forEach((el, i) => {
    el.classList.toggle('focused', i === sessionsState.plansFocusIndex && sessionsState.activeFocus === 'plans');
  });
}

// ============================================================================
// Badge refresh
// ============================================================================

export async function refreshPlanBadges(): Promise<void> {
  for (const dir of getPlannerDirectories()) {
    try {
      const [startableItems, allItems] = await Promise.all([
        plansClient.planStartableForDir(dir.path),
        plansClient.planList(dir.path),
      ]);

      const items: Array<{ status: string }> = allItems ?? [];
      state.planDirStartableCounts.set(dir.path, (startableItems ?? []).length);
      state.planDirCodingCounts.set(dir.path, items.filter(p => p.status === 'coding').length);
      state.planDirBlockedCounts.set(dir.path, items.filter(p => p.status === 'blocked').length);
      state.planDirReviewCounts.set(dir.path, items.filter(p => p.status === 'review').length);
      state.planDirPlanningCounts.set(dir.path, items.filter(p => p.status === 'planning').length);
      state.planDirSuggestedCounts.set(dir.path, items.filter(p => p.status === 'suggested').length);
    } catch {
      // Silently ignore badge fetch errors
    }
  }
}
