import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../src/types/session.js';
import {
  isClaudeSubscriptionQuotaEnvironment,
  parseClaudeStatuslineQuota,
  quotaUsageLevel,
  type SessionQuotaUsageSnapshot,
} from '../../src/session/quota-usage.js';
import { SessionQuotaUsageTracker } from '../../src/session/session-quota-usage-tracker.js';

const FIVE_HOURS = 5 * 60 * 60_000;
const WEEK = 7 * 24 * 60 * 60_000;

function statusline(now: number, fiveHour = 72, weekly = 41) {
  return {
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: new Date(now + FIVE_HOURS).toISOString() },
      seven_day: { used_percentage: weekly, resets_at: new Date(now + WEEK).toISOString() },
    },
  };
}

describe('parseClaudeStatuslineQuota', () => {
  it('accepts resets_at as Unix epoch seconds, as Claude Code sends it', () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const epochSeconds = (ms: number) => ms / 1000;
    expect(parseClaudeStatuslineQuota({ rate_limits: {
      five_hour: { used_percentage: 72, resets_at: epochSeconds(now + FIVE_HOURS) },
      seven_day: { used_percentage: 41, resets_at: epochSeconds(now + WEEK) },
    } }, now)).toEqual({
      fiveHour: { usedPercent: 72, resetsAtEpochMs: now + FIVE_HOURS },
      weekly: { usedPercent: 41, resetsAtEpochMs: now + WEEK },
      measuredAtEpochMs: now,
    });
  });

  it('accepts only a fresh complete five-hour and weekly snapshot', () => {
    const now = Date.now();
    expect(parseClaudeStatuslineQuota(statusline(now), now)).toEqual({
      fiveHour: { usedPercent: 72, resetsAtEpochMs: now + FIVE_HOURS },
      weekly: { usedPercent: 41, resetsAtEpochMs: now + WEEK },
      measuredAtEpochMs: now,
    });
  });

  it('hides API usage, partial windows, malformed percentages, and expired resets', () => {
    const now = Date.now();
    expect(parseClaudeStatuslineQuota({}, now)).toBeNull();
    expect(parseClaudeStatuslineQuota({ rate_limits: { five_hour: statusline(now).rate_limits.five_hour } }, now)).toBeNull();
    expect(parseClaudeStatuslineQuota(statusline(now, 101), now)).toBeNull();
    expect(parseClaudeStatuslineQuota({ rate_limits: {
      five_hour: { used_percentage: 20, resets_at: new Date(now - 1).toISOString() },
      seven_day: statusline(now).rate_limits.seven_day,
    } }, now)).toBeNull();
  });

  it('does not treat an API credential or gateway override as a subscription', () => {
    expect(isClaudeSubscriptionQuotaEnvironment({})).toBe(true);
    expect(isClaudeSubscriptionQuotaEnvironment({ ANTHROPIC_API_KEY: 'set' })).toBe(false);
    expect(isClaudeSubscriptionQuotaEnvironment({ ANTHROPIC_BASE_URL: 'https://gateway.invalid' })).toBe(false);
    expect(isClaudeSubscriptionQuotaEnvironment({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(false);
  });
});

describe('quotaUsageLevel', () => {
  it('turns amber at 75% consumed and red at 90%', () => {
    expect([74, 75, 89, 90].map(quotaUsageLevel)).toEqual(['ok', 'warn', 'warn', 'hot']);
  });
});

class SessionStore extends EventEmitter {
  readonly sessions = new Map<string, SessionInfo>();

  add(session: SessionInfo): void {
    this.sessions.set(session.id, session);
    this.emit('session:added', session);
  }

  getSession(id: string): SessionInfo | null { return this.sessions.get(id) ?? null; }
  getAllSessions(): SessionInfo[] { return [...this.sessions.values()]; }
  updateSession(id: string, updates: Partial<SessionInfo>): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Missing session ${id}`);
    Object.assign(session, updates);
    this.emit('session:updated', session);
  }
}

function session(id: string, cliType = 'claude-main'): SessionInfo {
  return {
    id,
    name: id,
    cliType,
    processId: 1,
  };
}

function snapshot(now = Date.now()): SessionQuotaUsageSnapshot {
  return parseClaudeStatuslineQuota(statusline(now), now)!;
}

describe('SessionQuotaUsageTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('fans a complete snapshot across Claude CLI types sharing an account scope', () => {
    const store = new SessionStore();
    store.add(session('a'));
    store.add(session('b'));
    store.add(session('different-type', 'claude-other'));
    store.add(session('other-account', 'claude-main'));
    store.add(session('codex', 'codex-main'));
    const tracker = new SessionQuotaUsageTracker({
      sessionManager: store,
      scopeFor: value => value.cliType.startsWith('claude')
        ? `profile-${value.id === 'other-account' ? '2' : '1'}`
        : null,
    });
    tracker.start();

    expect(tracker.report('a', snapshot())).toBe(true);
    expect(store.getSession('a')?.quotaUsage).toEqual(store.getSession('b')?.quotaUsage);
    expect(store.getSession('different-type')?.quotaUsage).toEqual(store.getSession('a')?.quotaUsage);
    expect(store.getSession('other-account')?.quotaUsage).toBeUndefined();
    expect(store.getSession('codex')?.quotaUsage).toBeUndefined();
    tracker.stop();
  });

  it('shares to later sessions and clears the scope when a partial snapshot arrives', () => {
    const store = new SessionStore();
    store.add(session('a'));
    const tracker = new SessionQuotaUsageTracker({
      sessionManager: store,
      scopeFor: value => value.cliType.startsWith('claude') ? `profile-1:${value.cliType}` : null,
    });
    tracker.start();
    tracker.report('a', snapshot());
    store.add(session('later'));
    expect(store.getSession('later')?.quotaUsage).toEqual(store.getSession('a')?.quotaUsage);

    tracker.report('a', null);
    expect(store.getSession('a')?.quotaUsage).toBeNull();
    expect(store.getSession('later')?.quotaUsage).toBeNull();
    tracker.stop();
  });

  it('removes snapshots at the earlier reset or freshness deadline', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const store = new SessionStore();
    store.add(session('a'));
    const tracker = new SessionQuotaUsageTracker({
      sessionManager: store,
      scopeFor: value => value.cliType.startsWith('claude') ? `profile-1:${value.cliType}` : null,
      maxAgeMs: 60_000,
    });
    tracker.start();
    tracker.report('a', snapshot(now));
    vi.advanceTimersByTime(59_999);
    expect(store.getSession('a')?.quotaUsage).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.getSession('a')?.quotaUsage).toBeNull();
    tracker.stop();
  });

  it('clears rather than sharing an expired or malformed snapshot', () => {
    const store = new SessionStore();
    store.add(session('a'));
    store.getSession('a')!.quotaUsage = snapshot(Date.now() - 120_000);
    const tracker = new SessionQuotaUsageTracker({
      sessionManager: store,
      scopeFor: value => value.cliType.startsWith('claude') ? `profile-1:${value.cliType}` : null,
      maxAgeMs: 60_000,
    });
    tracker.start();
    tracker.report('a', snapshot(Date.now() - 120_000));
    expect(store.getSession('a')?.quotaUsage).toBeNull();
    tracker.stop();
  });

  it('clears API-mode rows without clearing another subscription session in the same scope', () => {
    const store = new SessionStore();
    store.add(session('subscription'));
    store.add(session('api-mode', 'claude-api'));
    const tracker = new SessionQuotaUsageTracker({
      sessionManager: store,
      scopeFor: value => value.cliType === 'claude-main' ? 'shared-subscription' : null,
    });
    store.getSession('api-mode')!.quotaUsage = snapshot();
    tracker.start();
    tracker.report('subscription', snapshot());

    expect(tracker.clearSession('api-mode')).toBe(true);
    expect(store.getSession('api-mode')?.quotaUsage).toBeNull();
    expect(store.getSession('subscription')?.quotaUsage).not.toBeNull();
    tracker.stop();
  });
});
