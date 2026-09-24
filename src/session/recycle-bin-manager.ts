/**
 * RecycleBinManager — rolling 30-day bin of closed, recoverable sessions.
 *
 * Mirrors the rolling-window pattern of ScheduledTaskHistoryManager. In-memory
 * list is newest-first; on every append stale entries (older than
 * RECYCLE_BIN_WINDOW_MS) are pruned and the list is persisted.
 *
 * Only sessions that carried a cliSessionName are recoverable, so only those
 * are ever added (see recordRemovedSession).
 *
 * The clock is injectable so retention pruning is deterministic in tests.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  saveRecycleBin,
  loadRecycleBin,
  RECYCLE_BIN_WINDOW_MS,
} from './recycle-bin-persistence.js';
import type { RecycleBinEntry } from '../types/recycle-bin.js';
import type { SessionRemovedEvent } from '../types/session.js';

export { RECYCLE_BIN_WINDOW_MS };

export class RecycleBinManager extends EventEmitter {
  private entries: RecycleBinEntry[];

  constructor(private readonly now: () => number = Date.now) {
    super();
    this.entries = loadRecycleBin();
  }

  /**
   * Add a closed session. Assigns an id, inserts newest-first, prunes the
   * retention window, persists, and emits 'recycle-bin:changed'.
   */
  append(entry: Omit<RecycleBinEntry, 'id'>): RecycleBinEntry {
    const created: RecycleBinEntry = { id: randomUUID(), ...entry };
    this.entries.unshift(created);
    const expired = this.pruneExpiredEntries();
    saveRecycleBin(this.entries);
    this.emit('recycle-bin:changed');
    // Entries that aged out of the retention window at runtime need their
    // preserved artifacts reclaimed too (startup pruning only covers restarts).
    if (expired.length > 0) this.emit('recycle-bin:expired', expired);
    return created;
  }

  /**
   * Prune entries loaded from disk during startup. Invoke this after lifecycle
   * listeners are registered so the normal expiry event reclaims all resources.
   */
  pruneExpired(): RecycleBinEntry[] {
    const expired = this.pruneExpiredEntries();
    if (expired.length === 0) return [];
    saveRecycleBin(this.entries);
    this.emit('recycle-bin:changed');
    this.emit('recycle-bin:expired', expired);
    return expired;
  }

  /** All entries, newest close first. */
  list(): RecycleBinEntry[] {
    return [...this.entries].sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Number of recoverable entries currently in the bin. */
  count(): number {
    return this.entries.length;
  }

  /** Look up an entry without removing it (restore peeks, then commits on success). */
  peek(id: string): RecycleBinEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Forget (permanently delete) a single entry. */
  forget(id: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length === before) return;
    saveRecycleBin(this.entries);
    this.emit('recycle-bin:changed');
  }

  /** Empty the bin. */
  empty(): void {
    this.entries = [];
    saveRecycleBin(this.entries);
    this.emit('recycle-bin:changed');
  }

  /** Drop entries whose closedAt falls outside the retention window; return them. */
  private pruneExpiredEntries(): RecycleBinEntry[] {
    const cutoff = this.now() - RECYCLE_BIN_WINDOW_MS;
    const expired = this.entries.filter(e => e.closedAt < cutoff);
    if (expired.length > 0) this.entries = this.entries.filter(e => e.closedAt >= cutoff);
    return expired;
  }
}

/**
 * Wiring helper for the session:removed event. A closed session is recoverable
 * only when it carried both a cliSessionName (resume UUID) and a workingDir —
 * the same condition under which its directory is auto-bookmarked. Keeps that
 * bookmark side effect and the bin append together and unit-testable.
 */
export function recordRemovedSession(
  event: SessionRemovedEvent,
  recycleBin: Pick<RecycleBinManager, 'append'>,
  bookmarkDir: (dir: string) => void,
  runtimeGroup?: { id: string; name: string },
  project?: { id: string; name: string },
): RecycleBinEntry | null {
  const session = event.session;
  if (!session?.cliSessionName || !session.workingDir) return null;

  bookmarkDir(session.workingDir);
  return recycleBin.append({
    sessionId: event.sessionId,
    name: session.name,
    cliType: session.cliType,
    workingDir: session.workingDir,
    cliSessionName: session.cliSessionName,
    ...(session.cliThreadId ? { cliThreadId: session.cliThreadId } : {}),
    closedAt: event.timestamp,
    // Capture the project (id + name) so the bin's Project tree level renders
    // without re-resolving, and survives the project being renamed later.
    ...(project ? { projectId: project.id, projectName: project.name } : {}),
    // Tag the bin entry with the session's runtime group so restore can re-add
    // it (recreating the group by id+name if it was closed meanwhile).
    ...(runtimeGroup ? { runtimeGroupId: runtimeGroup.id, runtimeGroupName: runtimeGroup.name } : {}),
    // The mission survives the bin so a restored session still says what it is for.
    ...(session.mission ? { mission: { ...session.mission } } : {}),
    ...(session.missionBarHeight != null ? { missionBarHeight: session.missionBarHeight } : {}),
  });
}
