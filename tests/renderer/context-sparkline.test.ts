import { describe, expect, it } from 'vitest';
import { contextFillLevel, sparklineGeometry, windowSamples } from '../../renderer/context-sparkline.js';

describe('sparklineGeometry', () => {
  it('scales points against the context window, newest on the right edge', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 0 }, { at: 10, tokens: 100 }], 200, { width: 100, height: 20 });
    expect(g?.points).toEqual([{ x: 0, y: 20 }, { x: 100, y: 10 }]);
    expect(g?.line).toBe('M0 20 L100 10');
    expect(g?.area).toBe('M0 20 L100 10 L100 20 L0 20 Z');
  });

  it('places points by time, so a long gap stays a long gap', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 1 }, { at: 1, tokens: 1 }, { at: 10, tokens: 1 }], 2, { width: 100, height: 10 });
    expect(g?.points.map((p) => p.x)).toEqual([0, 10, 100]);
  });

  it('falls back to the peak when no window is known', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 50 }, { at: 1, tokens: 100 }], undefined, { width: 10, height: 10 });
    expect(g?.points.at(-1)?.y).toBe(0);
  });

  it('needs at least two samples to draw a line', () => {
    expect(sparklineGeometry([{ at: 0, tokens: 5 }], 10, { width: 10, height: 10 })).toBeUndefined();
    expect(sparklineGeometry(undefined, 10, { width: 10, height: 10 })).toBeUndefined();
  });
});

describe('windowSamples', () => {
  it('keeps the last window, carrying the earlier level in from the left and the latest out to now', () => {
    const samples = [{ at: 0, tokens: 10 }, { at: 50, tokens: 20 }, { at: 80, tokens: 30 }];
    expect(windowSamples(samples, 40, 100)).toEqual([
      { at: 40, tokens: 10 }, { at: 50, tokens: 20 }, { at: 80, tokens: 30 }, { at: 100, tokens: 30 },
    ]);
  });

  it('draws an idle session as a flat line at its last level', () => {
    expect(windowSamples([{ at: 0, tokens: 7 }], 40, 100)).toEqual([{ at: 40, tokens: 7 }, { at: 100, tokens: 7 }]);
  });

  it('has nothing to draw before the first reading', () => {
    expect(windowSamples([{ at: 120, tokens: 7 }], 40, 100)).toEqual([]);
    expect(windowSamples(undefined, 40, 100)).toEqual([]);
  });
});

describe('contextFillLevel', () => {
  it('turns amber above 70% and red above 85% of the window', () => {
    expect(contextFillLevel({ tokens: 70, window: 100 })).toBe('ok');
    expect(contextFillLevel({ tokens: 71, window: 100 })).toBe('warn');
    expect(contextFillLevel({ tokens: 86, window: 100 })).toBe('hot');
    expect(contextFillLevel({ tokens: 99 })).toBe('ok');
  });
});
