/**
 * Last hook-reported prompt submit per session.
 *
 * Delivery verification reads it to tell a real submit from a composer repaint:
 * terminal activity alone cannot (a pasted message in Codex ticks the tail and
 * still sits unsent). HookTracker is the only writer. In memory only — a session
 * that has not reported a submit since launch simply falls back to tail timing.
 */
export class PromptSubmitSignal {
  private readonly lastSubmitAt = new Map<string, number>();

  record(sessionId: string, at: number): void {
    this.lastSubmitAt.set(sessionId, at);
  }

  /** Any hook event: the session's hooks fire, so a missing submit is meaningful. */
  observe(sessionId: string): void {
    if (!this.lastSubmitAt.has(sessionId)) this.lastSubmitAt.set(sessionId, 0);
  }

  lastAt(sessionId: string): number | undefined {
    return this.lastSubmitAt.get(sessionId);
  }

  forget(sessionId: string): void {
    this.lastSubmitAt.delete(sessionId);
  }
}

export const promptSubmitSignal = new PromptSubmitSignal();
