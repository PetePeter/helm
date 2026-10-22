import { describe, expect, it } from 'vitest';
import { buildRatioConfig, buildScatterConfig, buildTrendConfig } from '../renderer/components/charts/estimate-chart-config.js';
import type { EstimateView } from '../src/session/eta-stats.js';

const theme = { text: '#fff', textMuted: '#aaa', grid: '#333', tooltip: '#000', accent: '#0f0', warning: '#fa0' };
const view = {
  summary: {},
  points: [{ label: 'claude', predictedMin: 5, actualMin: 8, unmarked: false }],
  histogram: { labels: ['<0.5'], counts: [1], unmarked: 0 },
  trend: { labels: ['mon'], values: [100] },
  dirs: [],
} as unknown as EstimateView;

describe('estimate chart configs', () => {
  it.each([
    ['scatter', buildScatterConfig],
    ['ratio', buildRatioConfig],
    ['trend', buildTrendConfig],
  ])('%s chart pans and zooms', (_name, build) => {
    const zoom = (build(view, theme).options?.plugins as any)?.zoom;
    expect(zoom.pan.enabled).toBe(true);
    expect(zoom.zoom.wheel.enabled).toBe(true);
    expect(zoom.zoom.pinch.enabled).toBe(true);
  });
});
