import { describe, expect, it } from 'vitest';
import { contextLevel, resolveContextLimits } from '../../src/session/context-limits.js';

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
