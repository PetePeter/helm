import type { HookEvent } from './hooks/hook-normaliser.js';
import type { SessionInfo, SessionContextUsageSnapshot } from '../types/session.js';
import type { SessionContextSize } from './context-size.js';
import { logger } from '../utils/logger.js';

interface SessionUsageStore {
  getAllSessions(): SessionInfo[];
  getSession(sessionId: string): SessionInfo | null;
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;
  on(event: 'session:added' | 'session:updated', listener: (session: SessionInfo) => void): unknown;
  off(event: 'session:added' | 'session:updated', listener: (session: SessionInfo) => void): unknown;
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
  /** Floor between transcript reads for one session, so a tool-heavy turn does not re-read per call. */
  minRefreshIntervalMs?: number;
}

const REFRESH_EVENTS = new Set<HookEvent['event']>([
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'StopFailure',
]);

/**
 * Keeps a persisted, last-known context snapshot on each session. Initial
 * backfill yields between bounded transcript reads; later reads happen only
 * for the session whose hook reports a start or finished turn, or whose
 * transcript path first appears after startup (a resumed session may not
 * finish a turn for a long while, and would otherwise show no label).
 */
export class SessionContextUsageTracker {
  private readonly sessionManager: SessionUsageStore;
  private readonly resolve: SessionContextUsageTrackerOptions['resolve'];
  private readonly refreshDelayMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly lastRefreshAt = new Map<string, number>();
  private hookSource?: HookEventSource;
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private hydrationTimer?: ReturnType<typeof setTimeout>;
  private hydrationQueue: string[] = [];
  /** Transcript path last read per session, so a path that yields no usage is not re-read on every update. */
  private readonly attemptedPath = new Map<string, string>();

  constructor(options: SessionContextUsageTrackerOptions) {
    this.sessionManager = options.sessionManager;
    this.resolve = options.resolve;
    this.refreshDelayMs = options.refreshDelayMs ?? 300;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 2000;
  }

  start(hookSource: HookEventSource): void {
    if (this.hookSource) return;
    this.hookSource = hookSource;
    hookSource.on('hook', this.onHook);
    this.sessionManager.on('session:added', this.onSession);
    this.sessionManager.on('session:updated', this.onSession);
    this.hydrationQueue = this.sessionManager.getAllSessions()
      .filter((session) => !session.remote && !session.contextUsage && session.cliTranscriptPath)
      .map((session) => session.id);
    this.scheduleNextHydration();
  }

  stop(): void {
    if (this.hookSource) {
      this.hookSource.off('hook', this.onHook);
      this.sessionManager.off('session:added', this.onSession);
      this.sessionManager.off('session:updated', this.onSession);
    }
    this.attemptedPath.clear();
    this.lastRefreshAt.clear();
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

  private readonly onSession = (session: SessionInfo): void => {
    const path = session.cliTranscriptPath;
    if (session.remote || session.contextUsage || !path || this.attemptedPath.get(session.id) === path) return;
    this.scheduleRefresh(session.id);
  };

  /** Trailing throttle: one pending read per session, so the last value of a burst always lands. */
  private scheduleRefresh(sessionId: string): void {
    if (this.refreshTimers.has(sessionId)) return;
    const sinceLast = Date.now() - (this.lastRefreshAt.get(sessionId) ?? -Infinity);
    const delay = Math.max(this.refreshDelayMs, this.minRefreshIntervalMs - sinceLast);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(sessionId);
      this.refresh(sessionId);
    }, delay);
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
    this.lastRefreshAt.set(sessionId, Date.now());
    if (session.cliTranscriptPath) this.attemptedPath.set(sessionId, session.cliTranscriptPath);
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
