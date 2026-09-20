import { EventEmitter } from 'node:events';
import type { SessionManager } from './manager.js';
import type { StateDetector, ActivityChange } from './state-detector.js';
import { logger } from '../utils/logger.js';

/**
 * Grace period after arming during which an `inactive` edge is ignored.
 *
 * `inactive` is only 10 seconds of PTY silence — it is silence, not proof the
 * CLI finished. A CLI that thinks for a moment before it starts compacting
 * produces an edge that looks identical to completion, and pasting the handover
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
export const DEFAULT_HANDOVER_CEILING_MS = 300_000;

/** Why a pending handover was dropped without being delivered. */
export type HandoverLossReason = 'cancelled' | 'session-closed' | 'delivery-failed';

export interface HandoverDeliveryOptions {
  floorMs?: number;
  ceilingMs?: number;
}

interface PendingHandover {
  text: string;
  armedAt: number;
  ceiling: ReturnType<typeof setTimeout>;
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
  private readonly floorMs: number;
  private readonly ceilingMs: number;
  private disposed = false;

  private readonly onActivityChange = (event: ActivityChange): void => {
    if (event.level !== 'inactive') return;
    const entry = this.pending.get(event.sessionId);
    if (!entry) return;
    if (Date.now() - entry.armedAt < this.floorMs) return;
    void this.deliverNow(event.sessionId, 'idle');
  };

  private readonly onSessionRemoved = (event: { sessionId: string }): void => {
    this.drop(event.sessionId, 'session-closed');
  };

  constructor(
    private readonly stateDetector: StateDetector,
    private readonly sessionManager: SessionManager,
    private readonly deliver: (sessionId: string, text: string) => Promise<void>,
    private readonly notifyLoss: (sessionId: string, reason: HandoverLossReason) => void,
    options: HandoverDeliveryOptions = {},
  ) {
    super();
    this.floorMs = options.floorMs ?? DEFAULT_HANDOVER_FLOOR_MS;
    this.ceilingMs = options.ceilingMs ?? DEFAULT_HANDOVER_CEILING_MS;
    this.stateDetector.on('activity-change', this.onActivityChange);
    this.sessionManager.on('session:removed', this.onSessionRemoved);
  }

  /**
   * Hold `text` until the session next falls quiet.
   *
   * Must be called *before* the compact command is written. The command's own
   * output drives the session back to `active`, which guarantees the edge this
   * waits on is a fresh one rather than a state that predates the compaction.
   */
  arm(sessionId: string, text: string): void {
    if (this.disposed) return;
    // A second compaction supersedes the first; only the newer text is wanted.
    this.clearTimer(sessionId);
    this.pending.set(sessionId, {
      text,
      armedAt: Date.now(),
      ceiling: setTimeout(() => void this.deliverNow(sessionId, 'ceiling'), this.ceilingMs),
    });
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
   * so the fallback heuristic's later `inactive` edge finds nothing: no double
   * delivery by construction. The heuristic itself stays armed only for
   * sessions without hooks.
   */
  deliverFromPreCompact(sessionId: string): void {
    if (this.disposed) return;
    void this.deliverNow(sessionId, 'precompact');
  }

  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Text of the pending handover, for the confirmation dialog to show. */
  peek(sessionId: string): string | undefined {
    return this.pending.get(sessionId)?.text;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stateDetector.off('activity-change', this.onActivityChange);
    this.sessionManager.off('session:removed', this.onSessionRemoved);
    for (const sessionId of [...this.pending.keys()]) this.clearTimer(sessionId);
    this.pending.clear();
  }

  private async deliverNow(sessionId: string, trigger: 'idle' | 'ceiling' | 'precompact'): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    // Taken before the await so a racing edge cannot paste the same text twice.
    this.clearTimer(sessionId);

    logger.info(`[HandoverDelivery] Delivering handover to ${sessionId} (trigger: ${trigger})`);
    try {
      await this.deliver(sessionId, entry.text);
      this.emit('handover-delivered', { sessionId });
    } catch (error) {
      // Per invariant 7 a failed PTY write never throws upward. The handover is
      // already gone from the map, so this is terminal — say so loudly.
      logger.error(`[HandoverDelivery] Handover delivery failed for ${sessionId}: ${error}`);
      this.notifyLoss(sessionId, 'delivery-failed');
      this.emit('handover-lost', { sessionId, reason: 'delivery-failed' });
    }
  }

  private drop(sessionId: string, reason: HandoverLossReason): void {
    if (!this.pending.has(sessionId)) return;
    this.clearTimer(sessionId);
    logger.warn(`[HandoverDelivery] Handover for ${sessionId} dropped undelivered (${reason})`);
    this.notifyLoss(sessionId, reason);
    this.emit('handover-lost', { sessionId, reason });
  }

  /** Remove the pending entry and cancel its ceiling timer. */
  private clearTimer(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.ceiling);
    this.pending.delete(sessionId);
  }
}
