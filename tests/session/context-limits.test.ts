import { describe, expect, it } from 'vitest';
import { contextLevel, contextRing, resolveContextLimits } from '../../src/session/context-limits.js';

/**
 * Cross-language vectors: android/.../ContextRingTest.kt asserts the same rows,
 * so the phone and the desktop can never draw a different ring for one reading.
 */
const RING_VECTORS: Array<{
  name: string; tokens: number; limits: { amber: number; red: number };
  fill: number; amberAt: number; level: 'ok' | 'warn' | 'hot'; overflow: boolean;
}> = [
  { name: 'empty', tokens: 0, limits: { amber: 150_000, red: 180_000 }, fill: 0, amberAt: 0.75, level: 'ok', overflow: false },
  { name: 'half of an auto window', tokens: 100_000, limits: { amber: 150_000, red: 180_000 }, fill: 0.5, amberAt: 0.75, level: 'ok', overflow: false },
  { name: 'exactly amber is still ok', tokens: 150_000, limits: { amber: 150_000, red: 180_000 }, fill: 0.75, amberAt: 0.75, level: 'ok', overflow: false },
  { name: 'past amber', tokens: 150_001, limits: { amber: 150_000, red: 180_000 }, fill: 0.75, amberAt: 0.75, level: 'warn', overflow: false },
  { name: 'past red', tokens: 180_001, limits: { amber: 150_000, red: 180_000 }, fill: 0.9, amberAt: 0.75, level: 'hot', overflow: false },
  { name: 'exactly the window is full, not overflowing', tokens: 200_000, limits: { amber: 150_000, red: 180_000 }, fill: 1, amberAt: 0.75, level: 'hot', overflow: false },
  { name: 'beyond the window overflows', tokens: 230_000, limits: { amber: 150_000, red: 180_000 }, fill: 1, amberAt: 0.75, level: 'hot', overflow: true },
  { name: 'user limit puts red at 90% of the circle', tokens: 160_000, limits: { amber: 120_000, red: 160_000 }, fill: 0.9, amberAt: 0.675, level: 'warn', overflow: false },
  { name: 'user limit overflows past the circle', tokens: 200_000, limits: { amber: 120_000, red: 160_000 }, fill: 1, amberAt: 0.675, level: 'hot', overflow: true },
];

describe('contextRing', () => {
  it.each(RING_VECTORS)('$name', ({ tokens, limits, fill, amberAt, level, overflow }) => {
    const ring = contextRing(tokens, limits);
    expect(ring?.fill).toBeCloseTo(fill, 4);
    expect(ring?.amberAt).toBeCloseTo(amberAt, 4);
    expect(ring?.redAt).toBe(0.9);
    expect(ring?.level).toBe(level);
    expect(ring?.overflow).toBe(overflow);
  });

  it('has no ring without limits, so the caller draws a plain dot', () => {
    expect(contextRing(50_000, undefined)).toBeUndefined();
  });
});

describe('resolveContextLimits', () => {
  it('defaults to amber at 75% and red at 90% of the window', () => {
    expect(resolveContextLimits(undefined, 200_000)).toEqual({ amber: 150_000, red: 180_000 });
  });

  it('uses the CLI type\'s manual token counts regardless of the window', () => {
    expect(resolveContextLimits({ contextLimits: { amber: 100_000, red: 120_000 } }, 1_000_000))
      .toEqual({ amber: 100_000, red: 120_000 });
    expect(resolveContextLimits({ contextLimits: { amber: 100_000, red: 120_000 } }, undefined))
      .toEqual({ amber: 100_000, red: 120_000 });
  });

  it('ignores manual limits whose red is not above amber, falling back to auto', () => {
    expect(resolveContextLimits({ contextLimits: { amber: 120_000, red: 120_000 } }, 100))
      .toEqual({ amber: 75, red: 90 });
    expect(resolveContextLimits({ contextLimits: { amber: 0, red: 5 } }, 100))
      .toEqual({ amber: 75, red: 90 });
  });

  it('has no limits without a window or manual limits', () => {
    expect(resolveContextLimits({}, undefined)).toBeUndefined();
    expect(resolveContextLimits(null, 0)).toBeUndefined();
  });
});

describe('contextLevel', () => {
  const limits = { amber: 75, red: 90 };
  it('turns amber above the amber limit and red above the red limit', () => {
    expect(contextLevel(75, limits)).toBe('ok');
    expect(contextLevel(76, limits)).toBe('warn');
    expect(contextLevel(90, limits)).toBe('warn');
    expect(contextLevel(91, limits)).toBe('hot');
  });

  it('stays ok when no limits are known', () => {
    expect(contextLevel(1_000_000, undefined)).toBe('ok');
  });
});
