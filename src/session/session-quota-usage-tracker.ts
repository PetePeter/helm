import type { SessionInfo } from '../types/session.js';
import {
  isFreshQuotaUsageSnapshot,
  SESSION_QUOTA_USAGE_MAX_AGE_MS,
  type SessionQuotaUsageSnapshot,
} from './quota-usage.js';

interface SessionQuotaUsageStore {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
  off(event: string | symbol, listener: (...args: any[]) => void): unknown;
  getSession(sessionId: string): SessionInfo | null;
  getAllSessions(): SessionInfo[];
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;
}

export interface SessionQuotaUsageTrackerOptions {
  sessionManager: SessionQuotaUsageStore;
  /** One opaque, runtime-local key per provider/account configuration. */
  scopeFor: (session: SessionInfo) => string | null;
  now?: () => number;
  maxAgeMs?: number;
}

/**
 * Holds fresh subscription quota snapshots in memory and fans them out only to
 * sessions with the same provider/account scope. It deliberately never persists.
 */
export class SessionQuotaUsageTracker {
  private readonly sessionManager: SessionQuotaUsageStore;
  private readonly scopeFor: SessionQuotaUsageTrackerOptions['scopeFor'];
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly snapshots = new Map<string, SessionQuotaUsageSnapshot>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  private readonly onSessionAdded = (event: { id?: string }): void => {
    if (typeof event?.id !== 'string') return;
    const session = this.sessionManager.getSession(event.id);
    const scope = session ? this.scopeFor(session) : null;
    const snapshot = scope ? this.snapshots.get(scope) : undefined;
    if (session && scope && snapshot && isFreshQuotaUsageSnapshot(snapshot, this.now(), this.maxAgeMs)) {
      this.apply(session, snapshot);
    }
  };

  constructor(options: SessionQuotaUsageTrackerOptions) {
    this.sessionManager = options.sessionManager;
    this.scopeFor = options.scopeFor;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? SESSION_QUOTA_USAGE_MAX_AGE_MS);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sessionManager.on('session:added', this.onSessionAdded);
  }

  /** Report one source reading. null means the provider has no complete subscription data. */
  report(sessionId: string, snapshot: SessionQuotaUsageSnapshot | null): boolean {
    const session = this.sessionManager.getSession(sessionId);
    const scope = session ? this.scopeFor(session) : null;
    if (!session || !scope) return false;

    if (!snapshot || !isFreshQuotaUsageSnapshot(snapshot, this.now(), this.maxAgeMs)) {
      this.clearScope(scope);
      return true;
    }

    const current = { ...snapshot, fiveHour: { ...snapshot.fiveHour }, weekly: { ...snapshot.weekly } };
    this.snapshots.set(scope, current);
    this.applyToScope(scope, current);
    this.scheduleExpiry(scope, current);
    return true;
  }

  /** Clear one session after its launch environment stops representing a subscription. */
  clearSession(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return false;
    if (session.quotaUsage != null) this.sessionManager.updateSession(sessionId, { quotaUsage: null });
    return true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.sessionManager.off('session:added', this.onSessionAdded);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.snapshots.clear();
  }

  private scheduleExpiry(scope: string, snapshot: SessionQuotaUsageSnapshot): void {
    const old = this.expiryTimers.get(scope);
    if (old) clearTimeout(old);
    const expiresAt = Math.min(
      snapshot.measuredAtEpochMs + this.maxAgeMs,
      snapshot.fiveHour.resetsAtEpochMs,
      snapshot.weekly.resetsAtEpochMs,
    );
    const delay = expiresAt - this.now();
    if (delay <= 0) {
      this.clearScope(scope);
      return;
    }
    const timer = setTimeout(() => this.clearScope(scope), delay);
    timer.unref?.();
    this.expiryTimers.set(scope, timer);
  }

  private clearScope(scope: string): void {
    const timer = this.expiryTimers.get(scope);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(scope);
    this.snapshots.delete(scope);
    for (const session of this.sessionManager.getAllSessions()) {
      if (this.scopeFor(session) === scope && session.quotaUsage != null) {
        this.sessionManager.updateSession(session.id, { quotaUsage: null });
      }
    }
  }

  private applyToScope(scope: string, snapshot: SessionQuotaUsageSnapshot): void {
    for (const session of this.sessionManager.getAllSessions()) {
      if (this.scopeFor(session) === scope) this.apply(session, snapshot);
    }
  }

  private apply(session: SessionInfo, snapshot: SessionQuotaUsageSnapshot): void {
    this.sessionManager.updateSession(session.id, { quotaUsage: snapshot });
  }
}
