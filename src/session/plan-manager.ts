/**
 * PlanManager — Per-directory acyclic directed graph of work items.
 * CRUD, dependency management, cycle prevention, startable computation.
 * Persists to individual config/plans/*.json files + config/plan-dependencies.json.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import {
  savePlanFile,
  deletePlanFile,
  listPlanFiles,
  loadPlanFile,
  saveDependencies,
  cleanupOrphanDependencies,
  loadPlanSequences,
  savePlanSequences,
} from './persistence.js';
import type { PlanItem, PlanDependency, DirectoryPlan, PlanStatus, PlanType, PlanSequence } from '../types/plan.js';
import { isStartable } from '../types/plan.js';
import type { ProjectStore } from './project-store.js';

const CURRENT_PLAN_STATUSES = new Set<PlanStatus>(['planning', 'ready', 'coding', 'review', 'blocked', 'done']);
const ACTIVE_PLAN_STATUSES = new Set<PlanStatus>(['coding', 'review', 'blocked']);
const PAUSED_PLAN_STATUSES = new Set<PlanStatus>(['review', 'blocked']);
const HUMAN_ID_RE = /^P-(\d+)$/;

export type PlanRefResolution =
  | { status: 'found'; item: PlanItem }
  | { status: 'ambiguous'; matches: PlanItem[] }
  | { status: 'missing' };

function formatHumanId(value: number): string {
  return `P-${String(value).padStart(4, '0')}`;
}

function normalizeHumanId(ref: string): string | null {
  const match = ref.trim().toUpperCase().match(HUMAN_ID_RE);
  if (!match) return null;
  const numeric = match[1].replace(/^0+/, '') || '0';
  return `P-${numeric}`;
}

export class PlanManager extends EventEmitter {
  private items = new Map<string, PlanItem>();
  private dependencies: PlanDependency[] = [];
  private sequences = new Map<string, PlanSequence>();
  private nextHumanId = 1;

  constructor(private readonly projectStore?: ProjectStore) {
    super();
    this.loadFromDisk();
  }

  /** Load all plan items and dependencies from disk on startup.
   * Migrates old plan statuses to new ones on load.
   */
  private loadFromDisk(): void {
    const filenames = listPlanFiles();
    const loaded: PlanItem[] = [];
    for (const filename of filenames) {
      const item = loadPlanFile(filename);
      if (!item) continue;

      // Migrate old statuses to new ones
      const migrated = this.migrateOldStatus(item.status, item.stateInfo);
      item.status = migrated.status;
      if (migrated.stateInfo && !item.stateInfo) {
        item.stateInfo = migrated.stateInfo;
      }

      loaded.push(item);
      this.noteHumanId(item.humanId);
      this.items.set(item.id, item);
    }

    let rewritten = 0;
    for (const item of loaded) {
      // Statuses were already migrated in the load pass above; this pass only
      // backfills missing metadata (human IDs, project links, timestamps).
      if (this.ensurePlanMetadata(item)) {
        savePlanFile(item);
        rewritten++;
      }
    }

    const validIds = new Set(this.items.keys());
    const { deps: cleanedDeps } = cleanupOrphanDependencies(validIds);
    this.dependencies = cleanedDeps;
    let sequencesChanged = false;
    for (const sequence of loadPlanSequences()) {
      sequencesChanged = this.ensureSequenceProject(sequence) || sequencesChanged;
      this.sequences.set(sequence.id, sequence);
    }
    this.cleanupOrphanSequenceMemberships();
    if (sequencesChanged) {
      savePlanSequences([...this.sequences.values()]);
    }

    const dirs = new Set<string>();
    for (const item of this.items.values()) dirs.add(item.dirPath);
    for (const dirPath of dirs) this.recomputeStartable(dirPath);

    if (rewritten > 0) {
      logger.info(`[PlanManager] Loaded ${this.items.size} plan(s) from disk, rewrote ${rewritten} with backfilled metadata`);
    } else {
      logger.info(`[PlanManager] Loaded ${this.items.size} plan(s) from disk`);
    }
  }

  /** Save all items for a directory + the dependency list.
   *  @param options.skipSequences Skip writing sequences file (for dep-only/status-only changes).
   */
  private saveDir(dirPath: string, options?: { skipSequences?: boolean }): void {
    for (const item of this.getForDirectory(dirPath)) savePlanFile(item);
    saveDependencies(this.dependencies);
    if (!options?.skipSequences) {
      savePlanSequences([...this.sequences.values()]);
    }
    this.projectStore?.save();
  }

  /** Create a new plan item. New items start as 'planning', transition to 'ready' when deps satisfied. */
  create(dirPath: string, title: string, description: string): PlanItem {
    return this.createWithType(dirPath, title, description, undefined);
  }

  /** Create a new plan item with optional type. New items start as 'planning', transition to 'ready' when deps satisfied. */
  createWithType(dirPath: string, title: string, description: string, type?: PlanType, autoImplement?: boolean, completionRecap?: boolean): PlanItem {
    const now = Date.now();
    const item: PlanItem = {
      id: randomUUID(),
      humanId: this.allocateHumanId(),
      ...(this.projectStore ? { projectId: this.projectStore.resolveForPath(dirPath).id } : {}),
      dirPath,
      title,
      description,
      status: 'planning',
      type,
      autoImplement: autoImplement ? true : undefined,
      completionRecap: completionRecap ? true : undefined,
      createdAt: now,
      stateUpdatedAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    savePlanFile(item);

    // Recompute startable for the new item and any dependents
    // This transitions no-dep items to 'ready' immediately
    this.recomputeStartable(dirPath);
    savePlanFile(item);

    this.emit('plan:changed', dirPath);
    logger.info(`[PlanManager] Created plan "${title}" in ${dirPath}`);
    return item;
  }

  /** Update an existing plan item's title and/or description. */
  update(id: string, updates: { title?: string; description?: string }): PlanItem | null {
    return this.updateWithType(id, updates);
  }

  /** Update an existing plan item's title, description, and/or type. */
  updateWithType(id: string, updates: { title?: string; description?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean }): PlanItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    if (updates.title !== undefined) item.title = updates.title;
    if (updates.description !== undefined) item.description = updates.description;
    if (Object.prototype.hasOwnProperty.call(updates, 'type')) {
      item.type = updates.type;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'autoImplement')) {
      item.autoImplement = updates.autoImplement ? true : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'completionRecap')) {
      item.completionRecap = updates.completionRecap ? true : undefined;
    }
    item.updatedAt = Date.now();

    savePlanFile(item);
    this.emit('plan:changed', item.dirPath);
    logger.info(`[PlanManager] Updated plan ${id}`);
    return item;
  }

  /** Create a first-class sequence/swimlane for a directory. */
  createSequence(dirPath: string, title: string, missionStatement = '', sharedMemory = ''): PlanSequence {
    const now = Date.now();
    const existing = this.getSequencesForDirectory(dirPath);
    const sequence: PlanSequence = {
      id: randomUUID(),
      ...(this.projectStore ? { projectId: this.projectStore.resolveForPath(dirPath).id } : {}),
      dirPath,
      title,
      missionStatement,
      sharedMemory,
      order: existing.length,
      createdAt: now,
      updatedAt: now,
    };
    this.sequences.set(sequence.id, sequence);
    savePlanSequences([...this.sequences.values()]);
    this.emit('plan:changed', dirPath);
    logger.info(`[PlanManager] Created plan sequence "${title}" in ${dirPath}`);
    return sequence;
  }

  /** Get all sequences for a directory. */
  getSequencesForDirectory(dirPath: string): PlanSequence[] {
    const projectId = this.resolveProjectId(dirPath);
    return [...this.sequences.values()]
      .filter((sequence) => {
        if (projectId && sequence.projectId) return sequence.projectId === projectId;
        return sequence.dirPath === dirPath;
      })
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.title.localeCompare(b.title));
  }

  /** Get one sequence by ID. */
  getSequence(id: string): PlanSequence | null {
    return this.sequences.get(id) ?? null;
  }

  /** Update sequence display text and shared memory. */
  updateSequence(
    id: string,
    updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number },
  ): PlanSequence | null {
    const sequence = this.sequences.get(id);
    if (!sequence) return null;
    if (updates.title !== undefined) sequence.title = updates.title;
    if (updates.missionStatement !== undefined) sequence.missionStatement = updates.missionStatement;
    if (updates.sharedMemory !== undefined) sequence.sharedMemory = updates.sharedMemory;
    if (updates.order !== undefined) sequence.order = updates.order;
    sequence.updatedAt = Date.now();
    savePlanSequences([...this.sequences.values()]);
    this.emit('plan:changed', sequence.dirPath);
    logger.info(`[PlanManager] Updated plan sequence ${id}`);
    return sequence;
  }

  /** Delete a sequence and clear membership from its member plans. */
  deleteSequence(id: string): boolean {
    const sequence = this.sequences.get(id);
    if (!sequence) return false;
    this.sequences.delete(id);
    for (const item of this.items.values()) {
      if (item.sequenceId === id) {
        item.sequenceId = undefined;
        item.updatedAt = Date.now();
        savePlanFile(item);
      }
    }
    savePlanSequences([...this.sequences.values()]);
    this.emit('plan:changed', sequence.dirPath);
    logger.info(`[PlanManager] Deleted plan sequence ${id}`);
    return true;
  }

  /** Delete a sequence and hard-delete all its member plan items. */
  deleteSequenceWithPlans(id: string): boolean {
    const sequence = this.sequences.get(id);
    if (!sequence) return false;
    const memberIds = [...this.items.values()]
      .filter((p) => p.sequenceId === id)
      .map((p) => p.id);
    for (const planId of memberIds) {
      this.delete(planId);
    }
    return this.deleteSequence(id);
  }

  /** Assign or unassign a plan to a sequence in the same directory. */
  assignSequence(planId: string, sequenceId: string | null): PlanItem | null {
    const item = this.items.get(planId);
    if (!item) return null;
    if (sequenceId) {
      const sequence = this.sequences.get(sequenceId);
      if (!sequence || !this.areInSameProject(item, sequence)) return null;
      item.sequenceId = sequenceId;
    } else {
      item.sequenceId = undefined;
    }
    item.updatedAt = Date.now();
    savePlanFile(item);
    this.emit('plan:changed', item.dirPath);
    return item;
  }

  /** Bulk-assign multiple plans to a sequence (or unassign with null). Returns count of updated plans. */
  bulkAssignSequence(planIds: string[], sequenceId: string | null): number {
    if (planIds.length === 0) return 0;
    let count = 0;
    const dirPath = this.items.get(planIds[0])?.dirPath;
    if (!dirPath) return 0;

    for (const planId of planIds) {
      const item = this.items.get(planId);
      if (!item || item.dirPath !== dirPath) continue;
      if (sequenceId) {
        const sequence = this.sequences.get(sequenceId);
        if (!sequence || !this.areInSameProject(item, sequence)) continue;
        item.sequenceId = sequenceId;
      } else {
        item.sequenceId = undefined;
      }
      item.updatedAt = Date.now();
      savePlanFile(item);
      count++;
    }

    if (count > 0) {
      this.emit('plan:changed', dirPath);
    }
    return count;
  }

  /** Delete a plan item and all its edges. Recomputes startable for affected items. */
  delete(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;

    const dirPath = item.dirPath;
    const incoming = this.dependencies.filter(d => d.toId === id);
    const outgoing = this.dependencies.filter(d => d.fromId === id);
    deletePlanFile(id);
    this.items.delete(id);
    this.dependencies = this.dependencies.filter(d => d.fromId !== id && d.toId !== id);
    let rewired = 0;
    for (const parent of incoming) {
      for (const child of outgoing) {
        if (this.canAddDependency(parent.fromId, child.toId)) {
          this.dependencies.push({ fromId: parent.fromId, toId: child.toId });
          rewired++;
        }
      }
    }
    this.recomputeStartable(dirPath);
    this.saveDir(dirPath);
    this.emit('plan:changed', dirPath);
    logger.info(`[PlanManager] Deleted plan ${id}; rewired ${rewired} dependency link(s)`);
    return true;
  }

  /** Delete all completed (done) plan items for a directory. Returns count deleted. */
  deleteCompletedForDirectory(dirPath: string): number {
    const doneItems = this.getForDirectory(dirPath).filter(i => i.status === 'done');
    for (const item of doneItems) this.delete(item.id);
    if (doneItems.length > 0) {
      logger.info(`[PlanManager] Cleared ${doneItems.length} completed plan(s) in ${dirPath}`);
    }
    return doneItems.length;
  }

  /** Get all plan items owned by a project. */
  getForProject(projectId: string): PlanItem[] {
    return [...this.items.values()].filter((item) => item.projectId === projectId);
  }

  /** Delete all plan items and sequences owned by a project. */
  deleteForProject(projectId: string): { plansDeleted: number; sequencesDeleted: number; planIds: string[]; sequenceIds: string[]; dirPaths: string[] } {
    const items = this.getForProject(projectId);
    const planIds = items.map((item) => item.id);
    const planIdSet = new Set(planIds);
    const dirPaths = [...new Set(items.map((item) => item.dirPath))];
    const sequenceIds = new Set(
      [...this.sequences.values()]
        .filter((sequence) => sequence.projectId === projectId)
        .map((sequence) => sequence.id),
    );

    for (const planId of planIds) {
      deletePlanFile(planId);
      this.items.delete(planId);
    }

    for (const sequenceId of sequenceIds) {
      this.sequences.delete(sequenceId);
    }

    for (const item of this.items.values()) {
      if (item.sequenceId && sequenceIds.has(item.sequenceId)) {
        item.sequenceId = undefined;
        item.updatedAt = Date.now();
        savePlanFile(item);
      }
    }

    this.dependencies = this.dependencies.filter((dep) => !planIdSet.has(dep.fromId) && !planIdSet.has(dep.toId));
    saveDependencies(this.dependencies);
    savePlanSequences([...this.sequences.values()]);

    for (const dirPath of dirPaths) {
      this.emit('plan:changed', dirPath);
    }
    if (items.length > 0 || sequenceIds.size > 0) {
      logger.info(`[PlanManager] Deleted ${items.length} plan(s) and ${sequenceIds.size} sequence(s) for project ${projectId}`);
    }
    return { plansDeleted: items.length, sequencesDeleted: sequenceIds.size, planIds, sequenceIds: [...sequenceIds], dirPaths };
  }

  /** Get a single plan item by ID. */
  getItem(id: string): PlanItem | null {
    return this.items.get(id) ?? null;
  }

  /** Resolve either a canonical UUID plan ID or a human-readable P-00xx plan ID. */
  resolveItemRef(ref: string): PlanRefResolution {
    const direct = this.items.get(ref);
    if (direct) return { status: 'found', item: direct };

    const normalizedRef = normalizeHumanId(ref);
    if (!normalizedRef) return { status: 'missing' };

    const matches = [...this.items.values()].filter((item) => normalizeHumanId(item.humanId ?? '') === normalizedRef);
    if (matches.length === 1) return { status: 'found', item: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    return { status: 'missing' };
  }

  /** Get all plan items for a directory. */
  getForDirectory(dirPath: string): PlanItem[] {
    const projectId = this.resolveProjectId(dirPath);
    return [...this.items.values()].filter((item) => {
      if (projectId && item.projectId) return item.projectId === projectId;
      return item.dirPath === dirPath;
    });
  }

  /** Get all directories that currently have plans. */
  getAllPlanDirectories(): string[] {
    return [...new Set([...this.items.values()].map((item) => item.dirPath))];
  }

  /** Get startable items for a directory (computed: items with status 'ready' or items where dependencies are all done). */
  getStartableForDirectory(dirPath: string): PlanItem[] {
    const items = this.getForDirectory(dirPath);
    return items.filter(i => {
      // Only non-active items can be startable
      if (ACTIVE_PLAN_STATUSES.has(i.status) || i.status === 'done' || i.status === 'blocked') return false;
      return isStartable(i, this.dependencies, items);
    });
  }

  /** Get all active plan items for a directory across every session. */
  getAllDoingForDirectory(dirPath: string): PlanItem[] {
    return this.getForDirectory(dirPath).filter(i => ACTIVE_PLAN_STATUSES.has(i.status));
  }

  /** Get active plan items claimed by a specific session. */
  getDoingForSession(sessionId: string): PlanItem[] {
    return [...this.items.values()].filter(
      (i) => i.sessionId === sessionId && ACTIVE_PLAN_STATUSES.has(i.status),
    );
  }

  /**
   * The plan a session is currently working, for stamping provenance on
   * anything it produces. Most recently updated wins when a session somehow
   * holds several, so the answer is stable rather than map-order dependent.
   */
  claimedPlanFor(sessionId: string): PlanItem | null {
    return this.getDoingForSession(sessionId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
  }

  /**
   * The plan a session has CLAIMED, whatever its lifecycle status — including
   * 'ready' items that have not gone active yet. The hook tracker uses this:
   * the first edit under a fresh claim is the transition ready → coding, and
   * claimedPlanFor (active work only) cannot see the claim before it exists.
   * 'done' is excluded because the work is finished; 'blocked' because that
   * state is a deliberate human decision only a human or MCP should undo.
   */
  claimedItemFor(sessionId: string): PlanItem | null {
    return [...this.items.values()]
      .filter(i => i.sessionId === sessionId && i.status !== 'done' && i.status !== 'blocked')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
  }

  /** Record a session claim on a plan. Unconditional — overrides any prior claim. */
  claimPlan(id: string, sessionId: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.sessionId = sessionId;
    item.updatedAt = Date.now();
    savePlanFile(item);
    this.emit('plan:changed', item.dirPath);
  }

  /** Add a dependency edge. Returns false if rejected (cycle, self-loop, cross-dir). */
  addDependency(fromId: string, toId: string): boolean {
    if (!this.canAddDependency(fromId, toId)) return false;

    this.dependencies.push({ fromId, toId });
    const from = this.items.get(fromId)!;
    this.recomputeStartable(from.dirPath);
    this.saveDir(from.dirPath, { skipSequences: true });
    this.emit('plan:changed', from.dirPath);
    logger.info(`[PlanManager] Added dependency ${fromId} → ${toId}`);
    return true;
  }

  /** Remove a dependency edge. Returns false if not found. */
  removeDependency(fromId: string, toId: string): boolean {
    const idx = this.dependencies.findIndex(d => d.fromId === fromId && d.toId === toId);
    if (idx < 0) return false;

    const from = this.items.get(fromId);
    this.dependencies.splice(idx, 1);

    const dirPath = from?.dirPath ?? this.items.get(toId)?.dirPath;
    if (dirPath) {
      this.recomputeStartable(dirPath);
      this.saveDir(dirPath, { skipSequences: true });
      this.emit('plan:changed', dirPath);
    }
    logger.info(`[PlanManager] Removed dependency ${fromId} → ${toId}`);
    return true;
  }

  /** Apply a ready plan to coding state (ready → coding). */
  applyItem(id: string): PlanItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    // Must be ready (or transition from planning if it has no deps satisfied)
    const items = this.getForDirectory(item.dirPath);
    if (!isStartable(item, this.dependencies, items) && item.status !== 'ready') return null;

    item.status = 'coding';
    item.stateInfo = undefined;
    item.updatedAt = Date.now();
    item.stateUpdatedAt = item.updatedAt;

    savePlanFile(item);
    this.emit('plan:changed', item.dirPath);
    logger.info(`[PlanManager] Applied plan "${item.title}" (${id})`);
    return item;
  }

  /** Complete a plan in coding or review state (→ done). Cascades ready recompute for dependents.
   *  Requires completionNotes (minimum 10 characters) to document what was accomplished. */
  completeItem(id: string, completionNotes?: string): PlanItem | null {
    const item = this.items.get(id);
    if (!item || (item.status !== 'coding' && item.status !== 'review')) return null;

    if (completionNotes === undefined) return null;
    if (completionNotes.trim().length < 10) return null;

    const prevStatus = item.status;
    item.completionNotes = completionNotes.trim();
    item.status = 'done';
    item.stateInfo = undefined;
    item.sessionId = undefined;
    item.updatedAt = Date.now();
    item.stateUpdatedAt = item.updatedAt;

    this.recomputeStartable(item.dirPath);
    this.saveDir(item.dirPath, { skipSequences: true });
    this.emit('plan:changed', item.dirPath);
    logger.info(`[PlanManager] Completed plan "${item.title}" (${id}) [${item.dirPath}] — was ${prevStatus}`);
    return item;
  }

  /** Reopen a done plan — transitions back to ready or planning based on current dependencies. */
  reopenItem(id: string): PlanItem | null {
    const item = this.items.get(id);
    if (!item || item.status !== 'done') return null;

    const blockers = this.dependencies
      .filter(d => d.toId === id)
      .map(d => this.items.get(d.fromId));
    const allBlockersDone = blockers.every(b => b?.status === 'done');

    item.status = allBlockersDone ? 'ready' : 'planning';
    item.stateInfo = undefined;
    item.updatedAt = Date.now();
    item.stateUpdatedAt = item.updatedAt;

    this.recomputeStartable(item.dirPath);
    this.saveDir(item.dirPath, { skipSequences: true });
    this.emit('plan:changed', item.dirPath);
    logger.info(`[PlanManager] Reopened plan "${item.title}" (${id}) → ${item.status}`);
    return item;
  }

  /** Manually update a plan item's state outside the normal apply/complete flow.
   * Cannot transition to 'done' — only completeItem can do that.
   * 'blocked' state requires non-empty stateInfo (reason why blocked).
   */
  setState(id: string, status: Exclude<PlanStatus, 'done'>, stateInfo = ''): PlanItem | null {
    // Validate status is a valid PlanStatus (not 'done')
    const validStatuses: Exclude<PlanStatus, 'done'>[] = ['planning', 'ready', 'coding', 'review', 'blocked'];
    if (!validStatuses.includes(status)) {
      logger.warn(`[PlanManager] setState rejected invalid status '${status}' for ${id} — must be one of: planning, ready, coding, review, blocked`);
      return null;
    }
    const item = this.items.get(id);
    if (!item || !this.canSetState(item, status as Exclude<PlanStatus, 'done'>)) return null;

    // Validate blocked state requires stateInfo
    if (status === 'blocked' && !stateInfo.trim()) {
      logger.warn(`[PlanManager] setState blocked rejected: requires stateInfo reason for ${id}`);
      return null;
    }

    const prevStatus = item.status;
    item.status = status;
    // Handle stateInfo:
    // - If new state is 'blocked', store the provided stateInfo (reason)
    // - If transitioning from blocked to a non-paused state, preserve provided stateInfo (reason unblocked)
    // - Otherwise, clear stateInfo unless new state is paused
    if (status === 'blocked') {
      item.stateInfo = stateInfo.trim() || item.stateInfo || 'Blocked';
    } else if (stateInfo.trim()) {
      // Preserve provided stateInfo (e.g., when unblocking, reason is recorded)
      item.stateInfo = stateInfo.trim();
    } else if (!PAUSED_PLAN_STATUSES.has(status as PlanStatus)) {
      item.stateInfo = undefined;
    } else {
      // For paused states (review, blocked), keep existing or clear
      item.stateInfo = PAUSED_PLAN_STATUSES.has(status as PlanStatus) ? item.stateInfo : undefined;
    }

    item.updatedAt = Date.now();
    item.stateUpdatedAt = item.updatedAt;

    savePlanFile(item);

    this.emit('plan:changed', item.dirPath);
    logger.info(`[PlanManager] Set plan "${item.title}" (${id}) ${prevStatus} → ${status}`);
    return item;
  }

  /** Export all data for persistence. */
  exportAll(): Record<string, DirectoryPlan> {
    const dirs = new Set<string>();
    for (const item of this.items.values()) {
      dirs.add(item.dirPath);
    }

    const result: Record<string, DirectoryPlan> = {};
    for (const dirPath of dirs) {
      const items = this.getForDirectory(dirPath);
      const itemIds = new Set(items.map(i => i.id));
      const deps = this.dependencies.filter(d => itemIds.has(d.fromId) || itemIds.has(d.toId));
      const sequences = this.getSequencesForDirectory(dirPath);
      result[dirPath] = { dirPath, items, dependencies: deps, sequences };
    }
    return result;
  }

  /** Import all data from persistence. Clears existing data. */
  importAll(data: Record<string, DirectoryPlan>): void {
    this.items.clear();
    this.dependencies = [];
    this.sequences.clear();

    for (const plan of Object.values(data)) {
      const sequenceIds = new Set((plan.sequences ?? []).map(sequence => sequence.id));
      for (const sequence of plan.sequences ?? []) {
        this.ensureSequenceProject(sequence);
        this.sequences.set(sequence.id, { ...sequence, dirPath: sequence.dirPath || plan.dirPath });
      }
      for (const item of plan.items) {
        this.ensurePlanMetadata(item);
        this.items.set(item.id, { ...item, sequenceId: item.sequenceId && sequenceIds.has(item.sequenceId) ? item.sequenceId : undefined });
      }
      this.dependencies.push(...plan.dependencies);
    }

    // Recompute startable for all directories
    const dirs = new Set<string>();
    for (const item of this.items.values()) {
      dirs.add(item.dirPath);
    }
    for (const dirPath of dirs) {
      this.recomputeStartable(dirPath);
    }
    savePlanSequences([...this.sequences.values()]);

    logger.info(`[PlanManager] Imported plans for ${dirs.size} directory(s)`);
  }

  /**
   * Import a single plan item from an external source (e.g. CLI-generated incoming file).
   * - Rejects duplicate IDs (returns null).
   * - Auto-renames on title collision: appends ` (2)`, ` (3)`, etc.
   * - Migrates old statuses to new: pending→planning, startable→ready, doing→coding, wait-tests→review, question→blocked
   * - Optional `deps` are filtered to only include edges that reference known IDs after import.
   */
  importItem(item: PlanItem, deps: PlanDependency[] = []): PlanItem | null {
    if (this.items.has(item.id)) {
      logger.warn(`[PlanManager] importItem rejected: duplicate ID ${item.id}`);
      return null;
    }

    const uniqueTitle = this.resolveUniqueTitle(item.dirPath, item.title);
    const now = Date.now();
    const migratedStatus = this.migrateOldStatus(item.status, item.stateInfo);

    const imported: PlanItem = {
      ...item,
      humanId: item.humanId,
      title: uniqueTitle,
      status: migratedStatus.status,
      stateInfo: migratedStatus.stateInfo ?? item.stateInfo,
      createdAt: item.createdAt ?? now,
      stateUpdatedAt: item.stateUpdatedAt ?? item.updatedAt ?? item.createdAt ?? now,
      updatedAt: now,
    };
    this.ensurePlanMetadata(imported);

    this.items.set(imported.id, imported);
    savePlanFile(imported);

    // Only add deps whose both ends are known
    const validDeps = deps.filter(d => this.items.has(d.fromId) && this.items.has(d.toId));
    if (validDeps.length > 0) {
      this.dependencies.push(...validDeps);
      saveDependencies(this.dependencies);
    }

    this.recomputeStartable(imported.dirPath);
    this.emit('plan:changed', imported.dirPath);
    logger.info(`[PlanManager] Imported plan "${uniqueTitle}" (${imported.id}) into ${imported.dirPath}`);
    return imported;
  }

  /**
   * Export a single plan item with the dependency edges that touch it.
   * Returns null if the item does not exist.
   */
  exportItem(id: string): { item: PlanItem; dependencies: PlanDependency[] } | null {
    const item = this.items.get(id);
    if (!item) return null;
    const dependencies = this.dependencies.filter(d => d.fromId === id || d.toId === id);
    return { item, dependencies };
  }

  /**
   * Export all plan items for a directory, including their dependency edges.
   * Returns null if the directory has no plans.
   */
  exportDirectory(dirPath: string): DirectoryPlan | null {
    const items = this.getForDirectory(dirPath);
    if (items.length === 0) return null;
    const itemIds = new Set(items.map(i => i.id));
    const dependencies = this.dependencies.filter(d => itemIds.has(d.fromId) && itemIds.has(d.toId));
    const sequences = this.getSequencesForDirectory(dirPath);
    return { dirPath, items, dependencies, sequences };
  }

  /**
   * Check if an ID is already in use.
   * Used by the watcher before attempting importItem.
   */
  hasItem(id: string): boolean {
    return this.items.has(id);
  }

  /** Find a unique title in a directory — appends (2), (3), etc. if a collision exists. */
  private resolveUniqueTitle(dirPath: string, title: string): string {
    const existing = new Set(this.getForDirectory(dirPath).map(i => i.title));
    if (!existing.has(title)) return title;
    let n = 2;
    while (existing.has(`${title} (${n})`)) n++;
    return `${title} (${n})`;
  }

  private noteHumanId(humanId?: string): void {
    const match = typeof humanId === 'string' ? humanId.match(HUMAN_ID_RE) : null;
    if (!match) return;
    this.nextHumanId = Math.max(this.nextHumanId, Number.parseInt(match[1] ?? '0', 10) + 1);
  }

  private allocateHumanId(): string {
    const humanId = formatHumanId(this.nextHumanId++);
    return humanId;
  }

  private ensurePlanMetadata(item: PlanItem): boolean {
    let changed = false;
    if (!item.humanId) {
      item.humanId = this.allocateHumanId();
      changed = true;
    } else {
      this.noteHumanId(item.humanId);
    }
    if (!item.stateUpdatedAt) {
      item.stateUpdatedAt = item.updatedAt ?? item.createdAt ?? Date.now();
      changed = true;
    }
    if (this.projectStore && !item.projectId) {
      const projectId = this.projectStore.resolveForPath(item.dirPath).id;
      if (item.projectId !== projectId) {
        item.projectId = projectId;
        changed = true;
      }
    }
    return changed;
  }

  private ensureSequenceProject(sequence: PlanSequence): boolean {
    if (!this.projectStore || sequence.projectId) return false;
    const projectId = this.projectStore.resolveForPath(sequence.dirPath).id;
    if (sequence.projectId === projectId) return false;
    sequence.projectId = projectId;
    sequence.updatedAt = Date.now();
    return true;
  }

  private cleanupOrphanSequenceMemberships(): void {
    const sequenceIds = new Set(this.sequences.keys());
    for (const item of this.items.values()) {
      if (item.sequenceId && !sequenceIds.has(item.sequenceId)) {
        item.sequenceId = undefined;
        savePlanFile(item);
      }
    }
  }

  private canAddDependency(fromId: string, toId: string): boolean {
    if (fromId === toId) return false;

    const from = this.items.get(fromId);
    const to = this.items.get(toId);
    if (!from || !to) return false;
    if (!this.areInSameProject(from, to)) return false;
    if (this.dependencies.some(d => d.fromId === fromId && d.toId === toId)) return false;
    if (this.wouldCreateCycle(fromId, toId)) return false;
    return true;
  }

  private resolveProjectId(dirPath: string): string | null {
    if (!this.projectStore) return null;
    return this.projectStore.findByPath(dirPath)?.id ?? null;
  }

  getProjectIdForDirectory(dirPath: string): string | null {
    return this.resolveProjectId(dirPath);
  }

  /**
   * A project's directory is a property of the project record, NOT something inferred from
   * whatever plans happen to exist. Deriving it by scanning plans/sequences meant a registered
   * project with no plans yet resolved to null, which blocked context_create on every new
   * project (chicken-and-egg: contexts needed a plan to exist first).
   */
  getDirectoryForProject(projectId: string): string | null {
    return this.projectStore?.getById(projectId)?.canonicalPath ?? null;
  }

  private areInSameProject(
    left: Pick<PlanItem, 'dirPath' | 'projectId'>,
    right: Pick<PlanItem | PlanSequence, 'dirPath' | 'projectId'>,
  ): boolean {
    if (!this.projectStore) return left.dirPath === right.dirPath;
    const leftProjectId = left.projectId ?? this.resolveProjectId(left.dirPath);
    const rightProjectId = right.projectId ?? this.resolveProjectId(right.dirPath);
    return leftProjectId !== null && leftProjectId === rightProjectId;
  }

  /** Check if adding fromId→toId would create a cycle via DFS. */
  private wouldCreateCycle(fromId: string, toId: string): boolean {
    // Adding fromId→toId means "fromId must finish before toId".
    // A cycle exists if toId can already reach fromId through existing edges.
    const visited = new Set<string>();
    const stack = [toId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === fromId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      // Follow outgoing edges from current
      for (const dep of this.dependencies) {
        if (dep.fromId === current) {
          stack.push(dep.toId);
        }
      }
    }
    return false;
  }

  /** Recompute ready status for all non-terminal items in a directory.
   * Items transition planning → ready when all dependencies are done.
   * Does not affect active items (coding, review, blocked) or done items.
   */
  private recomputeStartable(dirPath: string): void {
    const items = this.getForDirectory(dirPath);

    for (const item of items) {
      if (ACTIVE_PLAN_STATUSES.has(item.status) || item.status === 'done' || item.status === 'blocked') continue;

      const blockers = this.dependencies
        .filter(d => d.toId === item.id)
        .map(d => this.items.get(d.fromId))
        .filter(Boolean);

      const allDone = blockers.length === 0 || blockers.every(b => b!.status === 'done');
      item.status = allDone ? 'ready' : 'planning';
    }
  }

  private canSetState(item: PlanItem, next: Exclude<PlanStatus, 'done'>): boolean {
    if (item.status === 'done') return false;
    // 'coding' requires existing or provided sessionId
    if (next === 'coding') {
      if (item.status === 'coding' || item.status === 'ready' || item.status === 'review' || PAUSED_PLAN_STATUSES.has(item.status)) {
        return true;
      }
      return item.status === 'planning' && isStartable(item, this.dependencies, this.getForDirectory(item.dirPath));
    }
    return true;
  }

  /** Migrate old plan statuses to new ones.
   * Current statuses pass through untouched — only legacy names are rewritten,
   * so a reload never downgrades a saved 'coding'/'review' item (and with it,
   * the worker claim that hangs off 'coding').
   * Old states: pending | startable | doing | wait-tests | blocked | question | done
   * New states: planning | ready | coding | review | blocked | done
   * Mapping:
   *   pending → planning
   *   startable → ready
   *   doing → coding
   *   wait-tests → review
   *   question → blocked (with stateInfo="Question pending")
   */
  private migrateOldStatus(status: any, existingStateInfo?: string): { status: PlanStatus; stateInfo?: string } {
    const statusStr = String(status ?? '');

    if (CURRENT_PLAN_STATUSES.has(statusStr as PlanStatus)) {
      return { status: statusStr as PlanStatus, stateInfo: existingStateInfo };
    }

    if (statusStr === 'pending') return { status: 'planning' };
    if (statusStr === 'startable') return { status: 'ready' };
    if (statusStr === 'doing') return { status: 'coding' };
    if (statusStr === 'wait-tests') return { status: 'review' };
    if (statusStr === 'question') return { status: 'blocked', stateInfo: existingStateInfo || 'Question pending' };

    // Unknown status — default to planning
    return { status: 'planning' };
  }
}
