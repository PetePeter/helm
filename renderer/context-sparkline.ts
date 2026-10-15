import type { ContextUsageSample, SessionContextUsageSnapshot } from '../src/types/session.js';

export interface SparklinePoint { x: number; y: number }
export interface SparklineGeometry { points: SparklinePoint[]; line: string; area: string }
export type ContextFillLevel = 'ok' | 'warn' | 'hot';

const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * Plot readings in a width×height box: x by time, y as a fraction of the
 * context window (or of the peak when the window is unknown).
 */
export function sparklineGeometry(
  samples: readonly ContextUsageSample[] | undefined,
  window: number | undefined,
  box: { width: number; height: number },
): SparklineGeometry | undefined {
  if (!samples || samples.length < 2) return undefined;
  const first = samples[0].at;
  const span = Math.max(samples.at(-1)!.at - first, 1);
  const ceiling = window && window > 0 ? window : Math.max(...samples.map((s) => s.tokens), 1);
  const points = samples.map((s) => ({
    x: round((s.at - first) / span * box.width),
    y: round(box.height - Math.min(s.tokens / ceiling, 1) * box.height),
  }));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  const area = `${line} L${points.at(-1)!.x} ${box.height} L${points[0].x} ${box.height} Z`;
  return { points, line, area };
}

/** The row graph's fixed span, so rows share one time scale and stay comparable. */
export const ROW_GRAPH_SPAN_MS = 2 * 60 * 60 * 1000;

/**
 * Clip readings to [from, to]. The level before the window carries in from the
 * left edge and the latest level runs out to `to`, so an idle session reads as a
 * flat line rather than vanishing.
 */
export function windowSamples(
  samples: readonly ContextUsageSample[] | undefined,
  from: number,
  to: number,
): ContextUsageSample[] {
  const known = (samples ?? []).filter((s) => s.at <= to);
  if (!known.length) return [];
  const before = known.filter((s) => s.at < from).at(-1);
  const inside = known.filter((s) => s.at >= from);
  const clipped = [...(before ? [{ at: from, tokens: before.tokens }] : []), ...inside];
  const last = clipped.at(-1)!;
  return last.at < to ? [...clipped, { at: to, tokens: last.tokens }] : clipped;
}

export function contextFillLevel(usage: Pick<SessionContextUsageSnapshot, 'tokens' | 'window'>): ContextFillLevel {
  if (!usage.window || usage.window <= 0) return 'ok';
  const fill = usage.tokens / usage.window;
  return fill > 0.85 ? 'hot' : fill > 0.7 ? 'warn' : 'ok';
}
