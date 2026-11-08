/**
 * ScheduledTaskHistoryManager — rolling 7-day log of scheduled task runs.
 *
 * Uses a rolling-window retention pattern for lightweight
 * metadata entries (no stdout). In-memory list is newest-first; on every append
 * stale entries (older than HISTORY_WINDOW_MS) are pruned and the list is
 * persisted via the history persistence module.
 *
 * The clock is injectable so retention pruning is deterministic in tests.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  saveScheduledTaskHistory,
  loadScheduledTaskHistory,
  HISTORY_WINDOW_MS,
} from './scheduled-task-history-persistence.js';
import type { ScheduledTaskHistoryEntry } from '../types/scheduled-task.js';

export { HISTORY_WINDOW_MS };

export class ScheduledTaskHistoryManager extends EventEmitter {
  private entries: ScheduledTaskHistoryEntry[];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly historyFile?: string,
  ) {
    super();
    this.entries = loadScheduledTaskHistory(this.historyFile);
  }

  /**
   * Record a completed run. Assigns an id, inserts newest-first, prunes the
   * retention window, persists, and emits 'history:changed'.
   */
  append(entry: Omit<ScheduledTaskHistoryEntry, 'id'>): ScheduledTaskHistoryEntry {
    const created: ScheduledTaskHistoryEntry = { id: randomUUID(), ...entry };
    this.entries.unshift(created);
    this.prune();
    saveScheduledTaskHistory(this.entries, this.historyFile);
    this.emit('history:changed');
    return created;
  }

  /** All entries, newest run first. */
  list(): ScheduledTaskHistoryEntry[] {
    return [...this.entries].sort((a, b) => b.ranAt - a.ranAt);
  }

  /** Remove all history entries. */
  clear(): void {
    this.entries = [];
    saveScheduledTaskHistory(this.entries, this.historyFile);
    this.emit('history:changed');
  }

  /** Drop entries whose ranAt falls outside the retention window. */
  private prune(): void {
    const cutoff = this.now() - HISTORY_WINDOW_MS;
    this.entries = this.entries.filter(e => e.ranAt >= cutoff);
  }
}
