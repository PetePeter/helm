/**
 * One retry for a ring the user did not pick up (docs/voice-operator.md).
 *
 * The phone reports only ANSWERED. Declined, timed out, phone off or out of
 * reach all look the same from here — no answer inside the window — and the
 * user asked for the same thing in every one of those cases: ring again once,
 * ten minutes later. A second miss stops and leaves a message instead.
 * A spoken "no" on an answered call is the operator's to honour; nothing here
 * retries an answered ring.
 *
 * Any session may ring, so each session keeps its own chain: one session's
 * ring or answer never cancels another's retry.
 *
 * In memory on purpose: a pending retry does not survive a Helm restart.
 */

/** How long after ringing an answer still counts (the phone rings for 30 s). */
export const RING_ANSWER_WINDOW_MS = 45_000;
/** The one retry, this long after the answer window closed. */
export const RING_RETRY_AFTER_MS = 10 * 60_000;

export interface RingRetryDeps {
  /** Ring again. False when no phone took it. */
  ring: (sessionId: string, reason: string) => boolean;
  /** The first ring went unanswered; the retry comes at `retryAt` (epoch ms). */
  missedOnce: (sessionId: string, reason: string, retryAt: number) => void;
  /** Both rings went unanswered. */
  missedTwice: (sessionId: string, reason: string) => void;
}

interface Pending {
  sessionId: string;
  reason: string;
  attempt: 1 | 2;
  timer: ReturnType<typeof setTimeout>;
}

export class RingRetry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: RingRetryDeps) {}

  /** A first ring went out; it replaces that session's chain in flight. */
  rang(sessionId: string, reason: string): void {
    this.clear(sessionId);
    this.awaitAnswer(sessionId, reason, 1);
  }

  /**
   * The phone picked up: that session's chain is over. An older phone names
   * no session, so its answer ends every chain rather than ring again.
   */
  answered(sessionId?: string): void {
    if (sessionId === undefined) this.dispose();
    else this.clear(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.pending.keys()]) this.clear(sessionId);
  }

  private awaitAnswer(sessionId: string, reason: string, attempt: 1 | 2): void {
    const timer = setTimeout(() => this.unanswered(sessionId, reason, attempt), RING_ANSWER_WINDOW_MS);
    timer.unref?.();
    this.pending.set(sessionId, { sessionId, reason, attempt, timer });
  }

  private unanswered(sessionId: string, reason: string, attempt: 1 | 2): void {
    this.pending.delete(sessionId);
    if (attempt === 2) {
      this.deps.missedTwice(sessionId, reason);
      return;
    }
    this.deps.missedOnce(sessionId, reason, Date.now() + RING_RETRY_AFTER_MS);
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      if (this.deps.ring(sessionId, reason)) this.awaitAnswer(sessionId, reason, 2);
      else this.deps.missedTwice(sessionId, reason);
    }, RING_RETRY_AFTER_MS);
    timer.unref?.();
    this.pending.set(sessionId, { sessionId, reason, attempt: 2, timer });
  }

  private clear(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
  }
}
