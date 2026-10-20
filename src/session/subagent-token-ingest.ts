/**
 * Feeds sub-agent context readings to the token ledger. A sub-agent's work never
 * shows in the main context, so the sweep reads their logs on its own clock
 * rather than when the main reading happens to move. Every read is a delta
 * against the saved baseline, so sweeping often never counts anything twice.
 */

import { readSubagentContexts } from './subagent-usage.js';
import type { TimeTracker } from './time-tracker.js';

interface IngestSession {
  id: string;
  cliTranscriptPath?: string;
  /** A peer's row: that machine counts its own sub-agents. */
  remote?: unknown;
}

export class SubagentTokenIngest {
  private readonly primed = new Set<string>();

  /**
   * @param primeFirstRead with no saved baselines, what an earlier run counted is
   *   unknown, so a session's first read only sets the baseline.
   */
  constructor(private readonly tracker: TimeTracker, private readonly primeFirstRead: boolean) {}

  sweep(sessions: Iterable<IngestSession>): void {
    for (const session of sessions) {
      if (session.remote) continue;
      const first = !this.primed.has(session.id);
      this.primed.add(session.id);
      const record = first && this.primeFirstRead ? this.tracker.primeSubagentTokens : this.tracker.recordSubagentTokens;
      for (const [agent, tokens] of readSubagentContexts(session.cliTranscriptPath)) {
        record.call(this.tracker, session.id, agent, tokens);
      }
    }
  }

  forget(sessionId: string): void {
    this.primed.delete(sessionId);
  }
}
