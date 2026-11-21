/**
 * How fast a subscription quota is being used, from a short in-memory history.
 *
 * The provider only reports "N% used" now, so the rate is the slope across the
 * last hour of readings. A window reset makes the used % drop; readings from
 * before the drop belong to the previous window and are ignored. The history
 * is coarse (one point per bucket) because it travels with every session row,
 * including to the phone. Mirrored in Android's QuotaBurn.kt.
 */
import type { SessionQuotaUsageSnapshot } from './quota-usage.js';

export interface QuotaHistoryPoint {
  at: number;
  /** Percent used of each window at [at]. */
  fiveHour: number;
  weekly: number;
}

export interface QuotaBurn {
  /** Percent of the window used per hour; 0 when not rising. */
  perHour: number;
  /** Time until 100% at that rate; null when not rising. */
  outInMs: number | null;
  /** It runs out before the window resets. */
  beforeReset: boolean;
}

export type QuotaWindowKey = 'fiveHour' | 'weekly';

export const QUOTA_HISTORY_BUCKET_MS = 10 * 60_000;
export const QUOTA_HISTORY_SPAN_MS = 5 * 60 * 60_000;
/** The graph needs this much history to be a line rather than a dot at the edge. */
export const QUOTA_GRAPH_MIN_SPAN_MS = 30 * 60_000;
const RATE_LOOKBACK_MS = 60 * 60_000;
const MIN_RATE_SPAN_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

type QuotaReading = Pick<SessionQuotaUsageSnapshot, 'fiveHour' | 'weekly' | 'measuredAtEpochMs'>;

export function appendQuotaHistory(
  history: readonly QuotaHistoryPoint[],
  snapshot: QuotaReading,
  now: number,
): QuotaHistoryPoint[] {
  const kept = history.filter((point) => now - point.at <= QUOTA_HISTORY_SPAN_MS);
  const last = kept[kept.length - 1];
  if (last && now - last.at < QUOTA_HISTORY_BUCKET_MS) return kept;
  return [...kept, { at: now, fiveHour: snapshot.fiveHour.usedPercent, weekly: snapshot.weekly.usedPercent }];
}

export function quotaGraphReady(history: readonly QuotaHistoryPoint[], measuredAt: number): boolean {
  return history.length > 0 && measuredAt - history[0].at >= QUOTA_GRAPH_MIN_SPAN_MS;
}

export function quotaBurn(
  history: readonly QuotaHistoryPoint[],
  snapshot: QuotaReading,
  key: QuotaWindowKey,
  now: number,
): QuotaBurn | null {
  const current = snapshot[key];
  const points = [...history.map((p) => ({ at: p.at, used: p[key] })), { at: snapshot.measuredAtEpochMs, used: current.usedPercent }];

  // Only the run since the last reset (a drop in used %) is this window.
  let start = points.length - 1;
  while (start > 0 && points[start - 1].used <= points[start].used) start--;
  const run = points.slice(start);

  const from = run.find((p) => now - p.at <= RATE_LOOKBACK_MS) ?? run[run.length - 1];
  const spanMs = snapshot.measuredAtEpochMs - from.at;
  if (spanMs < MIN_RATE_SPAN_MS) return null;

  const perHour = (current.usedPercent - from.used) / (spanMs / HOUR_MS);
  if (perHour <= 0) return { perHour: 0, outInMs: null, beforeReset: false };
  const outInMs = Math.round(((100 - current.usedPercent) / perHour) * HOUR_MS);
  return { perHour, outInMs, beforeReset: now + outInMs < current.resetsAtEpochMs };
}
