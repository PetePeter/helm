import type { SessionManager } from './manager.js';
import type { SessionInfo } from '../types/session.js';
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

/**
 * The keepWarmUntil a switch-on/off writes — the one rule both the desktop
 * toggle and MCP use. On keeps a running window; off clears it. Hookless
 * sessions are refused: nothing would confirm a ping landed.
 */
export function keepWarmUntilFor(session: Pick<SessionInfo, 'name' | 'hooked' | 'keepWarmUntil'>, on: boolean, now: number): number | undefined {
  if (!on) return undefined;
  if (!session.hooked) throw new Error(`Keep-warm needs CLI hooks; ${session.name} has none installed`);
  return session.keepWarmUntil !== undefined && session.keepWarmUntil > now ? session.keepWarmUntil : now + KEEP_WARM_DEFAULT_MS;
}

/** A ping whose submit no hook confirmed (it never reached the CLI) is resent this much later. */
export const KEEP_WARM_RETRY_MS = 60_000;

/** The CLI-type settings the warmer reads. */
export type KeepWarmConfig = StalenessThresholds & { keepWarmPrompt?: string };

/**
 * Keeps a session's prompt cache warm on request: just before its CLI's short
 * cache lapses (cacheWarnMinutes minus 10 s) it sends one tiny prompt, so the
 * next real prompt still hits the cheap cache. Each ping costs a short turn,
 * so it is opt-in per session and lapses at `keepWarmUntil`.
 *
 * Hooked sessions only: their hooks restart the cache clock (lastPromptAt) on
 * every real cache touch, so a due clock means nothing touched it — whatever
 * the dot shows. The ping does not stamp the clock itself; its submit hook
 * does, and until one does the ping is resent every KEEP_WARM_RETRY_MS.
 * A frozen session takes no input at all.
 */
export class KeepWarmer {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When each session was last pinged — paces retries until a hook answers. */
  private readonly lastPingAt = new Map<string, number>();

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
      if (session.keepWarmUntil === undefined) { this.lastPingAt.delete(session.id); continue; }
      if (now > session.keepWarmUntil) {
        logger.info(`[KeepWarmer] Keep-warm on ${session.name} (${session.id}) expired`);
        this.sessionManager.updateSession(session.id, { keepWarmUntil: undefined });
        this.lastPingAt.delete(session.id);
        continue;
      }
      // Green = a hook fired within the last few minutes: a tool or thinking is still running, so a
      // ping would only queue behind it. Green cannot stick (blue 10 min after the last hook).
      if (!session.hooked || session.frozen || session.activityLevel === 'active') continue;
      const config = this.cliConfig(session.cliType);
      const anchor = session.lastPromptAt ?? session.createdAt ?? now;
      const since = now - anchor;
      const dueAfter = keepWarmAfterMs(config);
      if (since < dueAfter) continue;
      const pingedAt = this.lastPingAt.get(session.id);
      // A ping after the clock's last restart is still unanswered: wait out the retry gap.
      if (pingedAt !== undefined && pingedAt > anchor && now - pingedAt < KEEP_WARM_RETRY_MS) continue;
      const retry = pingedAt !== undefined && pingedAt > anchor ? ' (retry: no submit hook yet)' : '';
      logger.info(`[KeepWarmer] Pinging ${session.name} (${session.id}) — age ${Math.round(since / 1000)}s, due at ${Math.round(dueAfter / 1000)}s${retry}`);
      // Recorded before the send so a slow delivery cannot double-ping on the next tick.
      this.lastPingAt.set(session.id, now);
      try {
        await this.send(session.id, buildKeepWarmPrompt(config?.keepWarmPrompt));
      } catch (error) {
        logger.warn(`[KeepWarmer] Ping to ${session.id} failed: ${error}`);
      }
    }
  }
}
