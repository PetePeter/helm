import type { NavItem } from '../session-groups.js';

const SLOT_COUNT = 10;

/**
 * Single source of truth for session display ordering.
 *
 * Returns session-card IDs in navList order, excluding snapped-out sessions.
 * Collapsed-group sessions are naturally absent from navList and
 * thus excluded — they become reachable when the group is expanded.
 *
 * Used by both Ctrl+N slot assignment (buildSessionShortcutMap) and Ctrl+Tab
 * cycling (getTabCycleSessionIds) to guarantee identical ordering.
 */
export function getOrderedSessionIds(
  navList: NavItem[],
  snappedOutSessionIds: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const item of navList) {
    if (item.type !== 'session-card') continue;
    if (snappedOutSessionIds.has(item.id)) continue;
    ids.push(item.id);
  }
  return ids;
}

/**
 * Maps visible session IDs in navList display order to their Ctrl+N slot.
 * Slots 1–9 → Ctrl+1..9; slot 0 → Ctrl+0 (position 10).
 * Skips non-session-card and snapped-out sessions.
 * Delegates filtering to getOrderedSessionIds for a single ordering source.
 */
export function buildSessionShortcutMap(
  navList: NavItem[],
  snappedOutSessionIds: Set<string>,
): Map<string, number> {
  const ordered = getOrderedSessionIds(navList, snappedOutSessionIds);
  const map = new Map<string, number>();

  for (let pos = 0; pos < Math.min(ordered.length, SLOT_COUNT); pos++) {
    map.set(ordered[pos], pos < 9 ? pos + 1 : 0);
  }

  return map;
}
