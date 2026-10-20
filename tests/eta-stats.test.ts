import { describe, expect, it } from 'vitest';
import { buildEstimateView } from '../src/session/eta-stats.js';
import type { EtaRecord } from '../src/session/eta-tracker.js';

const MIN = 60_000;
const MON = new Date(2026, 9, 19, 9, 0).getTime();

function rec(dayOffset: number, predictedMin: number, actualMin: number, over: Partial<EtaRecord> = {}): EtaRecord {
  const startedAt = MON + dayOffset * 24 * 60 * MIN;
  return {
    startedAt, firstAt: startedAt + predictedMin * MIN, finalAt: startedAt + predictedMin * MIN,
    endedAt: startedAt + actualMin * MIN, outcome: 'cleared', cliType: 'claude', dir: 'X:/a', sessionName: 's', ...over,
  };
}

describe('buildEstimateView', () => {
  const records = [
    rec(0, 10, 8),
    rec(0, 10, 15, { cliType: 'codex' }),
    rec(1, 20, 30, { outcome: 'unmarked', dir: 'X:/b' }),
    rec(9, 10, 10), // next week: outside a 'day' period anchored on MON
  ];

  it('filters by the period window and folder', () => {
    expect(buildEstimateView(records, 'day', MON, null, id => id).summary.total).toBe(3);
    const b = buildEstimateView(records, 'day', MON, 'X:/b', id => id);
    expect(b.summary).toMatchObject({ total: 1, unmarked: 1 });
    expect(b.dirs).toEqual(['X:/a', 'X:/b']);
  });

  it('builds scatter points, ratio histogram, per-column on-time trend, and newest-first rows', () => {
    const view = buildEstimateView(records, 'day', MON, null, id => id.toUpperCase());
    expect(view.points).toEqual(expect.arrayContaining([
      { predictedMin: 10, actualMin: 15, cliType: 'codex', label: 'CODEX', unmarked: false },
      { predictedMin: 20, actualMin: 30, cliType: 'claude', label: 'CLAUDE', unmarked: true },
    ]));
    expect(view.histogram.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(view.histogram.unmarked).toBe(1);
    expect(view.trend.values.slice(0, 2)).toEqual([50, 0]);
    expect(view.trend.values[2]).toBeNull();
    expect(view.recent[0]).toMatchObject({ outcome: 'unmarked', predictedMin: 20, actualMin: 30, slipMin: 10 });
  });
});
