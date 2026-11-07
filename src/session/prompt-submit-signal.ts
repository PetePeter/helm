/**
 * Last hook-reported prompt submit per session.
 *
 * Delivery verification reads it to tell a real submit from a composer repaint:
 * terminal activity alone cannot (a pasted message in Codex ticks the tail and
 * still sits unsent). HookTracker is the only writer. In memory only — delivery
 * callers can require a submit hook for busy targets and fresh Codex spawn
 * context even before the first hook has been observed; other sessions can fall
 * back to tail timing.
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
