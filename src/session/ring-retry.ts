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
 * In memory on purpose: a pending retry does not survive a Helm restart.
 */

/** How long after ringing an answer still counts (the phone rings for 30 s). */
export const RING_ANSWER_WINDOW_MS = 45_000;
/** The one retry, this long after the answer window closed. */
export const RING_RETRY_AFTER_MS = 10 * 60_000;

export interface RingRetryDeps {
  /** Ring again. False when no phone took it. */
  ring: (sessionId: string, reason: string) => boolean;
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
  private pending: Pending | null = null;

  constructor(private readonly deps: RingRetryDeps) {}

  /** A first ring went out; a newer ring replaces any chain in flight. */
  rang(sessionId: string, reason: string): void {
    this.clear();
    this.awaitAnswer(sessionId, reason, 1);
  }

  /** The phone picked up: the chain is over. */
  answered(): void {
    this.clear();
  }

  dispose(): void {
    this.clear();
  }

  private awaitAnswer(sessionId: string, reason: string, attempt: 1 | 2): void {
    const timer = setTimeout(() => this.unanswered(sessionId, reason, attempt), RING_ANSWER_WINDOW_MS);
    timer.unref?.();
    this.pending = { sessionId, reason, attempt, timer };
  }

  private unanswered(sessionId: string, reason: string, attempt: 1 | 2): void {
    this.pending = null;
    if (attempt === 2) {
      this.deps.missedTwice(sessionId, reason);
      return;
    }
    const timer = setTimeout(() => {
      this.pending = null;
      if (this.deps.ring(sessionId, reason)) this.awaitAnswer(sessionId, reason, 2);
      else this.deps.missedTwice(sessionId, reason);
    }, RING_RETRY_AFTER_MS);
    timer.unref?.();
    this.pending = { sessionId, reason, attempt: 2, timer };
  }

  private clear(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
