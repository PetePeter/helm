/**
 * RecycleBinManager — rolling 7-day bin of closed, recoverable sessions.
 *
 * Mirrors the rolling-window pattern of ScheduledTaskHistoryManager. In-memory
 * list is newest-first; stale entries move into the durable purge queue when
 * appending or pruning, then the small bin state is persisted atomically.
 *
 * Only sessions that carried a cliSessionName are recoverable, so only those
 * are ever added (see recordRemovedSession).
 *
 * The clock is injectable so retention pruning is deterministic in tests.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BUILTIN_SHELL_CLI_TYPE } from '../types/session.js';
import {
  saveRecycleBin,
  loadRecycleBinState,
  RECYCLE_BIN_WINDOW_MS,
} from './recycle-bin-persistence.js';
import type { RecycleBinEntry, RecycleBinPurgeJob, RecycleBinPurgeKind } from '../types/recycle-bin.js';
import type { SessionRemovedEvent } from '../types/session.js';
import { logger } from '../utils/logger.js';

export { RECYCLE_BIN_WINDOW_MS };

export class RecycleBinRestoreInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecycleBinRestoreInProgressError';
  }
}

export class RecycleBinManager extends EventEmitter {
  private entries: RecycleBinEntry[];
  private pendingPurges: RecycleBinPurgeJob[];
  private readonly restoring = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly recycleBinFile?: string,
  ) {
    super();
    const state = loadRecycleBinState(this.recycleBinFile);
    this.entries = state.entries;
    this.pendingPurges = state.pendingPurges;
  }

  /**
   * Add a closed session. Assigns an id, inserts newest-first, prunes the
   * retention window, persists, and emits 'recycle-bin:changed'.
   */
  append(entry: Omit<RecycleBinEntry, 'id'>): RecycleBinEntry {
    const created: RecycleBinEntry = { id: randomUUID(), ...entry };
    const { entries: kept, expired } = this.prunedEntries([created, ...this.entries]);
    const protectedExpired = expired.filter(item => this.restoring.has(item.id));
    const queuedExpired = expired.filter(item => !this.restoring.has(item.id));
    const entries = [...kept, ...protectedExpired];
    const pendingPurges = this.withPurgeJobs(this.pendingPurges, queuedExpired, 'expired');
    this.persist(entries, pendingPurges, queuedExpired.length > 0);
    this.entries = entries;
    this.pendingPurges = pendingPurges;
    this.emit('recycle-bin:changed');
    // Entries that aged out at runtime were added to pendingPurges in the same save.
    if (queuedExpired.length > 0) this.emit('recycle-bin:expired', queuedExpired);
    return created;
  }

  /**
   * Prune entries loaded from disk after the main window shows. Expired entries
   * move into the durable queue before the visible list changes.
   */
  pruneExpired(): RecycleBinEntry[] {
    const { entries: kept, expired } = this.prunedEntries(this.entries);
    const protectedExpired = expired.filter(item => this.restoring.has(item.id));
    const queuedExpired = expired.filter(item => !this.restoring.has(item.id));
    if (queuedExpired.length === 0) return [];
    const entries = [...kept, ...protectedExpired];
    const pendingPurges = this.withPurgeJobs(this.pendingPurges, queuedExpired, 'expired');
    this.persist(entries, pendingPurges, true);
    this.entries = entries;
    this.pendingPurges = pendingPurges;
    this.emit('recycle-bin:changed');
    this.emit('recycle-bin:expired', queuedExpired);
    return queuedExpired;
  }

  /** Recoverable entries, newest close first. */
  list(): RecycleBinEntry[] {
    return this.recoverableEntries().sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Number of recoverable entries currently in the bin. */
  count(): number {
    return this.recoverableEntries().length;
  }

  /** Look up an entry without removing it (restore peeks, then commits on success). */
  peek(id: string): RecycleBinEntry | null {
    return this.recoverableEntries().find(e => e.id === id) ?? null;
  }

  /** Retain every session whose data is still represented by durable bin state. */
  retainedSessionIds(): Set<string> {
    return new Set([
      ...this.entries.map(entry => entry.sessionId),
      ...this.pendingPurges.map(job => job.entry.sessionId),
    ]);
  }

  /** Reserve a recoverable row before restore awaits process startup. */
  beginRestore(id: string): RecycleBinEntry | null {
    if (this.pendingPurges.some(job => job.entry.id === id)) return null;
    if (this.restoring.has(id)) {
      throw new RecycleBinRestoreInProgressError(`Recycle-bin entry ${id} is already being restored.`);
    }
    const entry = this.peek(id);
    if (!entry) return null;
    this.restoring.add(id);
    return { ...entry };
  }

  /** Release a failed restore reservation and queue it if it expired meanwhile. */
  releaseRestore(id: string): void {
    if (!this.restoring.delete(id)) return;
    try {
      this.pruneExpired();
    } catch (error) {
      logger.error(`[recycleBin] Failed to queue expired entry after restore ${id}: ${error}`);
    }
  }

  /** Remove an entry from the visible list and durably queue its permanent purge. */
  forget(id: string): void {
    this.assertNotRestoring(id);
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    const entries = this.entries.filter(item => item.id !== id);
    const pendingPurges = this.withPurgeJobs(this.pendingPurges, [entry], 'forgotten');
    this.persist(entries, pendingPurges, true);
    this.entries = entries;
    this.pendingPurges = pendingPurges;
    this.emit('recycle-bin:changed');
  }

  /** Remove every visible entry and durably queue its permanent purge. */
  empty(): void {
    if (this.restoring.size > 0) {
      throw new RecycleBinRestoreInProgressError('Cannot empty the recycle bin while a session is being restored.');
    }
    if (this.entries.length === 0) return;
    const pendingPurges = this.withPurgeJobs(this.pendingPurges, this.entries, 'forgotten');
    this.persist([], pendingPurges, true);
    this.entries = [];
    this.pendingPurges = pendingPurges;
    this.emit('recycle-bin:changed');
  }

  /** Restore commits remove the bin row but preserve all per-session data. */
  removeRestored(id: string): void {
    const entries = this.entries.filter(item => item.id !== id);
    if (entries.length === this.entries.length) return;
    this.persist(entries, this.pendingPurges, true);
    this.entries = entries;
    this.emit('recycle-bin:changed');
  }

  /** Pending jobs stay hidden from the renderer until their cleanup succeeds. */
  pendingPurgeJobs(skipIds: ReadonlySet<string> = new Set()): RecycleBinPurgeJob[] {
    return this.pendingPurges
      .filter(job => !skipIds.has(job.entry.id) && !this.restoring.has(job.entry.id))
      .map(job => ({ ...job, entry: { ...job.entry } }));
  }

  /** Acknowledge only after every cleanup step completed successfully. */
  completePurge(entryId: string): void {
    const pendingPurges = this.pendingPurges.filter(job => job.entry.id !== entryId);
    if (pendingPurges.length === this.pendingPurges.length) return;
    this.persist(this.entries, pendingPurges, true);
    this.pendingPurges = pendingPurges;
  }

  private persist(entries: RecycleBinEntry[], pendingPurges: RecycleBinPurgeJob[], requireDurable = false): void {
    saveRecycleBin(entries, this.recycleBinFile, pendingPurges, requireDurable);
  }

  private assertNotRestoring(id: string): void {
    if (this.restoring.has(id)) {
      throw new RecycleBinRestoreInProgressError(`Cannot forget session ${id} while it is being restored.`);
    }
  }

  private prunedEntries(entries: RecycleBinEntry[]): { entries: RecycleBinEntry[]; expired: RecycleBinEntry[] } {
    const cutoff = this.now() - RECYCLE_BIN_WINDOW_MS;
    const expired = entries.filter(entry => entry.closedAt < cutoff);
    return { entries: entries.filter(entry => entry.closedAt >= cutoff), expired };
  }

  private withPurgeJobs(
    current: RecycleBinPurgeJob[],
    entries: RecycleBinEntry[],
    kind: RecycleBinPurgeKind,
  ): RecycleBinPurgeJob[] {
    const jobs = [...current];
    const queuedIds = new Set(jobs.map(job => job.entry.id));
    for (const entry of entries) {
      if (!queuedIds.has(entry.id)) jobs.push({ entry: { ...entry }, kind });
    }
    return jobs;
  }

  /** Keep the read surface current without changing persisted entries or cleanup timing. */
  private recoverableEntries(): RecycleBinEntry[] {
    const cutoff = this.now() - RECYCLE_BIN_WINDOW_MS;
    return this.entries.filter(entry => entry.closedAt >= cutoff);
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
  if (!session?.cliSessionName || !session.workingDir || session.cliType === BUILTIN_SHELL_CLI_TYPE) return null;

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
