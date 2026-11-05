import type { SessionManager } from './manager.js';
import { dormantAfterMs, type StalenessThresholds } from './prompt-staleness.js';
import { buildKeepWarmPrompt } from './keep-warm-prompt.js';
import { logger } from '../utils/logger.js';

const TICK_MS = 10_000;

/** Ping this long before the CLI's short prompt cache would lapse (5 min → 4:50). */
export const KEEP_WARM_MARGIN_MS = 10_000;

/** When to ping: the CLI type's short cache window minus the margin. Never, with no prompt cache. */
export function keepWarmAfterMs(t: StalenessThresholds | null | undefined): number {
  return dormantAfterMs(t) - KEEP_WARM_MARGIN_MS;
}

/** How long one "Keep warm" switch-on lasts before it turns itself off. */
export const KEEP_WARM_DEFAULT_MS = 8 * 3_600_000;

/** The CLI-type settings the warmer reads. */
export type KeepWarmConfig = StalenessThresholds & { keepWarmPrompt?: string };

/**
 * Keeps a session's prompt cache warm on request: just before its CLI's short
 * cache lapses (cacheWarnMinutes minus 10 s) it sends one tiny prompt, so the
 * next real prompt still hits the cheap cache. Each ping costs a short turn,
 * so it is opt-in per session and lapses at `keepWarmUntil`. A busy session is already warming itself; a frozen one
 * takes no input at all.
 */
export class KeepWarmer {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last skip reason logged per due session, so a held skip logs once, not every tick. */
  private readonly skipLogged = new Map<string, string>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly send: (sessionId: string, text: string) => Promise<void>,
    private readonly cliConfig: (cliType: string) => KeepWarmConfig | null | undefined,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const session of this.sessionManager.getAllSessions()) {
      if (session.comfyUiTool) continue;
      if (session.keepWarmUntil === undefined) continue;
      if (now > session.keepWarmUntil) {
        logger.info(`[KeepWarmer] Keep-warm on ${session.name} (${session.id}) expired`);
        this.sessionManager.updateSession(session.id, { keepWarmUntil: undefined });
        this.skipLogged.delete(session.id);
        continue;
      }
      const config = this.cliConfig(session.cliType);
      const anchor = session.lastPromptAt ?? session.createdAt ?? now;
      const since = now - anchor;
      const dueAfter = keepWarmAfterMs(config);
      if (since < dueAfter) {
        this.skipLogged.delete(session.id);
        continue;
      }
      const skip = session.frozen ? 'frozen' : session.activityLevel === 'active' ? 'busy' : null;
      if (skip) {
        if (this.skipLogged.get(session.id) !== skip) {
          this.skipLogged.set(session.id, skip);
          logger.info(`[KeepWarmer] Ping due on ${session.name} (${session.id}) but skipped: ${skip} (age ${Math.round(since / 1000)}s, due at ${Math.round(dueAfter / 1000)}s)`);
        }
        continue;
      }
      this.skipLogged.delete(session.id);
      logger.info(`[KeepWarmer] Pinging ${session.name} (${session.id}) — age ${Math.round(since / 1000)}s, due at ${Math.round(dueAfter / 1000)}s`);
      // Stamped before the send so a slow delivery cannot double-ping on the next tick.
      this.sessionManager.updateSession(session.id, { lastPromptAt: now });
      try {
        await this.send(session.id, buildKeepWarmPrompt(config?.keepWarmPrompt));
      } catch (error) {
        logger.warn(`[KeepWarmer] Ping to ${session.id} failed: ${error}`);
      }
    }
  }
}
