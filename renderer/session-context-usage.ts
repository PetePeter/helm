import type { SessionContextUsageSnapshot } from '../src/types/session.js';
import type { QuotaBurn } from '../src/session/quota-burn.js';

function validPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function compactTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

export function formatSessionContextUsage(usage: SessionContextUsageSnapshot | undefined): string | undefined {
  if (!usage || !validPositive(usage.tokens)) return undefined;
  const count = `ctx ${compactTokenCount(usage.tokens)}`;
  return validPositive(usage.window)
    ? `${count} · ${Math.round(usage.tokens / usage.window * 100)}%`
    : count;
}

export function sessionContextUsageTitle(usage: SessionContextUsageSnapshot | undefined): string | undefined {
  if (!usage || !validPositive(usage.tokens)) return undefined;
  const tokens = Math.round(usage.tokens).toLocaleString('en-US');
  if (!validPositive(usage.window)) return `${tokens} context tokens`;
  const contextWindow = Math.round(usage.window).toLocaleString('en-US');
  return `${tokens} context tokens · ${Math.round(usage.tokens / usage.window * 100)}% of ${contextWindow}`;
}

/** "resets in 3h 12m" style countdown; undefined once the reset has passed. */
/** "3h 20m", "2d 4h", "12m", "<1m". */
function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatQuotaResetIn(resetsAtEpochMs: number, now = Date.now()): string | undefined {
  if (!(resetsAtEpochMs > now)) return undefined;
  return `resets in ${formatSpan(resetsAtEpochMs - now)}`;
}

/** "12%/h · out in 3h 20m", or "lasts to reset" when the burn is flat or slow enough. */
export function formatQuotaBurn(burn: QuotaBurn | null): string | undefined {
  if (!burn) return undefined;
  if (burn.outInMs == null || !burn.beforeReset) {
    return Math.round(burn.perHour) > 0 ? `${Math.round(burn.perHour)}%/h · lasts to reset` : 'lasts to reset';
  }
  return `${Math.round(burn.perHour)}%/h · out in ${formatSpan(burn.outInMs)}`;
}
