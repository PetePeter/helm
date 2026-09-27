/**
 * Types for Directory Plans.
 * Per-directory acyclic directed graph of work items with dependency tracking.
 */

/** Lifecycle status of a plan item.
 * - planning: initial state, may be blocked by dependencies
 * - ready: all dependencies satisfied, ready for agent to pick up (computed state, not set directly)
 * - coding: agent is actively working on it
 * - review: awaiting human review before completion
 * - blocked: unable to proceed (requires mandatory stateInfo reason)
 * - done: completed (only reachable via plan_complete endpoint)
 */
export type PlanStatus = 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done';

/** Type classification for a plan item. */
export type PlanType = 'bug' | 'feature' | 'research';

/** What an operator task is following: the builder, the plan it works, what it waits on. */
export interface PlanTask {
  builderSessionId?: string;
  watchPlanId?: string;
  waitingOn?: string;
}

/** A single plan item (node in the DAG). */
export interface PlanItem {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Human-readable stable identifier for UI/MCP references (for example, P-0007). */
  humanId?: string;
  /** First-class owning project identity. */
  projectId?: string;
  /** Directory this plan belongs to */
  dirPath: string;
  /** Short title displayed on the node */
  title: string;
  /** Longer description / prompt content */
  description: string;
  /** Current lifecycle status */
  status: PlanStatus;
  /** Extra context for blocked/question states */
  stateInfo?: string;
  /** Documentation of what was accomplished when completing this plan (required by plan_complete) */
  completionNotes?: string;
  /** Type classification: bug, feature, or research */
  type?: PlanType;
  /** When true, unlocked follow-up work can be continued automatically after completion. */
  autoImplement?: boolean;
  /** When true, plan_complete runs a three-tier read gate before allowing completion. */
  completionRecap?: boolean;
  /** Optional first-class sequence/swimlane membership. */
  sequenceId?: string;
  /** Present when this plan is an operator task (see src/session/operator-tasks.ts). */
  task?: PlanTask;
  /** Session that has claimed this plan. Set by session_plan_claim. Cleared on done. */
  sessionId?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Timestamp when the current lifecycle status last changed. */
  stateUpdatedAt?: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** A dependency edge: fromId (blocker) must be done before toId (blocked) can start. */
export interface PlanDependency {
  /** The blocker item ID */
  fromId: string;
  /** The blocked item ID */
  toId: string;
}

/** A first-class wrapper for a larger mission spanning multiple plan nodes. */
export interface PlanSequence {
  /** Unique identifier (UUID v4). */
  id: string;
  /** First-class owning project identity. */
  projectId?: string;
  /** Directory this sequence belongs to. */
  dirPath: string;
  /** Short name displayed on the swimlane. */
  title: string;
  /** Stable mission statement for the sequence. */
  missionStatement: string;
  /** Shared notes/memory available to all member plans. */
  sharedMemory: string;
  /** Display order among sequences in the same directory. */
  order: number;
  /** Computed IDs of bound context nodes when returned by services/UI. */
  contextIds?: string[];
  /** Creation timestamp. */
  createdAt: number;
  /** Last update timestamp. */
  updatedAt: number;
}

/** All plan data for a single directory. */
export interface DirectoryPlan {
  dirPath: string;
  items: PlanItem[];
  dependencies: PlanDependency[];
  sequences?: PlanSequence[];
}

/**
 * Get the display title for a plan item with type prefix.
 * - If type is undefined, returns title unchanged.
 * - If title already starts with the appropriate prefix, no double-prefix.
 * - Otherwise, prepends [B], [F], or [R] based on type.
 */
export function getDisplayTitle(title: string, type?: PlanType): string {
  if (!type) return title;

  const prefixMap = { bug: '[B]', feature: '[F]', research: '[R]' };
  const prefix = prefixMap[type];

  // Check if already prefixed
  if (title.startsWith(prefix)) return title;

  return `${prefix} ${title}`;
}

/**
 * Compute whether a plan item is startable (all dependencies satisfied).
 * A plan is startable if:
 * - It has no blocking dependencies, OR
 * - All items it depends on are done
 *
 * Note: This is a computed property, not stored as a state.
 * The actual status should be 'ready' when isStartable returns true for non-active items.
 */
export function isStartable(item: PlanItem, allDeps: PlanDependency[], allItems: PlanItem[]): boolean {
  const blockers = allDeps
    .filter(d => d.toId === item.id)
    .map(d => allItems.find(x => x.id === d.fromId))
    .filter(Boolean);

  if (blockers.length === 0) return true;
  return blockers.every(b => b!.status === 'done');
}

/**
 * Filter preset for plan listing endpoints.
 * - all:       every item, including done
 * - active:    every non-done item (planning/ready/coding/review/blocked)
 * - startable: non-done items whose precursors are all done (or have none) — the
 *              dependency frontier, in any non-done state
 */
export type PlanFilter = 'all' | 'active' | 'startable';

/** Apply a {@link PlanFilter} preset to a set of plan items. */
export function filterPlanItems(
  items: PlanItem[],
  deps: PlanDependency[],
  filter: PlanFilter,
): PlanItem[] {
  switch (filter) {
    case 'all':
      return items;
    case 'active':
      return items.filter(i => i.status !== 'done');
    case 'startable':
      return items.filter(i => i.status !== 'done' && isStartable(i, deps, items));
  }
}
