import { EventEmitter } from 'node:events';
import { MessPersistence, type MessLoadResult } from './mess-persistence.js';
import type { Cursor as MessCursor, Entry as MessEntry } from '../types/mess.js';
import { getMessProjectSettings, type ProjectRecord } from '../types/project.js';
import type { SessionInfo } from '../types/session.js';
import type { ProjectStore } from './project-store.js';
import type { SessionManager } from './manager.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_MESS_MAX_DELTA_ENTRIES = 50;
export const DEFAULT_MESS_MAX_DELTA_BYTES = 32 * 1024;
export const DEFAULT_MESS_HISTORY_LIMIT = 100;
export const DEFAULT_MESS_HISTORY_MAX_BYTES = 256 * 1024;

/**
 * How often a project's retention window is enforced. Pruning rewrites the whole
 * log, so it rides the read path on a timer rather than running per call.
 */
export const MESS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface MessPersistenceLike {
  append(input: Omit<MessEntry, 'id' | 'seq'>): MessEntry;
  load(): MessLoadResult;
  prune(retentionDays: number, now?: number): { removed: number };
  getCursor(sessionId: string): MessCursor | undefined;
  saveCursor(cursor: MessCursor): void;
  deleteCursor(sessionId: string): boolean;
  purge(): void;
}

export interface MessManagerOptions {
  persistenceFactory?: (projectId: string) => MessPersistenceLike;
  now?: () => number;
  maxDeltaEntries?: number;
  maxDeltaBytes?: number;
  maxHistoryBytes?: number;
}

export interface MessDelta {
  new: number;
  entries: MessEntry[];
  hasMore: boolean;
  gap: boolean;
  oldestSeq?: number;
  /** Emitted once, on the first check, when readable mess predates this session. */
  joined?: MessJoinContext;
}

/** How much readable conversation existed before a session joined. */
export interface MessJoinContext {
  prior: number;
  oldestSeq: number;
}

export interface MessSearchOptions {
  /** Literal, case-insensitive text. Never a pattern — see MessManager.search. */
  query: string;
  before?: number;
  after?: number;
  limit?: number;
  maxBytes?: number;
}

export interface MessSearchResult {
  entries: MessEntry[];
  /** Sequences that matched, as opposed to entries included only as context. */
  matchedSeqs: number[];
  hasMore: boolean;
}

export interface MessHistoryOptions {
  /** Omit to read the whole retained window. */
  sinceHours?: number;
  limit?: number;
  maxBytes?: number;
  /** Return entries strictly before this ordered sequence. */
  beforeSeq?: number;
}

export type MessHistoryEntry = MessEntry & { targetUnread?: boolean };

export interface MessHistoryResult {
  entries: MessHistoryEntry[];
  hasMore: boolean;
}

export type MessSessionCloseKind = 'ephemeral' | 'recoverable' | 'forgotten' | 'expired';

/**
 * Project-scoped Mess domain core.
 *
 * Project membership is deliberately side-effect free: a session's stored
 * projectId wins, otherwise ProjectStore.findByPath is used. In particular,
 * resolveForPath is never called because membership checks must not mint a
 * phantom project.
 */
export class MessManager extends EventEmitter {
  private readonly persistenceByProject = new Map<string, MessPersistenceLike>();
  private readonly lastPrunedAt = new Map<string, number>();
  private readonly persistenceFactory: (projectId: string) => MessPersistenceLike;
  private readonly now: () => number;
  private readonly maxDeltaEntries: number;
  private readonly maxDeltaBytes: number;
  private readonly maxHistoryBytes: number;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly projectStore: ProjectStore,
    options: MessManagerOptions = {},
  ) {
    super();
    this.persistenceFactory = options.persistenceFactory ?? ((projectId) => new MessPersistence(projectId));
    this.now = options.now ?? Date.now;
    this.maxDeltaEntries = positiveLimit(options.maxDeltaEntries, DEFAULT_MESS_MAX_DELTA_ENTRIES);
    this.maxDeltaBytes = positiveLimit(options.maxDeltaBytes, DEFAULT_MESS_MAX_DELTA_BYTES);
    this.maxHistoryBytes = positiveLimit(options.maxHistoryBytes, DEFAULT_MESS_HISTORY_MAX_BYTES);
  }

  post(fromSessionId: string, text: string, toSessionId?: string): MessEntry {
    const sender = this.requireSession(fromSessionId);
    const project = this.requireProject(sender);
    const target = toSessionId === undefined ? undefined : this.requireSession(toSessionId);
    if (target && this.requireProject(target).id !== project.id) {
      throw new Error('Mess direct target must belong to the same project');
    }
    const entry = this.projectPersistence(project).append({
      projectId: project.id,
      fromSessionId: sender.id,
      fromLabelSnapshot: sender.name,
      ...(target ? { toSessionId: target.id, toLabelSnapshot: target.name } : {}),
      text,
      createdAt: this.now(),
    });
    this.emit('mess:appended', entry);
    return entry;
  }

  check(sessionId: string, limits: { maxEntries?: number; maxBytes?: number } = {}): MessDelta {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const persistence = this.projectPersistence(project);
    const loaded = persistence.load();
    let cursor = persistence.getCursor(session.id);
    if (!cursor) {
      cursor = this.initialCursor(project, session, loaded);
      persistence.saveCursor(cursor);
    }

    const maxEntries = positiveLimit(limits.maxEntries, this.maxDeltaEntries);
    const maxBytes = positiveLimit(limits.maxBytes, this.maxDeltaBytes);
    const unread = loaded.entries.filter(entry => entry.seq > cursor!.lastSeq);
    const selected: MessEntry[] = [];
    let bytes = 0;
    let examinedThroughSeq = cursor.lastSeq;
    for (const entry of unread) {
      if (!isUnreadFor(entry, session.id)) {
        // A direct message for another session, or this caller's own post, is
        // not part of its delta. Leave the cursor at the last returned
        // sequence; otherwise a skipped entry would be acknowledged as though
        // this caller had received it. When a later delta entry is returned,
        // advancing to it naturally skips the intervening sequence.
        continue;
      }
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (selected.length >= maxEntries) break;
      if (selected.length > 0 && bytes + entryBytes > maxBytes) break;
      selected.push(entry);
      bytes += entryBytes;
      examinedThroughSeq = entry.seq;
    }

    // Spending the notice is the caller's act, never the notifier's, so it is
    // recorded here alongside any cursor advance.
    const joined = cursor.joinNoticeSent ? undefined : this.joinContext(cursor, loaded, session.id);
    if (examinedThroughSeq > cursor.lastSeq || !cursor.joinNoticeSent) {
      persistence.saveCursor({ ...cursor, lastSeq: examinedThroughSeq, joinNoticeSent: true });
    }
    return {
      new: selected.length,
      entries: selected,
      hasMore: unread.some(entry => entry.seq > examinedThroughSeq && isUnreadFor(entry, session.id)),
      gap: (loaded.prunedThroughSeq ?? 0) > cursor.lastSeq,
      ...(loaded.oldestSeq === undefined ? {} : { oldestSeq: loaded.oldestSeq }),
      ...(joined ? { joined } : {}),
    };
  }

  /**
   * Pin a session's baseline at the moment it joined and report what predates
   * it, without spending the notice.
   *
   * Called when a session appears, so the baseline is the head at join time
   * rather than the head whenever the session first happens to check.
   */
  joinContextFor(sessionId: string): MessJoinContext | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return undefined;
    let project: ProjectRecord;
    try {
      project = this.requireProject(session);
    } catch {
      return undefined;
    }
    const persistence = this.projectPersistence(project);
    const loaded = persistence.load();
    let cursor = persistence.getCursor(sessionId);
    if (!cursor) {
      cursor = this.initialCursor(project, session, loaded);
      persistence.saveCursor(cursor);
    }
    if (cursor.joinNoticeSent) return undefined;
    return this.joinContext(cursor, loaded, sessionId);
  }

  /**
   * Readable conversation that predates a session, for the one-time notice.
   *
   * Counted against the join baseline rather than the live cursor so the figure
   * stays truthful even if the notice is only collected after the session has
   * read newer mail.
   */
  private joinContext(cursor: MessCursor, loaded: MessLoadResult, sessionId: string): MessJoinContext | undefined {
    const prior = loaded.entries.filter(entry => entry.seq <= cursor.lastSeq && isVisibleTo(entry, sessionId));
    if (prior.length === 0) return undefined;
    return { prior: prior.length, oldestSeq: prior[0].seq };
  }

  /**
   * Find readable entries containing literal text, with surrounding context.
   *
   * The query is matched literally and case-insensitively rather than as a
   * regular expression. Callers are AI agents, so a pattern here would be
   * untrusted input compiled in the main process, where catastrophic
   * backtracking would freeze the app and every PTY with it. Literal matching
   * removes that class of failure entirely instead of guarding against it.
   */
  search(sessionId: string, options: MessSearchOptions): MessSearchResult {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const loaded = this.projectPersistence(project).load();
    const readable = loaded.entries.filter(entry => isVisibleTo(entry, session.id));

    const needle = options.query.toLowerCase();
    const before = Math.max(0, Math.trunc(options.before ?? 0));
    const after = Math.max(0, Math.trunc(options.after ?? 0));
    const limit = positiveLimit(options.limit, DEFAULT_MESS_HISTORY_LIMIT);
    const maxBytes = positiveLimit(options.maxBytes, this.maxHistoryBytes);

    const matchIndexes: number[] = [];
    readable.forEach((entry, index) => {
      if (entry.text.toLowerCase().includes(needle)) matchIndexes.push(index);
    });
    const kept = matchIndexes.slice(-limit);

    // Context windows are unioned, so adjacent matches read as one passage
    // instead of repeating the entries they share.
    const included = new Set<number>();
    for (const index of kept) {
      for (let at = index - before; at <= index + after; at += 1) {
        if (at >= 0 && at < readable.length) included.add(at);
      }
    }

    const entries: MessEntry[] = [];
    let bytes = 0;
    for (const index of [...included].sort((left, right) => left - right)) {
      const entry = readable[index];
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (entries.length > 0 && bytes + entryBytes > maxBytes) break;
      entries.push(entry);
      bytes += entryBytes;
    }
    const returned = new Set(entries.map(entry => entry.seq));
    return {
      entries,
      matchedSeqs: kept.map(index => readable[index].seq).filter(seq => returned.has(seq)),
      hasMore: kept.length < matchIndexes.length || entries.length < included.size,
    };
  }

  /** Read recent project history without creating or advancing an AI cursor. */
  history(sessionId: string, options: MessHistoryOptions): MessEntry[] {
    return this.historyResult(sessionId, options).entries;
  }

  /** Count visible unread entries without creating or advancing the caller cursor. */
  unreadCount(sessionId: string): number {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const persistence = this.projectPersistence(project);
    const loaded = persistence.load();
    let cursor = persistence.getCursor(session.id);
    if (!cursor) {
      // Capture the join horizon once, without acknowledging any entry. A
      // notifier poll must not slide a cursorless member's baseline forward
      // as wall time passes.
      cursor = this.initialCursor(project, session, loaded);
      persistence.saveCursor(cursor);
    }
    return loaded.entries.filter(entry => entry.seq > cursor.lastSeq && isUnreadFor(entry, session.id)).length;
  }

  /** Read recent history with an explicit truncation signal for bounded callers. */
  historyResult(sessionId: string, options: MessHistoryOptions): MessHistoryResult {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const loaded = this.projectPersistence(project).load();
    return this.boundedHistory(loaded.entries.filter(entry => isVisibleTo(entry, session.id)), options);
  }

  /** Read project history for the human observer without requiring a session cursor. */
  historyForProject(projectId: string, options: MessHistoryOptions): MessHistoryResult {
    const project = this.projectStore.getById(projectId);
    if (!project) return { entries: [], hasMore: false };
    return this.boundedHistory(this.projectPersistence(project).load().entries, options);
  }

  /** Read a target's ordered cursor without creating or advancing it. */
  isEntryUnreadForSession(projectId: string, sessionId: string, seq: number): boolean {
    const cursor = this.persistence(projectId).getCursor(sessionId);
    return cursor === undefined || seq > cursor.lastSeq;
  }

  private boundedHistory(candidates: MessEntry[], options: MessHistoryOptions): MessHistoryResult {
    const limit = positiveLimit(options.limit, DEFAULT_MESS_HISTORY_LIMIT);
    const maxBytes = positiveLimit(options.maxBytes, this.maxHistoryBytes);
    const cutoff = options.sinceHours === undefined
      ? Number.NEGATIVE_INFINITY
      : this.now() - Math.max(0, options.sinceHours) * 60 * 60 * 1000;
    const page = candidates.filter(entry => options.beforeSeq === undefined || entry.seq < options.beforeSeq);
    const recent = page.filter(entry => entry.createdAt >= cutoff);
    const selected: MessHistoryEntry[] = [];
    let bytes = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const entry = recent[index];
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (selected.length >= limit) break;
      if (selected.length > 0 && bytes + entryBytes > maxBytes) break;
      selected.push(entry);
      bytes += entryBytes;
    }
    selected.reverse();
    return {
      entries: selected,
      // Judged against the whole page, not the time window, so older entries stay reachable.
      hasMore: selected.length > 0
        ? page.some(entry => entry.seq < selected[0].seq)
        : page.length > 0,
    };
  }

  /** Remove only an ephemeral session's cursor; recoverable sessions retain it. */
  onSessionClosed(sessionId: string, kind: MessSessionCloseKind): void {
    if (kind === 'recoverable') return;
    const session = this.sessionManager.getSession(sessionId);
    const projectId = session ? this.projectIdForSession(session) : this.findProjectIdForCursor(sessionId);
    if (projectId) this.persistence(projectId).deleteCursor(sessionId);
  }

  purgeProject(projectId: string): void {
    this.persistence(projectId).purge();
    this.persistenceByProject.delete(projectId);
    this.lastPrunedAt.delete(projectId);
  }

  getProjectIdForSession(sessionId: string): string | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;
    try { return this.requireProject(session).id; } catch { return null; }
  }

  /**
   * A new member starts at the head, so unread means exactly "posted since you
   * joined".
   *
   * An age window was tried and removed: no timestamp can decide whether an
   * older message still applies to a session that did not exist yet, and every
   * fresh spawn replayed the same window again. What predates a session is
   * disclosed once via the join notice and pulled on demand through history or
   * search, rather than pushed as though it were addressed to the newcomer.
   */
  private initialCursor(project: ProjectRecord, session: SessionInfo, loaded: MessLoadResult): MessCursor {
    const baselineSeq = Math.max(loaded.prunedThroughSeq ?? 0, loaded.entries.at(-1)?.seq ?? 0);
    return { projectId: project.id, sessionId: session.id, lastSeq: baselineSeq, joinedAt: this.now() };
  }

  /**
   * Persistence for a resolved project, with its retention window enforced.
   *
   * Retention has to be applied somewhere or a project log grows without bound
   * and the `gap` indicator can never fire. Doing it on the read path keeps the
   * policy in the domain core with no background timer to leak, and the interval
   * keeps a full log rewrite off every single call.
   */
  private projectPersistence(project: ProjectRecord): MessPersistenceLike {
    const persistence = this.persistence(project.id);
    const now = this.now();
    const last = this.lastPrunedAt.get(project.id);
    if (last !== undefined && now - last < MESS_PRUNE_INTERVAL_MS) return persistence;
    this.lastPrunedAt.set(project.id, now);
    try {
      persistence.prune(getMessProjectSettings(project).messRetentionDays, now);
    } catch (error) {
      // Retention is maintenance, never the caller's operation (invariant 7).
      logger.warn(`[Mess] Retention prune failed for project ${project.id}: ${error}`);
    }
    return persistence;
  }

  private persistence(projectId: string): MessPersistenceLike {
    let persistence = this.persistenceByProject.get(projectId);
    if (!persistence) {
      persistence = this.persistenceFactory(projectId);
      this.persistenceByProject.set(projectId, persistence);
    }
    return persistence;
  }

  private requireSession(sessionId: string): SessionInfo {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Mess session not found: ${sessionId}`);
    return session;
  }

  private requireProject(session: SessionInfo): ProjectRecord {
    const projectId = this.projectIdForSession(session);
    const project = this.projectStore.getById(projectId);
    if (!project) throw new Error(`Mess project not found for session ${session.id}`);
    return project;
  }

  private projectIdForSession(session: SessionInfo): string {
    if (session.projectId) return session.projectId;
    if (session.workingDir) {
      const project = this.projectStore.findByPath(session.workingDir);
      if (project) return project.id;
    }
    throw new Error(`Mess session ${session.id} has no project membership`);
  }

  private findProjectIdForCursor(sessionId: string): string | null {
    for (const project of this.projectStore.list()) {
      if (this.persistence(project.id).getCursor(sessionId)) return project.id;
    }
    return null;
  }
}

/**
 * A session sees broadcasts, entries addressed to it, and its own posts. The
 * author clause matters for directed mail: without it a session's own DM is
 * addressed away from itself and vanishes from its own transcript on send.
 */
function isVisibleTo(entry: MessEntry, sessionId: string): boolean {
  return entry.toSessionId === undefined
    || entry.toSessionId === sessionId
    || entry.fromSessionId === sessionId;
}

/**
 * Unread is narrower than visible: an author has already read what it wrote.
 * Counting an own post inflates the unread total the notifier advertises and
 * replays the message back to its writer, so own entries stay in history —
 * where the transcript needs them — but never in a delta.
 */
function isUnreadFor(entry: MessEntry, sessionId: string): boolean {
  return isVisibleTo(entry, sessionId) && entry.fromSessionId !== sessionId;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
