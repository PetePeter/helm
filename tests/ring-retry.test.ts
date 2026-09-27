import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RingRetry, RING_ANSWER_WINDOW_MS, RING_RETRY_AFTER_MS } from '../src/session/ring-retry.js';

describe('RingRetry', () => {
  let rings: Array<{ sessionId: string; reason: string }>;
  let missed: Array<{ sessionId: string; reason: string }>;
  let retry: RingRetry;

  beforeEach(() => {
    vi.useFakeTimers();
    rings = [];
    missed = [];
    retry = new RingRetry({
      ring: (sessionId, reason) => { rings.push({ sessionId, reason }); return true; },
      missedTwice: (sessionId, reason) => { missed.push({ sessionId, reason }); },
    });
  });
  afterEach(() => { retry.dispose(); vi.useRealTimers(); });

  it('an answered ring never retries', () => {
    retry.rang('op', 'build done');
    retry.answered();
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS + 1);
    expect(rings).toEqual([]);
    expect(missed).toEqual([]);
  });

  it('an unanswered or declined ring rings again once, 10 minutes after the answer window', () => {
    retry.rang('op', 'build done');
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS - 1);
    expect(rings).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rings).toEqual([{ sessionId: 'op', reason: 'build done' }]);
  });

  it('a second miss stops retrying and reports it once', () => {
    retry.rang('op', 'build done');
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS);
    expect(rings).toHaveLength(1);
    expect(missed).toEqual([{ sessionId: 'op', reason: 'build done' }]);
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    expect(rings).toHaveLength(1);
  });

  it('answering the retry ends the chain', () => {
    retry.rang('op', 'build done');
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    retry.answered();
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    expect(missed).toEqual([]);
  });

  it('a new ring replaces a pending retry rather than stacking', () => {
    retry.rang('op', 'first');
    retry.rang('op', 'second');
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    expect(rings).toEqual([{ sessionId: 'op', reason: 'second' }]);
  });

  it('a retry no phone takes counts as the second miss', () => {
    retry = new RingRetry({ ring: () => false, missedTwice: (s, r) => { missed.push({ sessionId: s, reason: r }); } });
    retry.rang('op', 'build done');
    vi.advanceTimersByTime(RING_ANSWER_WINDOW_MS + RING_RETRY_AFTER_MS);
    expect(missed).toEqual([{ sessionId: 'op', reason: 'build done' }]);
  });
});
