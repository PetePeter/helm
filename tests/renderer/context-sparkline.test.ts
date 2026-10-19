/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ContextSparkline from '../../renderer/components/sidebar/ContextSparkline.vue';
import { ROW_GRAPH_SPAN_MS, sparklineCeiling, sparklineGeometry, windowSamples } from '../../renderer/context-sparkline.js';

it('uses a two-hour rolling window for session-list graphs', () => {
  expect(ROW_GRAPH_SPAN_MS).toBe(2 * 60 * 60 * 1000);
});

describe('sparklineGeometry', () => {
  it('scales points against the provided ceiling, newest on the right edge', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 0 }, { at: 10, tokens: 100 }], 200, { width: 100, height: 20 });
    expect(g?.points).toEqual([{ x: 0, y: 20 }, { x: 100, y: 10 }]);
    expect(g?.line).toBe('M0 20 L100 10');
    expect(g?.area).toBe('M0 20 L100 10 L100 20 L0 20 Z');
  });

  it('places points by time, so a long gap stays a long gap', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 1 }, { at: 1, tokens: 1 }, { at: 10, tokens: 1 }], 2, { width: 100, height: 10 });
    expect(g?.points.map((p) => p.x)).toEqual([0, 10, 100]);
  });

  it('scales a peak to the explicit ceiling', () => {
    const g = sparklineGeometry([{ at: 0, tokens: 50 }, { at: 1, tokens: 100 }], 100, { width: 10, height: 10 });
    expect(g?.points.at(-1)?.y).toBe(0);
  });

  it('needs at least two samples to draw a line', () => {
    expect(sparklineGeometry([{ at: 0, tokens: 5 }], 10, { width: 10, height: 10 })).toBeUndefined();
    expect(sparklineGeometry(undefined, 10, { width: 10, height: 10 })).toBeUndefined();
  });
});

describe('sparklineCeiling', () => {
  it('adds headroom above the red limit and scales the peak to that ceiling', () => {
    const samples = [{ at: 0, tokens: 0 }, { at: 10, tokens: 156_000 }];
    const ceiling = sparklineCeiling(samples, { amber: 200_000, red: 400_000 }, 1_000_000);
    expect(ceiling).toBe(440_000);
    const geometry = sparklineGeometry(samples, ceiling, { width: 100, height: 100 });
    expect(geometry?.points.at(-1)?.y).toBe(64.5);
  });

  it('adds ten percent above a peak that exceeds red', () => {
    const samples = [{ at: 0, tokens: 100_000 }, { at: 10, tokens: 500_000 }];
    expect(sparklineCeiling(samples, { amber: 300_000, red: 400_000 }, 1_000_000)).toBe(550_000);
  });

  it('never exceeds a known context window', () => {
    const samples = [{ at: 0, tokens: 500_000 }, { at: 10, tokens: 950_000 }];
    expect(sparklineCeiling(samples, { amber: 700_000, red: 900_000 }, 1_000_000)).toBe(1_000_000);
    expect(sparklineCeiling(samples, undefined, 1_000_000)).toBe(1_000_000);
  });

  it('uses the peak when neither limits nor a window are known', () => {
    const samples = [{ at: 0, tokens: 0 }, { at: 10, tokens: 156_000 }];
    expect(sparklineCeiling(samples, undefined, undefined)).toBe(156_000);
  });

  it('adds ten percent above the peak when a window is known but limits are not', () => {
    const samples = [{ at: 0, tokens: 0 }, { at: 10, tokens: 156_000 }];
    expect(sparklineCeiling(samples, undefined, 1_000_000)).toBe(171_600);
  });
});

describe('ContextSparkline guides', () => {
  it('positions the line and limit guides against the same ceiling', () => {
    const wrapper = mount(ContextSparkline, { props: {
      samples: [{ at: 0, tokens: 0 }, { at: 10, tokens: 156_000 }],
      window: 1_000_000, limits: { amber: 200_000, red: 400_000 },
      width: 100, height: 100, detailed: true,
    } });
    expect(Number(wrapper.find('circle.now').attributes('cy'))).toBe(59.4);
    const guides = wrapper.findAll('line.guide').map(line => Number(line.attributes('y1')));
    expect(guides[0]).toBeCloseTo(92 * (1 - 200_000 / 440_000));
    expect(guides[1]).toBeCloseTo(92 * (1 - 400_000 / 440_000));
    expect(wrapper.find('line.limit').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the top window guide only when the ceiling reaches the window', () => {
    const wrapper = mount(ContextSparkline, { props: {
      samples: [{ at: 0, tokens: 500_000 }, { at: 10, tokens: 950_000 }],
      window: 1_000_000, limits: { amber: 200_000, red: 400_000 }, detailed: true,
    } });
    expect(wrapper.find('line.limit').exists()).toBe(true);
    wrapper.unmount();
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

