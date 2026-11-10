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
