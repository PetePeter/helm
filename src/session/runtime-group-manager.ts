/**
 * RuntimeGroupManager — in-memory owner of ad-hoc runtime session groups.
 *
 * WHY one-group-max: a session may appear in AT MOST ONE runtime group so the
 * sidebar can render each session under exactly one heading. `addSession` first
 * evicts the session from every group before inserting it into the target, so
 * membership is always exclusive without the caller having to reason about it.
 *
 * WHY recreate-on-restore (`ensureGroup`): groups persist independently of their
 * membership and can be closed while a member session sits in the recycle bin.
 * When that session is restored, its bin entry carries the original group id +
 * name; `ensureGroup` re-materialises the group by that exact id if it is gone,
 * so restore always lands the session back in "its" group.
 *
 * This manager is intentionally pure: it does NOT read from disk in its
 * constructor. The orchestrator hydrates it via `importAll(loadRuntimeGroups())`
 * and supplies the `persist` callback, mirroring DraftManager. The clock is
 * injectable so createdAt/updatedAt are deterministic in tests.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { isRuntimeGroupColor, type RuntimeGroup } from '../types/runtime-group.js';

export class RuntimeGroupManager extends EventEmitter {
  private groups: RuntimeGroup[] = [];

  constructor(
    private readonly persist?: (groups: RuntimeGroup[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /** Create a new empty group and return it. */
  create(name: string): RuntimeGroup {
    const ts = this.now();
    const group: RuntimeGroup = {
      id: randomUUID(),
      name,
      sessionIds: [],
      collapsed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.groups.push(group);
    this.markChanged();
    logger.info(`[RuntimeGroupManager] Created group "${name}" (${group.id})`);
    return group;
  }

  /** Rename a group. Returns the updated group, or null if not found. */
  rename(id: string, name: string): RuntimeGroup | null {
    const group = this.find(id);
    if (!group) return null;
    group.name = name;
    group.updatedAt = this.now();
    this.markChanged();
    return group;
  }

  /** Set the group's colour. Returns the updated group, or null if not found. */
  setColor(id: string, color: string): RuntimeGroup | null {
    if (!isRuntimeGroupColor(color)) throw new Error(`Not a group colour: ${color}`);
    const group = this.find(id);
    if (!group) return null;
    group.color = color;
    group.updatedAt = this.now();
    this.markChanged();
    return group;
  }

  /** Set collapsed state. Persists only when the value actually changes. */
  setCollapsed(id: string, collapsed: boolean): void {
    const group = this.find(id);
    if (!group || group.collapsed === collapsed) return;
    group.collapsed = collapsed;
    group.updatedAt = this.now();
    this.markChanged();
  }

  /**
   * Add a session to a group with exclusive membership: the session is evicted
   * from every OTHER group, then appended to the target if not already present.
   * Returns the target group, or null if it does not exist.
   *
   * Idempotent: re-adding a session to the group it already solely belongs to is
   * a no-op — it does NOT reorder the session to the end or fire a spurious
   * change/persist (the "Move to group" menu leaves the current group selectable,
   * so this path is user-reachable).
   */
  addSession(groupId: string, sessionId: string): RuntimeGroup | null {
    const target = this.find(groupId);
    if (!target) return null;

    const inTarget = target.sessionIds.includes(sessionId);
    const elsewhere = this.groups.some(g => g !== target && g.sessionIds.includes(sessionId));
    if (inTarget && !elsewhere) return target;

    // Evict from OTHER groups only — the target keeps the session's existing slot.
    for (const group of this.groups) {
      if (group === target) continue;
      group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
    }
    if (!inTarget) target.sessionIds.push(sessionId);
    target.updatedAt = this.now();
    this.markChanged();
    return target;
  }

  /**
   * Strip a session from every group (called when the session is closed).
   * Persists only if the session was actually a member somewhere.
   */
  removeSessionEverywhere(sessionId: string): void {
    let removed = false;
    for (const group of this.groups) {
      const before = group.sessionIds.length;
      group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
      if (group.sessionIds.length !== before) {
        group.updatedAt = this.now();
        removed = true;
      }
    }
    if (removed) this.markChanged();
  }

  /**
   * Delete a group entirely. Its members become unclaimed and fall back to
   * directory grouping elsewhere. Returns whether a group was removed.
   */
  closeGroup(id: string): boolean {
    const before = this.groups.length;
    this.groups = this.groups.filter(g => g.id !== id);
    const removed = this.groups.length !== before;
    if (removed) this.markChanged();
    return removed;
  }

  /**
   * Return the group with `id`, creating it with that EXACT id + name if absent.
   * Used by restore to re-materialise a group that was closed while a member sat
   * in the recycle bin.
   */
  ensureGroup(id: string, name: string): RuntimeGroup {
    const existing = this.find(id);
    if (existing) return existing;
    const ts = this.now();
    const group: RuntimeGroup = {
      id,
      name,
      sessionIds: [],
      collapsed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.groups.push(group);
    this.markChanged();
    logger.info(`[RuntimeGroupManager] Recreated group "${name}" (${id}) on restore`);
    return group;
  }

  /** The group a session currently belongs to, or null. */
  groupForSession(sessionId: string): RuntimeGroup | null {
    return this.groups.find(g => g.sessionIds.includes(sessionId)) ?? null;
  }

  /** Get a single group by id. */
  get(id: string): RuntimeGroup | null {
    return this.find(id);
  }

  /** All groups in display order (shallow copy of the list). */
  list(): RuntimeGroup[] {
    return [...this.groups];
  }

  /** Deep-ish copy of all groups for persistence (sessionIds arrays copied). */
  exportAll(): RuntimeGroup[] {
    return this.groups.map(g => ({ ...g, sessionIds: [...g.sessionIds] }));
  }

  /**
   * Replace internal state from persisted data, sanitising each entry: only
   * objects with a string id, string name, and array sessionIds are accepted;
   * collapsed is coerced to boolean and timestamps default to now if missing.
   */
  importAll(groups: RuntimeGroup[]): void {
    const ts = this.now();
    this.groups = (Array.isArray(groups) ? groups : [])
      .filter((g): g is RuntimeGroup =>
        !!g &&
        typeof g.id === 'string' && g.id.length > 0 &&
        typeof g.name === 'string' &&
        Array.isArray(g.sessionIds))
      .map(g => ({
        id: g.id,
        name: g.name,
        sessionIds: g.sessionIds.filter(id => typeof id === 'string'),
        collapsed: Boolean(g.collapsed),
        createdAt: typeof g.createdAt === 'number' ? g.createdAt : ts,
        updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : ts,
      }));
    logger.info(`[RuntimeGroupManager] Imported ${this.groups.length} runtime group(s)`);
  }

  private find(id: string): RuntimeGroup | null {
    return this.groups.find(g => g.id === id) ?? null;
  }

  private markChanged(): void {
    this.persist?.(this.exportAll());
    this.emit('runtime-group:changed');
  }
}
