/**
 * Per-session serialization of the delivery transaction.
 *
 * Delivery is not a single write. It is nudge -> payload -> settle -> submit,
 * and any interleaving of two of those corrupts both messages. Moving delivery
 * into the main process gave one writer *location*; it did not give one
 * serialized *operation*. Two concurrent senders — phone chat and inter-session,
 * or a send and a recovery resend — could each nudge and then write.
 *
 * The gate is per session: delivering to one session must never hold up
 * delivery to another. It is also deliberately narrow. Two things stay outside
 * it, and both are load-bearing:
 *
 * - `PtyManager.write`, so the user's own keystrokes never queue behind a bulk
 *   delivery.
 * - The delivery-verification polling window, which can run for seconds. See
 *   `deliverPromptSequenceToSession` for why holding it there would deadlock
 *   recovery outright.
 */

/**
 * A promise-chain gate keyed by session id.
 *
 * Release is structural rather than a try/finally: each queued task is appended
 * to a chain that has already swallowed the previous task's rejection, so a
 * thrown transaction can neither wedge the session nor leak its error into the
 * next caller. The caller still sees its own rejection.
 */
export class DeliveryLock {
  /** Tail of each session's queue. Absent means the session is idle. */
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Run `task` once every earlier task for this session has settled.
   * Resolves or rejects with the task's own outcome.
   */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    // catch() before the hand-off: the next task waits for its predecessor to
    // finish, not for it to succeed.
    const result = previous.then(() => task(), () => task());
    const chained = result.catch(() => undefined);
    this.chains.set(sessionId, chained);

    // Drop the entry once this task is the last one still queued, so a
    // long-lived process does not retain a promise per session it ever touched.
    void chained.then(() => {
      if (this.chains.get(sessionId) === chained) this.chains.delete(sessionId);
    });

    return result;
  }

  /** Sessions with work still queued. Exposed so tests can pin that entries are pruned. */
  pendingSessionCount(): number {
    return this.chains.size;
  }
}

/**
 * The process-wide gate.
 *
 * Sessions are process-wide, so a singleton is the honest shape; delivery entry
 * points take an optional lock so tests stay hermetic without threading one
 * through every call site.
 */
export const deliveryLock = new DeliveryLock();
