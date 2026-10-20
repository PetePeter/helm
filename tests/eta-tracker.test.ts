import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EtaPersistence } from '../src/session/eta-persistence.js';
import { EtaTracker, computeEtaRange, summarizeEstimates, type EtaRecord, type EtaWhere } from '../src/session/eta-tracker.js';

const MIN = 60_000;
const T0 = new Date(2026, 9, 20, 10, 0).getTime();
const here: EtaWhere = { cliType: 'claude-code', dir: 'X:/repo', sessionName: 'worker' };

function record(predictedMin: number, actualMin: number, over: Partial<EtaRecord> = {}): EtaRecord {
  return {
    startedAt: T0, firstAt: T0 + predictedMin * MIN, finalAt: T0 + predictedMin * MIN,
    endedAt: T0 + actualMin * MIN, outcome: 'cleared', ...here, ...over,
  };
}

describe('EtaTracker', () => {
  let dir: string;
  let now: number;
  let tracker: EtaTracker;
  const make = () => new EtaTracker({ persistence: new EtaPersistence(dir), now: () => now });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eta-tracker-'));
    now = T0;
    tracker = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('closes on clear with actual time from the first set', () => {
    const eta = tracker.set(undefined, { minutes: 20 }, here);
    now = T0 + 25 * MIN;
    const rec = tracker.close(eta, here, 'cleared');
    expect(rec).toMatchObject({ startedAt: T0, firstAt: T0 + 20 * MIN, endedAt: T0 + 25 * MIN, outcome: 'cleared' });
  });

  it('a re-set keeps the first start and first guess but moves the shown ETA', () => {
    const first = tracker.set(undefined, { minutes: 10 }, here);
    now = T0 + 9 * MIN;
    const second = tracker.set(first, { minutes: 1 }, here);
    expect(second).toMatchObject({ startedAt: T0, firstAt: T0 + 10 * MIN, at: T0 + 10 * MIN, setAt: now });
    now = T0 + 30 * MIN;
    expect(tracker.close(second, here, 'cleared')).toMatchObject({ startedAt: T0, firstAt: T0 + 10 * MIN, finalAt: T0 + 10 * MIN });
  });

  it('stays open past ETA + 10m; unmarked only after 3x the guess (min 1h), capped there', () => {
    const eta = tracker.set(undefined, { minutes: 30 }, here);
    now = T0 + 60 * MIN;
    expect(tracker.closeIfOverdue(eta, here)).toBeNull();
    now = T0 + 91 * MIN;
    expect(tracker.closeIfOverdue(eta, here)).toMatchObject({ outcome: 'unmarked', endedAt: T0 + 90 * MIN });
  });

  it('a short guess still gets the 1h minimum before going unmarked', () => {
    const eta = tracker.set(undefined, { minutes: 5 }, here);
    now = T0 + 59 * MIN;
    expect(tracker.closeIfOverdue(eta, here)).toBeNull();
    now = T0 + 61 * MIN;
    expect(tracker.closeIfOverdue(eta, here)).toMatchObject({ outcome: 'unmarked', endedAt: T0 + 60 * MIN });
  });

  it('a re-set past the cap closes the old estimate as unmarked and starts fresh', () => {
    const old = tracker.set(undefined, { minutes: 15 }, here);
    now = T0 + 70 * MIN;
    const fresh = tracker.set(old, { minutes: 10 }, here);
    expect(tracker.query(0, Infinity)).toEqual([expect.objectContaining({ outcome: 'unmarked', endedAt: T0 + 60 * MIN })]);
    expect(fresh).toMatchObject({ startedAt: now, firstAt: now + 10 * MIN });
  });

  it('a late clear counts as cleared with its real end, and is learnable', () => {
    const eta = tracker.set(undefined, { minutes: 15 }, here);
    now = T0 + 55 * MIN;
    const rec = tracker.close(eta, here, 'cleared');
    expect(rec).toMatchObject({ outcome: 'cleared', endedAt: T0 + 55 * MIN });
    const history = Array.from({ length: 5 }, () => rec);
    expect(computeEtaRange(history, here, T0, T0 + 10 * MIN)?.samples).toBe(5);
  });

  it('a rescope closes the old estimate unpunished and starts a fresh clock and first guess', () => {
    const old = tracker.set(undefined, { minutes: 10 }, here);
    now = T0 + 30 * MIN;
    const fresh = tracker.set(old, { minutes: 20, rescope: 'user added the export step' }, here);
    expect(fresh).toMatchObject({ startedAt: now, firstAt: now + 20 * MIN });
    expect(tracker.query(0, Infinity)).toEqual([expect.objectContaining({
      outcome: 'rescoped', endedAt: T0 + 30 * MIN, reason: 'user added the export step',
    })]);
  });

  it('a rescope with no open estimate just opens one', () => {
    const eta = tracker.set(undefined, { minutes: 20, rescope: 'new scope' }, here);
    expect(eta).toMatchObject({ startedAt: T0, firstAt: T0 + 20 * MIN });
    expect(tracker.query(0, Infinity)).toEqual([]);
  });

  it('rejects a blank rescope reason', () => {
    const old = tracker.set(undefined, { minutes: 10 }, here);
    expect(() => tracker.set(old, { minutes: 5, rescope: '  ' }, here)).toThrow(/rescope/);
  });

  it('closing a session early records an unmarked estimate ending now', () => {
    const eta = tracker.set(undefined, { minutes: 15 }, here);
    now = T0 + 5 * MIN;
    expect(tracker.close(eta, here, 'unmarked')).toMatchObject({ outcome: 'unmarked', endedAt: T0 + 5 * MIN });
  });

  it('reloads recorded history after a restart', () => {
    const eta = tracker.set(undefined, { minutes: 15 }, here);
    now = T0 + 12 * MIN;
    tracker.close(eta, here, 'cleared');
    expect(make().query(0, Infinity)).toHaveLength(1);
  });

  it('attaches the learned range to a new estimate once history allows', () => {
    for (let i = 0; i < 5; i++) {
      const eta = tracker.set(undefined, { minutes: 10 }, here);
      now += 12 * MIN;
      tracker.close(eta, here, 'cleared');
    }
    const eta = tracker.set(undefined, { minutes: 10 }, here);
    expect(eta.range).toMatchObject({ lo: now + 12 * MIN, hi: now + 12 * MIN, samples: 5 });
  });
});

describe('computeEtaRange', () => {
  const at = T0 + 20 * MIN;

  it('returns null below five samples', () => {
    expect(computeEtaRange([1, 2, 3, 4].map(() => record(10, 10)), here, T0, at)).toBeNull();
  });

  it('ignores unmarked records, first guesses under 5m, and other CLI or folder', () => {
    const noise = [
      record(10, 30, { outcome: 'unmarked' }),
      record(10, 30, { outcome: 'rescoped' }),
      record(4, 40),
      record(10, 30, { cliType: 'codex' }),
      record(10, 30, { dir: 'X:/other' }),
    ];
    const good = [1, 2, 3, 4, 5].map(() => record(10, 10));
    expect(computeEtaRange([...noise, ...good], here, T0, at)).toEqual({ lo: at, hi: at, samples: 5 });
  });

  it('scales the P10–P90 ratio band onto the current estimate', () => {
    // ratios 0.5 .. 2.0 in ten steps
    const recs = Array.from({ length: 10 }, (_, i) => record(10, 5 + i * (15 / 9)));
    const range = computeEtaRange(recs, here, T0, at)!;
    expect(range.lo).toBe(T0 + 10 * MIN);
    expect(range.hi).toBe(T0 + 40 * MIN);
  });
});

describe('summarizeEstimates', () => {
  it('counts on-time against the first guess, median slip, and unmarked', () => {
    const s = summarizeEstimates([
      record(10, 8),
      record(10, 14),
      record(10, 20, { outcome: 'unmarked' }),
    ]);
    expect(s).toEqual({ total: 3, onTimePct: 33, medianSlipMin: 4, unmarked: 1, rescoped: 0 });
  });

  it('leaves rescoped estimates out of on-time and slip, counting them apart', () => {
    const s = summarizeEstimates([record(10, 8), record(10, 90, { outcome: 'rescoped' })]);
    expect(s).toEqual({ total: 1, onTimePct: 100, medianSlipMin: -2, unmarked: 0, rescoped: 1 });
  });
});
