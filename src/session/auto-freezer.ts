import type { SessionManager } from './manager.js';
import { promptStaleness, type StalenessThresholds } from './prompt-staleness.js';
import { logger } from '../utils/logger.js';

const TICK_MS = 30_000;

/**
 * Freezes a session once its last prompt is older than its CLI type's long
 * cache. Past that point the next prompt re-reads the whole context at full
 * price, so the session stays shut until the user (or another session, via
 * MCP) deliberately thaws it.
 *
 * The operator is exempt: it answers phone calls and must never be shut.
 */
export class AutoFreezer {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly thresholds: (cliType: string) => StalenessThresholds | null | undefined,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.now();
    for (const session of this.sessionManager.getAllSessions()) {
      if (session.frozen || session.role === 'operator') continue;
      if (promptStaleness(session.lastPromptAt, now, this.thresholds(session.cliType)) !== 'expired') continue;
      logger.info(`[AutoFreezer] Freezing ${session.name} (${session.id}) — long prompt cache expired`);
      this.sessionManager.setSessionFrozen(session.id, true);
    }
  }
}
