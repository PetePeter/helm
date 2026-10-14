import type { HookEvent } from './hooks/hook-normaliser.js';
import type { SessionInfo, SessionContextUsageSnapshot } from '../types/session.js';
import type { SessionContextSize } from './context-size.js';
import { logger } from '../utils/logger.js';

interface SessionUsageStore {
  getAllSessions(): SessionInfo[];
  getSession(sessionId: string): SessionInfo | null;
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;
}

interface HookEventSource {
  on(event: 'hook', listener: (event: HookEvent) => void): unknown;
  off(event: 'hook', listener: (event: HookEvent) => void): unknown;
}

export interface SessionContextUsageTrackerOptions {
  sessionManager: SessionUsageStore;
  resolve: (session: SessionInfo) => SessionContextSize | undefined;
  /** Delay hook refreshes until the CLI has finished writing its transcript. */
  refreshDelayMs?: number;
}

const REFRESH_EVENTS = new Set<HookEvent['event']>(['SessionStart', 'Stop', 'StopFailure']);

/**
 * Keeps a persisted, last-known context snapshot on each session. Initial
 * backfill yields between bounded transcript reads; later reads happen only
 * for the session whose hook reports a start or finished turn.
 */
export class SessionContextUsageTracker {
  private readonly sessionManager: SessionUsageStore;
  private readonly resolve: SessionContextUsageTrackerOptions['resolve'];
  private readonly refreshDelayMs: number;
  private hookSource?: HookEventSource;
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private hydrationTimer?: ReturnType<typeof setTimeout>;
  private hydrationQueue: string[] = [];

  constructor(options: SessionContextUsageTrackerOptions) {
    this.sessionManager = options.sessionManager;
    this.resolve = options.resolve;
    this.refreshDelayMs = options.refreshDelayMs ?? 300;
  }

  start(hookSource: HookEventSource): void {
    if (this.hookSource) return;
    this.hookSource = hookSource;
    hookSource.on('hook', this.onHook);
    this.hydrationQueue = this.sessionManager.getAllSessions()
      .filter((session) => !session.remote && !session.contextUsage && session.cliTranscriptPath)
      .map((session) => session.id);
    this.scheduleNextHydration();
  }

  stop(): void {
    if (this.hookSource) this.hookSource.off('hook', this.onHook);
    this.hookSource = undefined;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    if (this.hydrationTimer !== undefined) clearTimeout(this.hydrationTimer);
    this.hydrationTimer = undefined;
    this.hydrationQueue = [];
  }

  private readonly onHook = (event: HookEvent): void => {
    if (!event.helmSessionId || !REFRESH_EVENTS.has(event.event)) return;
    this.scheduleRefresh(event.helmSessionId);
  };

  private scheduleRefresh(sessionId: string): void {
    const previous = this.refreshTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(sessionId);
      this.refresh(sessionId);
    }, this.refreshDelayMs);
    this.refreshTimers.set(sessionId, timer);
  }

  private scheduleNextHydration(): void {
    if (this.hydrationTimer !== undefined || this.hydrationQueue.length === 0) return;
    this.hydrationTimer = setTimeout(() => {
      this.hydrationTimer = undefined;
      const sessionId = this.hydrationQueue.shift();
      if (sessionId) this.refresh(sessionId);
      this.scheduleNextHydration();
    }, 0);
  }

  private refresh(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;
    try {
      const context = this.resolve(session);
      const contextUsage = context?.known
        ? {
          tokens: context.tokens,
          ...(context.window !== undefined ? { window: context.window } : {}),
          ...(context.measuredAtIso ? { measuredAtIso: context.measuredAtIso } : {}),
        }
        : undefined;
      if (sameSnapshot(session.contextUsage, contextUsage)) return;
      this.sessionManager.updateSession(sessionId, { contextUsage });
    } catch (error) {
      logger.warn(`[SessionContextUsage] Refresh failed for ${sessionId}: ${String(error)}`);
    }
  }

  /** Refresh immediately when an API session updates its in-memory context. */
  refreshSession(sessionId: string): void {
    this.refresh(sessionId);
  }
}

function sameSnapshot(
  current: SessionContextUsageSnapshot | undefined,
  next: SessionContextUsageSnapshot | undefined,
): boolean {
  return current?.tokens === next?.tokens
    && current?.window === next?.window
    && current?.measuredAtIso === next?.measuredAtIso;
}
