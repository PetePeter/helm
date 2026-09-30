import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseScheduledTime, formatElapsed, formatClock } from '../src/utils/time-parser.js';

describe('parseScheduledTime', () => {
  const NOW = new Date('2024-01-15T14:00:00.000Z').getTime(); // 14:00 UTC

  beforeEach(() => { vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns null for empty string', () => {
    expect(parseScheduledTime('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseScheduledTime('not a time')).toBeNull();
    expect(parseScheduledTime('foo bar')).toBeNull();
  });

  describe('relative — "in N minutes"', () => {
    it('parses "in 30 minutes"', () => {
      const result = parseScheduledTime('in 30 minutes');
      expect(result?.getTime()).toBeCloseTo(NOW + 30 * 60_000, -2);
    });

    it('parses "in 2 hours"', () => {
      const result = parseScheduledTime('in 2 hours');
      expect(result?.getTime()).toBeCloseTo(NOW + 2 * 3_600_000, -2);
    });

    it('parses "in 1 hour"', () => {
      const result = parseScheduledTime('in 1 hour');
      expect(result?.getTime()).toBeCloseTo(NOW + 3_600_000, -2);
    });

    it('parses "in 45 mins"', () => {
      const result = parseScheduledTime('in 45 mins');
      expect(result?.getTime()).toBeCloseTo(NOW + 45 * 60_000, -2);
    });

    it('parses "in 1.5 hours"', () => {
      const result = parseScheduledTime('in 1.5 hours');
      expect(result?.getTime()).toBeCloseTo(NOW + 1.5 * 3_600_000, -2);
    });
  });

  describe('absolute — am/pm', () => {
    // NOW is 14:00 UTC (2pm)

    it('parses "9pm" as tonight 21:00', () => {
      const result = parseScheduledTime('9pm');
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(21);
      expect(result!.getMinutes()).toBe(0);
    });

    it('parses "9:30pm"', () => {
      const result = parseScheduledTime('9:30pm');
      expect(result!.getHours()).toBe(21);
      expect(result!.getMinutes()).toBe(30);
    });

    it('parses "9:30 pm" (space before meridiem)', () => {
      const result = parseScheduledTime('9:30 pm');
      expect(result!.getHours()).toBe(21);
      expect(result!.getMinutes()).toBe(30);
    });

    it('rolls to tomorrow when time has passed', () => {
      // NOW is 14:00 UTC. The parser schedules for 9am local time.
      // In timezones where 9am has already passed (most of them), it rolls to tomorrow.
      // We verify: result is in the future, and the hours are 9.
      const result = parseScheduledTime('9am');
      expect(result).not.toBeNull();
      expect(result!.getTime()).toBeGreaterThan(NOW);
      expect(result!.getHours()).toBe(9);
    });

    it('handles 12pm (noon)', () => {
      const result = parseScheduledTime('12pm');
      expect(result!.getHours()).toBe(12);
    });

    it('handles 12am (midnight)', () => {
      const result = parseScheduledTime('12am');
      expect(result!.getHours()).toBe(0);
    });
  });

  describe('absolute — 24-hour / bare numbers', () => {
    it('parses "21:00"', () => {
      const result = parseScheduledTime('21:00');
      expect(result!.getHours()).toBe(21);
      expect(result!.getMinutes()).toBe(0);
    });

    it('parses "9" as 09:00', () => {
      const result = parseScheduledTime('9');
      expect(result!.getHours()).toBe(9);
    });

    it('returns null for out-of-range hours', () => {
      expect(parseScheduledTime('25:00')).toBeNull();
    });

    it('returns null for out-of-range minutes', () => {
      expect(parseScheduledTime('09:70')).toBeNull();
    });
  });

  describe('"at " prefix stripping', () => {
    it('strips "at " prefix', () => {
      const result = parseScheduledTime('at 9pm');
      expect(result!.getHours()).toBe(21);
    });
  });
});

describe('formatElapsed', () => {
  it('returns empty string for negative values', () => {
    expect(formatElapsed(-1)).toBe('');
  });

  it('returns empty string for non-finite values', () => {
    expect(formatElapsed(Number.NaN)).toBe('');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('formats very recent times as just now', () => {
    expect(formatElapsed(0)).toBe('just now');
    expect(formatElapsed(4_000)).toBe('just now');
  });

  it('formats seconds', () => {
    expect(formatElapsed(45_000)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatElapsed(5 * 60_000)).toBe('5m');
  });

  it('formats hours with remaining minutes', () => {
    expect(formatElapsed((1 * 60 + 23) * 60_000)).toBe('1h 23m');
  });

  it('formats whole hours without trailing minutes', () => {
    expect(formatElapsed(2 * 60 * 60_000)).toBe('2h');
  });

  it('formats days with remaining hours', () => {
    expect(formatElapsed(((2 * 24) + 3) * 60 * 60_000)).toBe('2d 3h');
  });

  it('formats whole days without trailing hours', () => {
    expect(formatElapsed(3 * 24 * 60 * 60_000)).toBe('3d');
  });
});

describe('formatClock — the session timer, d:hh:mm:ss', () => {
  it('always shows every field, zero-padded', () => {
    expect(formatClock(5_000)).toBe('0:00:00:05');
    expect(formatClock(((1 * 24 + 2) * 3600 + 3 * 60 + 4) * 1000)).toBe('1:02:03:04');
  });

  it('floors partial seconds and grows days past 9', () => {
    expect(formatClock(59_999)).toBe('0:00:00:59');
    expect(formatClock(12 * 86_400_000)).toBe('12:00:00:00');
  });

  it('is blank for nonsense input', () => {
    expect(formatClock(-1)).toBe('');
    expect(formatClock(Number.NaN)).toBe('');
  });
});
