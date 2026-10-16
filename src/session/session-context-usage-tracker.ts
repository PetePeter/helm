import type { HookEvent } from './hooks/hook-normaliser.js';
import type { SessionInfo, SessionContextUsageSnapshot } from '../types/session.js';
import type { SessionContextSize } from './context-size.js';
import { logger } from '../utils/logger.js';
import { appendContextSample } from './context-usage-history.js';

interface SessionUsageStore {
  getAllSessions(): SessionInfo[];
  getSession(sessionId: string): SessionInfo | null;
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;
  on(event: 'session:added' | 'session:updated', listener: (session: SessionInfo) => void): unknown;
  on(event: 'session:removed', listener: (event: { sessionId: string }) => void): unknown;
  off(event: 'session:added' | 'session:updated', listener: (session: SessionInfo) => void): unknown;
  off(event: 'session:removed', listener: (event: { sessionId: string }) => void): unknown;
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
  /** Empty means Claude has explicitly reset its context and transcript reads may still be stale. */
  private readonly emptyStatusline = new Set<string>();

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
    this.sessionManager.on('session:removed', this.onSessionRemoved);
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
      this.sessionManager.off('session:removed', this.onSessionRemoved);
    }
    this.attemptedPath.clear();
    this.lastRefreshAt.clear();
    this.emptyStatusline.clear();
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
    if (session.remote || session.contextUsage || this.emptyStatusline.has(session.id) || !path || this.attemptedPath.get(session.id) === path) return;
    this.scheduleRefresh(session.id);
  };

  private readonly onSessionRemoved = (event: { sessionId: string }): void => {
    this.emptyStatusline.delete(event.sessionId);
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
      // Claude's statusline is the only source that reports its actual model
      // window. A later transcript read must not replace that live snapshot
      // with the configured-window fallback.
      const hasStatuslineContext = context?.known === true && context.source === 'statusline';
      if (this.emptyStatusline.has(sessionId) && !hasStatuslineContext) return;
      if (
        session.contextUsage?.source === 'statusline'
        && !hasStatuslineContext
        && !hasNewerMeasurement(session.contextUsage, context)
      ) return;
      const contextUsage = context?.known
        ? {
          tokens: context.tokens,
          ...(context.window !== undefined ? { window: context.window } : {}),
          ...(context.level ? { level: context.level } : {}),
          ...(context.measuredAtIso ? { measuredAtIso: context.measuredAtIso } : {}),
          ...(context.source === 'statusline' ? { source: 'statusline' as const } : {}),
        }
        : undefined;
      if (sameSnapshot(session.contextUsage, contextUsage, session.apiTool === true)) return;
      this.storeUsage(session, contextUsage);
    } catch (error) {
      logger.warn(`[SessionContextUsage] Refresh failed for ${sessionId}: ${String(error)}`);
    }
  }

  /** Refresh immediately when an API session updates its in-memory context. */
  refreshSession(sessionId: string): void {
    this.refresh(sessionId);
  }

  /** Accept an authenticated Claude statusLine snapshot without waiting for its transcript write. */
  reportStatuslineUsage(sessionId: string, cliSessionId: string, tokens: number, window?: number): boolean {
    if (!Number.isFinite(tokens) || tokens <= 0 || (window !== undefined && (!Number.isFinite(window) || window <= 0))) {
      return false;
    }
    if (!this.correlateStatuslineSession(sessionId, cliSessionId)) return false;
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.remote) return false;
    const contextUsage: SessionContextUsageSnapshot = {
      tokens,
      ...(window !== undefined ? { window } : {}),
      measuredAtIso: new Date().toISOString(),
      source: 'statusline',
    };
    this.emptyStatusline.delete(sessionId);
    this.lastRefreshAt.set(sessionId, Date.now());
    if (sameSnapshot(session.contextUsage, contextUsage)) return true;
    this.storeUsage(session, contextUsage);
    return true;
  }

  /** Clear a statusline snapshot after Claude reports an empty window, such as immediately after /compact. */
  clearStatuslineUsage(sessionId: string, cliSessionId: string): boolean {
    if (!this.correlateStatuslineSession(sessionId, cliSessionId)) return false;
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.remote) return false;
    this.emptyStatusline.add(sessionId);
    this.lastRefreshAt.set(sessionId, Date.now());
    if (session.contextUsage) this.sessionManager.updateSession(sessionId, { contextUsage: undefined });
    return true;
  }

  /** Every new snapshot also lands in the session's history, so the fill graph sees each reading. */
  private storeUsage(session: SessionInfo, contextUsage: SessionContextUsageSnapshot | undefined): void {
    if (!contextUsage) {
      this.sessionManager.updateSession(session.id, { contextUsage });
      return;
    }
    const at = Date.parse(contextUsage.measuredAtIso ?? '');
    const contextHistory = appendContextSample(session.contextHistory, {
      at: Number.isFinite(at) ? at : Date.now(),
      tokens: contextUsage.tokens,
    });
    this.sessionManager.updateSession(session.id, { contextUsage, contextHistory });
  }

  private correlateStatuslineSession(sessionId: string, cliSessionId: string): boolean {
    const normalizedId = cliSessionId.trim();
    if (!normalizedId) return false;
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.remote || (session.cliThreadId && session.cliThreadId !== normalizedId)) return false;
    if (!session.cliThreadId) this.sessionManager.updateSession(sessionId, { cliThreadId: normalizedId });
    return true;
  }
}

function sameSnapshot(
  current: SessionContextUsageSnapshot | undefined,
  next: SessionContextUsageSnapshot | undefined,
  apiTool = false,
): boolean {
  const sameTokensAndLevel = current?.tokens === next?.tokens && current?.level === next?.level;
  if (apiTool) return sameTokensAndLevel;
  return sameTokensAndLevel
    && current?.window === next?.window
    && current?.measuredAtIso === next?.measuredAtIso
    && current?.source === next?.source;
}

function hasNewerMeasurement(
  current: SessionContextUsageSnapshot,
  next: SessionContextSize | undefined,
): boolean {
  if (!next?.known || !next.measuredAtIso || !current.measuredAtIso) return false;
  const currentTime = Date.parse(current.measuredAtIso);
  const nextTime = Date.parse(next.measuredAtIso);
  return Number.isFinite(currentTime) && Number.isFinite(nextTime) && nextTime > currentTime;
}
