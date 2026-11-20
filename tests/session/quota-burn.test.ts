import { describe, it, expect } from 'vitest';
import {
  appendQuotaHistory,
  quotaBurn,
  QUOTA_HISTORY_BUCKET_MS,
  QUOTA_HISTORY_SPAN_MS,
  type QuotaHistoryPoint,
} from '../../src/session/quota-burn.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;

function snap(at: number, fiveHour: number, weekly = 10, fiveReset = at + 4 * HOUR, weeklyReset = at + 72 * HOUR) {
  return {
    fiveHour: { usedPercent: fiveHour, resetsAtEpochMs: fiveReset },
    weekly: { usedPercent: weekly, resetsAtEpochMs: weeklyReset },
    measuredAtEpochMs: at,
  };
}

describe('quotaBurn', () => {
  it('reads 20% used turning into 30% an hour later as 10%/h', () => {
    const history: QuotaHistoryPoint[] = [{ at: NOW - HOUR, fiveHour: 20, weekly: 10 }];
    const burn = quotaBurn(history, snap(NOW, 30), 'fiveHour', NOW);
    expect(burn?.perHour).toBeCloseTo(10);
  });

  it('projects when the quota runs out at the current rate', () => {
    const history: QuotaHistoryPoint[] = [{ at: NOW - HOUR, fiveHour: 60, weekly: 10 }];
    const burn = quotaBurn(history, snap(NOW, 70, 10, NOW + 5 * HOUR), 'fiveHour', NOW);
    expect(burn?.outInMs).toBe(3 * HOUR);
    expect(burn?.beforeReset).toBe(true);
  });

  it('does not flag a burn that lasts until the reset', () => {
    const history: QuotaHistoryPoint[] = [{ at: NOW - HOUR, fiveHour: 60, weekly: 10 }];
    const burn = quotaBurn(history, snap(NOW, 70, 10, NOW + 1 * HOUR), 'fiveHour', NOW);
    expect(burn?.beforeReset).toBe(false);
  });

  it('reports no burn when usage is flat', () => {
    const history: QuotaHistoryPoint[] = [{ at: NOW - HOUR, fiveHour: 40, weekly: 10 }];
    const burn = quotaBurn(history, snap(NOW, 40), 'fiveHour', NOW);
    expect(burn).toEqual({ perHour: 0, outInMs: null, beforeReset: false });
  });

  it('ignores samples from before a window reset', () => {
    const history: QuotaHistoryPoint[] = [
      { at: NOW - HOUR, fiveHour: 90, weekly: 10 },
      { at: NOW - 30 * MIN, fiveHour: 5, weekly: 10 },
    ];
    const burn = quotaBurn(history, snap(NOW, 15), 'fiveHour', NOW);
    expect(burn?.perHour).toBeCloseTo(20);
  });

  it('gives no rate from under ten minutes of samples', () => {
    const history: QuotaHistoryPoint[] = [{ at: NOW - 5 * MIN, fiveHour: 20, weekly: 10 }];
    expect(quotaBurn(history, snap(NOW, 30), 'fiveHour', NOW)).toBeNull();
    expect(quotaBurn([], snap(NOW, 30), 'fiveHour', NOW)).toBeNull();
  });

  it('measures the recent hour, not the whole history', () => {
    const history: QuotaHistoryPoint[] = [
      { at: NOW - 3 * HOUR, fiveHour: 0, weekly: 10 },
      { at: NOW - HOUR, fiveHour: 10, weekly: 10 },
    ];
    expect(quotaBurn(history, snap(NOW, 40), 'fiveHour', NOW)?.perHour).toBeCloseTo(30);
  });
});

describe('appendQuotaHistory', () => {
  it('records at most one point per bucket', () => {
    let history = appendQuotaHistory([], snap(NOW, 10), NOW);
    history = appendQuotaHistory(history, snap(NOW + MIN, 11), NOW + MIN);
    expect(history).toHaveLength(1);
    history = appendQuotaHistory(history, snap(NOW + QUOTA_HISTORY_BUCKET_MS, 12), NOW + QUOTA_HISTORY_BUCKET_MS);
    expect(history.map((p) => p.fiveHour)).toEqual([10, 12]);
  });

  it('drops points older than the graph span', () => {
    const old = [{ at: NOW - QUOTA_HISTORY_SPAN_MS - MIN, fiveHour: 1, weekly: 1 }];
    expect(appendQuotaHistory(old, snap(NOW, 10), NOW).map((p) => p.fiveHour)).toEqual([10]);
  });
});
