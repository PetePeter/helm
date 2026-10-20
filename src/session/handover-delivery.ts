import { EventEmitter } from 'node:events';
import type { SessionManager } from './manager.js';
import { logger } from '../utils/logger.js';

/**
 * Grace period after arming during which PTY silence does not count.
 *
 * Silence is not proof the CLI finished. A CLI that thinks for a moment
 * before it starts compacting falls quiet exactly as it does on completion, and pasting the handover
 * there would drop it into the context about to be discarded.
 */
export const DEFAULT_HANDOVER_FLOOR_MS = 15_000;

/**
 * Deadline after which the handover is delivered regardless of activity.
 *
 * A CLI that renders a spinner forever never falls silent, and a handover that
 * is never delivered is strictly worse than one delivered at an awkward moment:
 * the session's whole working state was riding on it.
 */
export const DEFAULT_HANDOVER_CEILING_MS = 120_000;

/**
 * PTY silence that counts as the lull the handover waits for.
 *
 * Read straight off the terminal, never from the session's activity state:
 * hook-aware sessions ignore PTY output there, and a /clear is not a model
 * turn, so no Stop hook fires and the state never changes.
 */
export const DEFAULT_HANDOVER_SILENCE_MS = 10_000;

/** Why a pending handover was dropped without being delivered. */
export type HandoverLossReason = 'cancelled' | 'session-closed' | 'delivery-failed';

export interface HandoverDeliveryOptions {
  floorMs?: number;
  ceilingMs?: number;
  silenceMs?: number;
  /** Writes Esc to a session whose terminal never fell quiet (escRetry arms only). */
  nudge?: (sessionId: string) => void;
}

interface PendingHandover {
  text: string;
  armedAt: number;
  /** Edges inside this window are ignored (see DEFAULT_HANDOVER_FLOOR_MS). */
  floorMs: number;
  ceiling: ReturnType<typeof setTimeout>;
  silence?: ReturnType<typeof setTimeout>;
  /** Nudge with Esc and wait once more before pasting at the ceiling. */
  escRetry: boolean;
}

/** Resolves once a session's handover is pasted or dropped. */
interface Settlement {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Holds a session's handover text across a compaction and pastes it back when
 * the session falls quiet.
 *
 * The problem this solves: a CLI that compacts its own context loses everything
 * it knew, and nothing in the transcript survives to tell the post-compaction
 * model what it was doing. `session_compact` therefore takes the handover text
 * up front — while the context still exists — and this class replays it after.
 *
 * The text is opaque. An agent may pass prose, a file path, or an artifact
 * reference; Helm never parses it, so the agent keeps the choice of medium.
 *
 * Nothing is persisted. A pending handover lives only for the minutes between
 * the compact command and the next lull; if Helm restarts in that window the
 * compaction did not survive either.
 *
 * Scheduling semantics deliberately mirror `PatternMatcher`: one pending item
 * per session, a new one replaces the old, and session close cancels.
 *
 * Events:
 * - 'handover-armed'     ({ sessionId })          — pending, terminal should lock
 * - 'handover-delivered' ({ sessionId })          — pasted, terminal released
 * - 'handover-lost'      ({ sessionId, reason })  — dropped undelivered
 */
export class HandoverDelivery extends EventEmitter {
  private readonly pending = new Map<string, PendingHandover>();
  /**
   * Outlives `pending`: an entry leaves `pending` before its paste is awaited,
   * but whoever waits on it must not run until that paste has landed.
   */
  private readonly settlements = new Map<string, Settlement>();
  private readonly floorMs: number;
  private readonly ceilingMs: number;
  private readonly silenceMs: number;
  private readonly nudge: ((sessionId: string) => void) | undefined;
  private disposed = false;

  private readonly onPtyOutput = (sessionId: string): void => {
    if (this.pending.has(sessionId)) this.armSilence(sessionId, this.silenceMs);
  };

  private readonly onSessionRemoved = (event: { sessionId: string }): void => {
    this.drop(event.sessionId, 'session-closed');
  };

  constructor(
    /** Emits `data (sessionId, chunk)` per PTY write — the silence clock. */
    private readonly ptyOutput: EventEmitter,
    private readonly sessionManager: SessionManager,
    private readonly deliver: (sessionId: string, text: string) => Promise<void>,
    private readonly notifyLoss: (sessionId: string, reason: HandoverLossReason) => void,
    options: HandoverDeliveryOptions = {},
  ) {
    super();
    this.floorMs = options.floorMs ?? DEFAULT_HANDOVER_FLOOR_MS;
    this.ceilingMs = options.ceilingMs ?? DEFAULT_HANDOVER_CEILING_MS;
    this.silenceMs = options.silenceMs ?? DEFAULT_HANDOVER_SILENCE_MS;
    this.nudge = options.nudge;
    this.ptyOutput.on('data', this.onPtyOutput);
    this.sessionManager.on('session:removed', this.onSessionRemoved);
  }

  /**
   * Hold `text` until the session next falls quiet.
   *
   * Must be called *before* the compact command is written, so the silence
   * clock starts no later than the command's own output.
   *
   * `floorMs` overrides the compaction floor: a /clear is quick, so its note
   * waits only as long as that CLI needs before a new prompt.
   *
   * `escRetry` (a /clear only — Esc would abort a /compact): if the terminal
   * never falls quiet, send Esc at the ceiling and wait once more first.
   */
  arm(sessionId: string, text: string, opts: { floorMs?: number; escRetry?: boolean } = {}): void {
    if (this.disposed) return;
    // A second compaction supersedes the first; only the newer text is wanted.
    this.clearTimer(sessionId);
    if (!this.settlements.has(sessionId)) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      this.settlements.set(sessionId, { promise, resolve });
    }
    this.pending.set(sessionId, {
      text,
      armedAt: Date.now(),
      floorMs: opts.floorMs ?? this.floorMs,
      ceiling: this.startCeiling(sessionId),
      escRetry: opts.escRetry ?? false,
    });
    this.armSilence(sessionId, this.silenceMs);
    logger.info(`[HandoverDelivery] Armed handover for ${sessionId} (${text.length} chars)`);
    this.emit('handover-armed', { sessionId });
  }

  /** Drop a pending handover at the user's request. */
  cancel(sessionId: string): void {
    this.drop(sessionId, 'cancelled');
  }

  /**
   * PreCompact hook (G3): the CLI just announced its own compaction, so the
   * old context is being discarded right now — deliver immediately, ignoring
   * the lull floor. `deliverNow` removes the pending entry before it awaits,
   * so the silence clock's later expiry finds nothing: no double delivery
   * by construction.
   */
  deliverFromPreCompact(sessionId: string): void {
    if (this.disposed) return;
    void this.deliverNow(sessionId, 'precompact');
  }

  /** The user's "Send now": they judged the session ready, so skip the wait. */
  sendNow(sessionId: string): void {
    if (this.disposed) return;
    void this.deliverNow(sessionId, 'manual');
  }

  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Sessions with a handover waiting — seeds a reloaded renderer's lock. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * Resolves once the session has no handover in flight: immediately when none
   * is armed, otherwise after it is pasted or dropped. A re-arm before then
   * extends the wait to the newer note.
   */
  whenSettled(sessionId: string): Promise<void> {
    return this.settlements.get(sessionId)?.promise ?? Promise.resolve();
  }

  /** Text of the pending handover, for the confirmation dialog to show. */
  peek(sessionId: string): string | undefined {
    return this.pending.get(sessionId)?.text;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ptyOutput.off('data', this.onPtyOutput);
    this.sessionManager.off('session:removed', this.onSessionRemoved);
    for (const sessionId of [...this.pending.keys()]) this.clearTimer(sessionId);
    this.pending.clear();
    for (const sessionId of [...this.settlements.keys()]) this.settle(sessionId);
  }

  private async deliverNow(sessionId: string, trigger: 'silence' | 'ceiling' | 'precompact' | 'manual'): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    // Taken before the await so a racing edge cannot paste the same text twice.
    this.clearTimer(sessionId);

    logger.info(`[HandoverDelivery] Delivering handover to ${sessionId} (trigger: ${trigger})`);
    try {
      await this.deliver(sessionId, entry.text);
      // A note armed mid-paste keeps the terminal locked: no stale unlock.
      if (this.pending.has(sessionId)) return;
      this.settle(sessionId);
      this.emit('handover-delivered', { sessionId });
    } catch (error) {
      // Per invariant 7 a failed PTY write never throws upward. The handover is
      // already gone from the map, so this is terminal — say so loudly.
      logger.error(`[HandoverDelivery] Handover delivery failed for ${sessionId}: ${error}`);
      this.notifyLoss(sessionId, 'delivery-failed');
      if (this.pending.has(sessionId)) return;
      this.settle(sessionId);
      this.emit('handover-lost', { sessionId, reason: 'delivery-failed' });
    }
  }

  private drop(sessionId: string, reason: HandoverLossReason): void {
    if (!this.pending.has(sessionId)) return;
    this.clearTimer(sessionId);
    logger.warn(`[HandoverDelivery] Handover for ${sessionId} dropped undelivered (${reason})`);
    this.notifyLoss(sessionId, reason);
    this.settle(sessionId);
    this.emit('handover-lost', { sessionId, reason });
  }

  private settle(sessionId: string): void {
    this.settlements.get(sessionId)?.resolve();
    this.settlements.delete(sessionId);
  }

  private startCeiling(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.onCeiling(sessionId), this.ceilingMs);
  }

  /** A busy TUI (stuck menu, spinner) may only need an Esc to settle. */
  private onCeiling(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    if (!entry.escRetry || !this.nudge) {
      void this.deliverNow(sessionId, 'ceiling');
      return;
    }
    entry.escRetry = false;
    logger.info(`[HandoverDelivery] ${sessionId} never fell quiet; sending Esc and waiting once more`);
    entry.ceiling = this.startCeiling(sessionId);
    this.nudge(sessionId);
  }

  /** (Re)start the silence clock; silence inside the floor defers to its end. */
  private armSilence(sessionId: string, delayMs: number): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.silence);
    entry.silence = setTimeout(() => {
      const remainingFloor = entry.armedAt + entry.floorMs - Date.now();
      if (remainingFloor > 0) this.armSilence(sessionId, remainingFloor);
      else void this.deliverNow(sessionId, 'silence');
    }, delayMs);
  }

  /** Remove the pending entry and cancel its timers. */
  private clearTimer(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.ceiling);
    clearTimeout(entry.silence);
    this.pending.delete(sessionId);
  }
}
