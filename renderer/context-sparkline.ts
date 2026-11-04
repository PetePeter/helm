import type { ContextLimits } from '../src/session/context-limits.js';
import type { ContextUsageSample } from '../src/types/session.js';

export interface SparklinePoint { x: number; y: number }
export interface SparklineGeometry { points: SparklinePoint[]; line: string; area: string }

const round = (n: number): number => Math.round(n * 10) / 10;

/** Scale readings to observed usage and configured limits, with room above the peak. */
export function sparklineCeiling(
  samples: readonly ContextUsageSample[] | undefined,
  limits: ContextLimits | undefined,
  window: number | undefined,
): number {
  const peak = Math.max(1, ...(samples ?? []).map((sample) => sample.tokens));
  const hasWindow = window !== undefined && Number.isFinite(window) && window > 0;
  const reference = limits ? Math.max(peak, limits.red) : peak;
  const ceiling = limits || hasWindow ? reference + reference / 10 : reference;
  return hasWindow ? Math.min(ceiling, window!) : ceiling;
}

/**
 * Plot readings in a width×height box: x by time, y as a fraction of the ceiling.
 */
export function sparklineGeometry(
  samples: readonly ContextUsageSample[] | undefined,
  ceiling: number,
  box: { width: number; height: number },
): SparklineGeometry | undefined {
  if (!samples?.length) return undefined;
  const first = samples[0].at;
  const span = Math.max(samples.at(-1)!.at - first, 1);
  const scale = Math.max(ceiling, 1);
  const point = (s: ContextUsageSample) => ({
    x: round((s.at - first) / span * box.width),
    y: round(box.height - Math.min(s.tokens / scale, 1) * box.height),
  });
  const points = samples.length === 1
    ? [{ ...point(samples[0]), x: round(box.width / 2) }]
    : samples.map(point);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  const area = points.length > 1
    ? `${line} L${points.at(-1)!.x} ${box.height} L${points[0].x} ${box.height} Z`
    : '';
  return { points, line, area };
}

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

