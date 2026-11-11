import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isFreshQuotaUsageSnapshot,
  parseCodexRateLimits,
  quotaScope,
  readCodexTranscriptQuota,
  SESSION_QUOTA_USAGE_MAX_AGE_MS,
} from '../../src/session/quota-usage.js';

const FIVE_HOURS_S = 5 * 60 * 60;
const WEEK_S = 7 * 24 * 60 * 60;

/** The exact shape Codex writes to its rollout JSONL. */
function tokenCount(now: number, fiveHour = 13, weekly = 65, swap = false) {
  const nowS = Math.floor(now / 1000);
  const primary = { used_percent: fiveHour, window_minutes: 300, resets_at: nowS + FIVE_HOURS_S };
  const secondary = { used_percent: weekly, window_minutes: 10080, resets_at: nowS + WEEK_S };
  return {
    timestamp: new Date(now).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 200000 },
      rate_limits: {
        limit_id: 'codex',
        primary: swap ? secondary : primary,
        secondary: swap ? primary : secondary,
        credits: { has_credits: false, unlimited: false, balance: '0' },
      },
    },
  };
}

function transcript(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'codex-quota-')), 'rollout.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('parseCodexRateLimits', () => {
  it('maps windows by length, not by primary/secondary slot', () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const expected = {
      fiveHour: { usedPercent: 13, resetsAtEpochMs: now + FIVE_HOURS_S * 1000 },
      weekly: { usedPercent: 65, resetsAtEpochMs: now + WEEK_S * 1000 },
      measuredAtEpochMs: now,
    };
    expect(parseCodexRateLimits(tokenCount(now), now)).toEqual(expected);
    expect(parseCodexRateLimits(tokenCount(now, 13, 65, true), now)).toEqual(expected);
  });

  it('ignores non token_count lines and rejects partial, malformed or expired windows', () => {
    const now = Date.now();
    expect(parseCodexRateLimits({ type: 'response_item', payload: {} }, now)).toBeUndefined();
    const partial = tokenCount(now);
    delete (partial.payload.rate_limits as Record<string, unknown>).secondary;
    expect(parseCodexRateLimits(partial, now)).toBeNull();
    expect(parseCodexRateLimits(tokenCount(now, 101), now)).toBeNull();
    const expired = tokenCount(now);
    expired.payload.rate_limits.primary.resets_at = Math.floor(now / 1000) - 1;
    expect(parseCodexRateLimits(expired, now)).toBeNull();
  });
});

describe('readCodexTranscriptQuota', () => {
  it('returns the latest token_count and skips a torn final line', () => {
    const now = Date.now();
    const path = transcript([
      JSON.stringify(tokenCount(now - 60_000, 10, 60)),
      JSON.stringify({ type: 'response_item', payload: {} }),
      JSON.stringify(tokenCount(now, 20, 70)),
      '{"type":"event_msg","payl',
    ]);
    const quota = readCodexTranscriptQuota(path, now);
    expect(quota?.fiveHour.usedPercent).toBe(20);
    expect(quota?.weekly.usedPercent).toBe(70);
  });

  it('stamps the log line time so an old log is never fresh', () => {
    const now = Date.now();
    const old = now - SESSION_QUOTA_USAGE_MAX_AGE_MS - 1;
    const quota = readCodexTranscriptQuota(transcript([JSON.stringify(tokenCount(old))]), now);
    expect(quota?.measuredAtEpochMs).toBe(old);
    expect(isFreshQuotaUsageSnapshot(quota!, now, SESSION_QUOTA_USAGE_MAX_AGE_MS)).toBe(false);
  });

  it('is undefined for an unreadable path or a log without limits', () => {
    expect(readCodexTranscriptQuota(join(tmpdir(), 'missing-codex.jsonl'))).toBeUndefined();
    expect(readCodexTranscriptQuota(transcript([JSON.stringify({ type: 'session_meta' })]))).toBeUndefined();
  });
});

describe('quotaScope', () => {
  it('shares one Codex home across CLI types and isolates another home or provider', () => {
    const a = quotaScope('profile-1', 'codex', { CODEX_HOME: 'C:/codex-a' });
    expect(quotaScope('profile-1', 'codex', { CODEX_HOME: 'C:/codex-a' })).toBe(a);
    expect(quotaScope('profile-1', 'codex', { CODEX_HOME: 'C:/codex-b' })).not.toBe(a);
    expect(quotaScope('profile-2', 'codex', { CODEX_HOME: 'C:/codex-a' })).not.toBe(a);
    expect(quotaScope('profile-1', 'claude', { CODEX_HOME: 'C:/codex-a' })).not.toBe(a);
  });

  it('has no scope for a Claude API-key environment or an unsupported provider', () => {
    expect(quotaScope('profile-1', 'claude', { ANTHROPIC_API_KEY: 'set' })).toBeNull();
    expect(quotaScope('profile-1', 'copilot', {})).toBeNull();
  });
});
