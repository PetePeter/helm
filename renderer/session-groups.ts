/**
 * Session groups — pure grouping, flat nav list, and reorder logic.
 * No DOM, no side effects — easy to test.
 */

import type { Session } from './state.js';
import type { RuntimeGroup } from '../src/types/runtime-group.js';
import { hasCaseInsensitivePaths } from './utils/platform.js';
import { withoutOperator } from './operator-summary.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionGroup {
  /** Working directory path (grouping key). */
  dirPath: string;
  /** Display name for the group header (custom config name, or folder name extracted from path). */
  displayName: string;
  /** Sessions belonging to this group. */
  sessions: Session[];
  /** Whether this group is collapsed. */
  collapsed: boolean;
  /**
   * Group kind. 'directory' groups bucket sessions by working directory (the
   * legacy default). 'runtime' groups are ad-hoc, user-created groups that cut
   * across directories and persist as visible headers even when empty.
   */
  kind?: 'directory' | 'runtime';
  /** Runtime group id (only set when kind === 'runtime'). */
  groupId?: string;
}

/** 'operator' is the pinned Helm section — first in the list, outside every group. */
export type NavItemType = 'operator' | 'group-header' | 'session-card';

export interface NavItem {
  type: NavItemType;
  /** For group-header: dirPath. For session-card / operator: session id. */
  id: string;
  /** Index of the group this item belongs to (in the groups array); -1 for the operator. */
  groupIndex: number;
}

export type SessionPreviewMode = 'on' | 'off' | 'selected-only';
export const SESSION_PREVIEW_MODES: readonly SessionPreviewMode[] = ['on', 'selected-only', 'off'];

export interface SessionGroupPrefs {
  /** Working directory paths in display order. */
  order: string[];
  /** Working directory paths that are collapsed. */
  collapsed: string[];
  /** Bookmarked directory paths — persist as empty groups even with no sessions. */
  bookmarked?: string[];
  /** Stable session keys hidden from overview. Falls back to session id when unavailable. */
  overviewHidden?: string[];
  /** Session List PTY preview density. Absent = 'on'. */
  sessionPreviewMode?: SessionPreviewMode;
}

// ============================================================================
// Grouping
// ============================================================================

/**
 * Extract the display name (last path segment) from a directory path.
 * Handles both Windows backslash and Unix forward slash paths.
 */
export function dirDisplayName(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, '');
  const sep = trimmed.lastIndexOf('\\') !== -1 ? '\\' : '/';
  const last = trimmed.split(sep).pop();
  return last || dirPath;
}

/**
 * Path equality that respects the platform's filesystem case sensitivity.
 * Normalizes separator spelling from different sources (project store vs
 * session config). Lowercases both sides on Windows and macOS
 * (case-insensitive by default); exact casing is retained on Linux.
 */
export function pathsMatch(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/[\\/]+/g, '/');
  const left = normalize(a);
  const right = normalize(b);
  if (hasCaseInsensitivePaths()) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Resolve the best display name for a directory path.
 * Priority: project name > configured directory name > path tail.
 *
 * When a project owns more than one directory, the folder name of the matched
 * directory is appended ("Project - folder") so the otherwise-identical group
 * headers can be told apart. Single-directory projects show just the name.
 */
export function resolveGroupDisplayName(
  dirPath: string,
  directories: Array<{ name: string; path: string }>,
  projects?: Array<{ name: string; canonicalPath: string; alternatePaths: string[] }>,
): string {
  // Project identity is the durable owner. Directory labels are only fallback aliases.
  if (projects) {
    for (const project of projects) {
      const isCanonical = pathsMatch(project.canonicalPath, dirPath);
      const isAlternate = project.alternatePaths.some(alt => pathsMatch(alt, dirPath));
      if (!isCanonical && !isAlternate) continue;
      const dirCount = 1 + project.alternatePaths.length;
      return dirCount > 1 ? `${project.name} - ${dirDisplayName(dirPath)}` : project.name;
    }
  }

  const dirMatch = directories.find(d => pathsMatch(d.path, dirPath));
  if (dirMatch) return dirMatch.name;

  // 3. Fallback to last path segment
  return dirDisplayName(dirPath);
}

/**
 * Group sessions by working directory.
 *
 * Groups are ordered according to `prefs.order`. Directories not in the
 * order list are appended alphabetically at the end. Collapse state is
 * read from `prefs.collapsed`.
 *
 * @param sessions    All sessions to group.
 * @param getDir      Function to get the working directory for a session id.
 * @param prefs       Persisted group order and collapse state.
 */
export function groupSessionsByDirectory(
  sessions: Session[],
  getDir: (id: string) => string,
  prefs: SessionGroupPrefs = { order: [], collapsed: [] },
): SessionGroup[] {
  // Bucket sessions by directory
  const buckets = new Map<string, Session[]>();
  for (const session of sessions) {
    const dir = session.projectPath || getDir(session.id) || session.workingDir || '';
    if (!buckets.has(dir)) buckets.set(dir, []);
    buckets.get(dir)!.push(session);
  }

  // Include bookmarked dirs as empty buckets so they always appear
  for (const dir of prefs.bookmarked ?? []) {
    if (!buckets.has(dir)) buckets.set(dir, []);
  }

  // Build ordered list of dirPaths
  const orderedDirs: string[] = [];
  const seen = new Set<string>();

  // First: dirs from prefs.order that have sessions or are bookmarked
  for (const dir of prefs.order) {
    if (buckets.has(dir) && !seen.has(dir)) {
      orderedDirs.push(dir);
      seen.add(dir);
    }
  }

  // Then: remaining dirs alphabetically
  const remaining = [...buckets.keys()]
    .filter(d => !seen.has(d))
    .sort((a, b) => dirDisplayName(a).localeCompare(dirDisplayName(b)));
  orderedDirs.push(...remaining);

  const collapsedSet = new Set(prefs.collapsed);

  return orderedDirs.map(dir => ({
    dirPath: dir,
    displayName: dirDisplayName(dir),
    sessions: buckets.get(dir) || [],
    collapsed: collapsedSet.has(dir),
    kind: 'directory' as const,
  }));
}

/**
 * Build the full set of sidebar groups: runtime groups first, directory groups after.
 *
 * Runtime groups take exclusive ownership of their member sessions — any session
 * claimed by a runtime group is removed from directory grouping so it appears in
 * exactly one place. Runtime groups are kept even when empty (they persist as
 * visible, user-managed headers); directory groups only appear when non-empty
 * (or bookmarked, handled by groupSessionsByDirectory).
 *
 * @param sessions       All live sessions.
 * @param getDir         Resolve a session id to its working directory.
 * @param prefs          Directory group order/collapse/bookmark prefs.
 * @param runtimeGroups  Runtime groups in display order (array order preserved).
 *
 * The operator is never grouped: it has its own pinned sidebar section.
 */
export function buildSessionGroups(
  allSessions: Session[],
  getDir: (id: string) => string,
  prefs: SessionGroupPrefs,
  runtimeGroups: RuntimeGroup[],
): SessionGroup[] {
  const sessions = withoutOperator(allSessions);
  // Every session id owned by any runtime group — excluded from directory grouping.
  const claimed = new Set<string>();
  for (const rg of runtimeGroups) {
    for (const sid of rg.sessionIds) claimed.add(sid);
  }

  const byId = new Map<string, Session>();
  for (const session of sessions) byId.set(session.id, session);

  // Runtime groups first, preserving both group order and intra-group session order.
  const runtimeSessionGroups: SessionGroup[] = runtimeGroups.map(rg => {
    const members: Session[] = [];
    for (const sid of rg.sessionIds) {
      const session = byId.get(sid);
      if (session) members.push(session); // skip ids with no live session
    }
    return {
      dirPath: rg.id, // nav header id
      displayName: rg.name,
      sessions: members,
      collapsed: rg.collapsed,
      kind: 'runtime' as const,
      groupId: rg.id,
    };
  });

  // Directory groups exclude any claimed session.
  const directoryGroups = groupSessionsByDirectory(
    sessions.filter(s => !claimed.has(s.id)),
    getDir,
    prefs,
  );

  return [...runtimeSessionGroups, ...directoryGroups];
}

// ============================================================================
// Flat navigation list
// ============================================================================

/**
 * Build a flat navigation list from grouped sessions.
 * Includes the pinned operator (when there is one), then group headers and
 * (for expanded groups) their session cards.
 */
export function buildFlatNavList(groups: SessionGroup[], operatorId: string | null = null): NavItem[] {
  const items: NavItem[] = operatorId ? [{ type: 'operator', id: operatorId, groupIndex: -1 }] : [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    // Runtime groups persist as visible headers even when empty (so the UI can
    // show a placeholder + rename/close controls). Empty directory groups are skipped.
    if (group.sessions.length === 0 && group.kind !== 'runtime') continue;
    items.push({ type: 'group-header', id: group.dirPath, groupIndex: gi });
    if (!group.collapsed) {
      for (const session of group.sessions) {
        items.push({ type: 'session-card', id: session.id, groupIndex: gi });
      }
    }
  }
  return items;
}

export function getVisibleSessions(
  groups: SessionGroup[],
  prefs: SessionGroupPrefs = { order: [], collapsed: [] },
): Session[] {
  return groups.flatMap(group => group.sessions.filter(session => !isSessionHiddenFromOverview(session, prefs)));
}

export function getSessionOverviewKey(session: Session): string {
  return session.cliSessionName || session.id;
}

export function getSessionOverviewAliases(session: Session): string[] {
  const stableKey = getSessionOverviewKey(session);
  return stableKey === session.id ? [stableKey] : [stableKey, session.id];
}

export function isSessionHiddenFromOverview(
  session: Session,
  prefs: SessionGroupPrefs = { order: [], collapsed: [] },
): boolean {
  const hidden = new Set(prefs.overviewHidden ?? []);
  return getSessionOverviewAliases(session).some(key => hidden.has(key));
}

/**
 * Find the nav list index for a given session id.
 * Returns -1 if not found (e.g. in a collapsed group).
 */
export function findNavIndexBySessionId(navList: NavItem[], sessionId: string): number {
  return navList.findIndex(item => isSessionNavItem(item) && item.id === sessionId);
}

/** A nav item that stands for one session: a card, or the pinned operator. */
export function isSessionNavItem(item: NavItem): boolean {
  return item.type === 'session-card' || item.type === 'operator';
}

/** Identity-based sidebar cursor — survives navList reorders/rebuilds. */
export interface FocusedNavItem {
  id: string;
  type: string;
}

/**
 * Decide whether a sidebar nav item is the focused one.
 *
 * Renders the highlight from identity ({id,type}) rather than a stored numeric
 * index into navList. A numeric index silently points at the wrong card the
 * moment navList is reordered/rebuilt (activity re-sort, spawn, close), which
 * is what drifted the highlight away from the active terminal. Identity cannot
 * drift, so highlight and terminal stay in lockstep by construction.
 */
export function isNavItemFocused(
  activeFocus: string,
  focused: FocusedNavItem | null | undefined,
  type: string,
  id: string,
): boolean {
  return activeFocus === 'sessions' && !!focused && focused.type === type && focused.id === id;
}

// ============================================================================
// Group reordering
// ============================================================================

/**
 * Move a group up in the order. Returns a new order array.
 * No-op if already first.
 */
export function moveGroupUp(order: string[], dirPath: string): string[] {
  const idx = order.indexOf(dirPath);
  if (idx <= 0) return order;
  const next = [...order];
  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
  return next;
}

/**
 * Move a group down in the order. Returns a new order array.
 * No-op if already last.
 */
export function moveGroupDown(order: string[], dirPath: string): string[] {
  const idx = order.indexOf(dirPath);
  if (idx < 0 || idx >= order.length - 1) return order;
  const next = [...order];
  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
  return next;
}

/**
 * Toggle collapse state for a directory. Returns a new collapsed array.
 */
export function toggleCollapse(collapsed: string[], dirPath: string): string[] {
  return collapsed.includes(dirPath)
    ? collapsed.filter(d => d !== dirPath)
    : [...collapsed, dirPath];
}
