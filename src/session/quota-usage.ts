/** One subscription quota window reported by the provider. Percent means consumed. */
export interface SessionQuotaWindowSnapshot {
  usedPercent: number;
  resetsAtEpochMs: number;
}

/** Runtime-only provider quota data shared between sessions using one auth scope. */
export interface SessionQuotaUsageSnapshot {
  fiveHour: SessionQuotaWindowSnapshot;
  weekly: SessionQuotaWindowSnapshot;
  measuredAtEpochMs: number;
}

import { createHash } from 'node:crypto';
import { tailLines } from './transcript-usage.js';

type JsonRecord = Record<string, unknown>;

export const SESSION_QUOTA_USAGE_MAX_AGE_MS = 15 * 60_000;
export const QUOTA_AMBER_AT_PERCENT = 75;
export const QUOTA_RED_AT_PERCENT = 90;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

/** Claude Code sends resets_at as Unix epoch seconds; an ISO string is also accepted. */
function resetEpochMs(value: unknown): number {
  if (typeof value === 'number') return value * 1000;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function parseWindow(value: unknown, now: number): SessionQuotaWindowSnapshot | undefined {
  const window = record(value);
  const usedPercent = window?.used_percentage;
  const resetsAtEpochMs = resetEpochMs(window?.resets_at);
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  if (!Number.isFinite(resetsAtEpochMs) || resetsAtEpochMs <= now) return undefined;
  return { usedPercent, resetsAtEpochMs };
}

/**
 * Parse only Claude's exact, complete 5h + 7d statusline fields. A valid input
 * without both windows is explicitly unavailable; never estimate a missing one.
 */
export function parseClaudeStatuslineQuota(
  input: unknown,
  now = Date.now(),
): SessionQuotaUsageSnapshot | null | undefined {
  const payload = record(input);
  if (!payload) return undefined;
  const limits = record(payload.rate_limits);
  if (!limits) return null;

  const fiveHour = parseWindow(limits.five_hour, now);
  const weekly = parseWindow(limits.seven_day, now);
  if (!fiveHour || !weekly) return null;
  return { fiveHour, weekly, measuredAtEpochMs: now };
}

/** API keys and gateway modes have provider spend, not subscription windows. */
export function isClaudeSubscriptionQuotaEnvironment(env: Record<string, string | undefined>): boolean {
  return ![
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ].some(name => Boolean(env[name]?.trim()));
}

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
/** token_count lines arrive every turn, so a small tail always holds the latest. */
const CODEX_QUOTA_TAIL_BYTES = 256 * 1024;

/** Codex reports limits by slot; the slot order is not a contract, the window length is. */
function codexWindow(limits: JsonRecord, minutes: number, now: number): SessionQuotaWindowSnapshot | undefined {
  const window = [limits.primary, limits.secondary].map(record).find(value => value?.window_minutes === minutes);
  return window && parseWindow({ used_percentage: window.used_percent, resets_at: window.resets_at }, now);
}

/**
 * Codex writes `rate_limits` on each `token_count` event in its rollout JSONL.
 * undefined = not a token_count line; null = a line without both windows.
 * The snapshot is stamped with the line's own time so an old log is never fresh.
 */
export function parseCodexRateLimits(
  line: unknown,
  now = Date.now(),
): SessionQuotaUsageSnapshot | null | undefined {
  const value = record(line);
  const payload = record(value?.payload);
  if (value?.type !== 'event_msg' || payload?.type !== 'token_count') return undefined;
  const limits = record(payload.rate_limits);
  if (!limits) return null;
  const fiveHour = codexWindow(limits, FIVE_HOUR_WINDOW_MINUTES, now);
  const weekly = codexWindow(limits, WEEKLY_WINDOW_MINUTES, now);
  if (!fiveHour || !weekly) return null;
  const measuredAt = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
  return { fiveHour, weekly, measuredAtEpochMs: Number.isFinite(measuredAt) ? measuredAt : now };
}

/** The latest Codex quota in a transcript tail; undefined when unreadable or never reported. */
export function readCodexTranscriptQuota(
  path: string | undefined,
  now = Date.now(),
): SessionQuotaUsageSnapshot | null | undefined {
  if (!path) return undefined;
  let lines: string[];
  try {
    lines = tailLines(path, CODEX_QUOTA_TAIL_BYTES);
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let line: unknown;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue; // blank, or a final line torn mid-write
    }
    const quota = parseCodexRateLimits(line, now);
    if (quota !== undefined) return quota;
  }
  return undefined;
}

/**
 * One opaque in-memory key per profile + provider + config home: sessions in a
 * scope share one subscription account. null = no subscription quota to show.
 */
export function quotaScope(
  userProfileId: string,
  provider: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  let home: string;
  if (provider === 'claude') {
    if (!isClaudeSubscriptionQuotaEnvironment(env)) return null;
    home = env.CLAUDE_CONFIG_DIR ?? '';
  } else if (provider === 'codex') {
    home = env.CODEX_HOME ?? '';
  } else {
    return null;
  }
  return createHash('sha256').update(`${userProfileId}\0${provider}\0${home}`).digest('hex');
}

export function isFreshQuotaUsageSnapshot(
  snapshot: SessionQuotaUsageSnapshot,
  now: number,
  maxAgeMs: number,
): boolean {
  return Number.isFinite(snapshot.measuredAtEpochMs)
    && snapshot.measuredAtEpochMs > 0
    && snapshot.measuredAtEpochMs <= now
    && now - snapshot.measuredAtEpochMs <= maxAgeMs
    && [snapshot.fiveHour, snapshot.weekly].every(window =>
      Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0
      && window.usedPercent <= 100
      && Number.isFinite(window.resetsAtEpochMs)
      && window.resetsAtEpochMs > now);
}

export function quotaUsageLevel(usedPercent: number): 'ok' | 'warn' | 'hot' {
  if (usedPercent >= QUOTA_RED_AT_PERCENT) return 'hot';
  if (usedPercent >= QUOTA_AMBER_AT_PERCENT) return 'warn';
  return 'ok';
}
