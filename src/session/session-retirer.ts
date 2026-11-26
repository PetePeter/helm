import type { SessionManager } from './manager.js';
import type { SessionInfo } from '../types/session.js';
import { logger } from '../utils/logger.js';

const TICK_MS = 10_000;

/** A retiring session that has not closed itself by now is closed anyway. */
export const RETIRE_TIMEOUT_MS = 5 * 60_000;

export type CloseOutcome = 'retiring' | 'closed';

export interface SessionRetirerDeps {
  sessionManager: SessionManager;
  /** Deliver a prompt to the session's CLI (sequence syntax, submitted). */
  send: (sessionId: string, text: string) => Promise<void>;
  cliConfig: (cliType: string) => { saveMemoriesOnClose?: boolean } | null | undefined;
  /** The real close: kill the PTY and remove the session (it lands in the recycle bin). */
  hardClose: (session: SessionInfo) => void;
  /** The save-memories prompt — the editable `closeSaveMemories` hook injection. */
  prompt: () => string;
  now?: () => number;
}

/**
 * Closing a CLI session first asks its LLM to save key memories and close
 * itself (docs/session-close-memories.md). Until it does, the row stays,
 * marked `retiringAt`, and still takes input — that is how the prompt lands.
 *
 * A retiring session closes for real on: a second close (the LLM's own
 * session_close, or the user pressing close again), a lull after it took the
 * prompt (it answered and went quiet), or RETIRE_TIMEOUT_MS.
 */
export class SessionRetirer {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SessionRetirerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Runs only while a session is retiring: started by close(), stopped by the tick that empties it. */
  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async close(session: SessionInfo, options: { force?: boolean } = {}): Promise<CloseOutcome> {
    if (options.force || !this.shouldRetire(session)) return this.finish(session);

    this.deps.sessionManager.updateSession(session.id, { retiringAt: this.now() });
    try {
      await this.deps.send(session.id, this.deps.prompt());
    } catch (error) {
      logger.warn(`[SessionRetirer] Save-memories prompt failed for ${session.name}, closing: ${error}`);
      return this.finish(session);
    }
    logger.info(`[SessionRetirer] ${session.name} is saving memories before it closes`);
    this.start();
    return 'retiring';
  }

  tick(): void {
    const now = this.now();
    let pending = false;
    for (const session of this.deps.sessionManager.getAllSessions()) {
      const since = session.retiringAt;
      if (since === undefined) continue;
      pending = true;
      const tookPrompt = (session.lastPromptAt ?? 0) >= since;
      if (now - since >= RETIRE_TIMEOUT_MS || (tookPrompt && session.activityLevel !== 'active')) {
        this.finish(session);
      }
    }
    if (!pending) this.dispose();
  }

  /** A second close, an ineligible session, or a lull — the real close. */
  private shouldRetire(session: SessionInfo): boolean {
    if (session.retiringAt !== undefined) return false;
    if (session.apiTool || session.comfyUiTool || session.remote || session.frozen) return false;
    if (session.lastPromptAt === undefined) return false; // nothing to remember
    return this.deps.cliConfig(session.cliType)?.saveMemoriesOnClose !== false;
  }

  private finish(session: SessionInfo): 'closed' {
    try {
      this.deps.hardClose(session);
    } catch (error) {
      logger.warn(`[SessionRetirer] Close failed for ${session.name}: ${error}`);
      // Still here (locked meanwhile, say): back to a normal row, not a retry loop.
      if (this.deps.sessionManager.hasSession(session.id)) {
        this.deps.sessionManager.updateSession(session.id, { retiringAt: undefined });
      }
    }
    return 'closed';
  }
}
