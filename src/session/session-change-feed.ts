/**
 * SessionChangeFeed — "what changed since I last looked", for surfaces that
 * mirror the session list from far away (the phone).
 *
 * WHY: the phone used to re-fetch the WHOLE list every two seconds to notice
 * that one dot had turned green. This is the CouchDB `_changes` idea instead:
 * every change takes the next number in ONE sequence, each session remembers
 * the number it last changed at, and a caller holding number N asks only for
 * what moved after N.
 *
 * WHY IN MEMORY, unlike the chat journal it resembles: chat is HISTORY and a
 * lost entry is a lost message; sessions are STATE and the list itself is
 * always there to be read again. So nothing is persisted. A restart starts a
 * new `epoch`, and a cursor from another epoch is answered with "take
 * everything" — the one full fetch a restart costs.
 *
 * It records THAT a session changed, never what: the reader builds the rows,
 * so there is exactly one place that knows what a session row looks like.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Where a reader has got to. Meaningless outside the epoch that issued it. */
export interface SessionFeedCursor {
  epoch: string;
  seq: number;
}

export type SessionFeedDelta =
  /** The cursor cannot be honoured: the reader must replace everything it holds. */
  | { full: true }
  | { full: false; changed: string[]; removed: string[] };

/** The slice of SessionManager the feed listens to. */
export interface SessionFeedSource {
  on(event: 'session:added' | 'session:updated', handler: (event: { id: string }) => void): unknown;
  on(event: 'session:removed', handler: (event: { sessionId: string }) => void): unknown;
}

export interface SessionChangeFeedOptions {
  /** Identifies this process's sequence. Injected so tests can name it. */
  epoch?: string;
  /** How many closed sessions are remembered before the oldest are forgotten. */
  maxTombstones?: number;
}

export const DEFAULT_SESSION_FEED_MAX_TOMBSTONES = 1_000;

export class SessionChangeFeed extends EventEmitter {
  readonly epoch: string;
  private currentSeq = 0;
  private readonly changedAt = new Map<string, number>();
  /** Insertion-ordered, so the oldest tombstone is always the first key. */
  private readonly removedAt = new Map<string, number>();
  private readonly maxTombstones: number;
  /**
   * The newest seq whose tombstone was forgotten. A cursor at or below it may
   * have missed a removal this feed can no longer name, so it gets everything.
   */
  private tombstoneFloor = 0;

  constructor(options: SessionChangeFeedOptions = {}) {
    super();
    this.epoch = options.epoch ?? randomUUID();
    this.maxTombstones = Math.max(1, options.maxTombstones ?? DEFAULT_SESSION_FEED_MAX_TOMBSTONES);
  }

  /** Follow a session manager. Every row it adds, updates or removes moves the feed. */
  attach(source: SessionFeedSource): void {
    source.on('session:added', (event) => this.touch(event.id));
    source.on('session:updated', (event) => this.touch(event.id));
    source.on('session:removed', (event) => this.remove(event.sessionId));
  }

  /** The newest number handed out — the cursor a fully caught-up reader holds. */
  get seq(): number {
    return this.currentSeq;
  }

  /** A session appeared or changed. */
  touch(sessionId: string): void {
    // A session that comes back (recycle-bin restore keeps its id) is no
    // longer removed; leaving the tombstone would report it as both.
    this.removedAt.delete(sessionId);
    this.changedAt.set(sessionId, this.advance());
  }

  /** A session is gone. */
  remove(sessionId: string): void {
    this.changedAt.delete(sessionId);
    this.removedAt.delete(sessionId);
    this.removedAt.set(sessionId, this.advance());
    while (this.removedAt.size > this.maxTombstones) {
      const [oldestId, oldestSeq] = this.removedAt.entries().next().value!;
      this.removedAt.delete(oldestId);
      this.tombstoneFloor = oldestSeq;
    }
  }

  /**
   * Everything that moved after `cursor`. No cursor, another epoch's cursor, a
   * cursor from the future, or one older than a forgotten removal all get the
   * same answer — take everything — because guessing at a gap is how a list
   * ends up showing a session that closed hours ago.
   */
  since(cursor: SessionFeedCursor | null): SessionFeedDelta {
    if (!cursor || cursor.epoch !== this.epoch) return { full: true };
    if (cursor.seq > this.currentSeq || cursor.seq < this.tombstoneFloor) return { full: true };
    return {
      full: false,
      changed: idsAfter(this.changedAt, cursor.seq),
      removed: idsAfter(this.removedAt, cursor.seq),
    };
  }

  private advance(): number {
    this.currentSeq += 1;
    this.emit('moved', this.currentSeq);
    return this.currentSeq;
  }
}

/**
 * Read a cursor out of untrusted call arguments. The phone's encoder types
 * every param as a string, so a seq arrives as a number OR its string form.
 * Anything unreadable is NO cursor — which is answered with everything, never
 * with an error: a list that fails to load is worse than one fetched whole.
 */
export function parseSessionFeedCursor(epoch: unknown, seq: unknown): SessionFeedCursor | null {
  if (typeof epoch !== 'string' || epoch === '') return null;
  const value = typeof seq === 'string' && seq.trim() !== '' ? Number(seq) : seq;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return { epoch, seq: value };
}

function idsAfter(seqById: Map<string, number>, seq: number): string[] {
  const ids: string[] = [];
  for (const [id, at] of seqById) if (at > seq) ids.push(id);
  return ids;
}
