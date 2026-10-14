import type { SessionContextUsageSnapshot } from '../src/types/session.js';

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
