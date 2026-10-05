import { afterEach, describe, expect, it } from 'vitest';
import { formatLocalDayLabel, startOfLocalDay } from '../../renderer/utils/local-day.js';

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe('local day labels', () => {
  it('recognizes yesterday across the Sydney spring daylight-saving transition', () => {
    process.env.TZ = 'Australia/Sydney';
    const now = new Date(2026, 9, 5, 12);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    expect(startOfLocalDay(now.getTime()) - startOfLocalDay(yesterday.getTime())).toBe(23 * 60 * 60 * 1000);
    expect(formatLocalDayLabel(yesterday.getTime(), now.getTime())).toBe('Yesterday');
  });

  it('labels today and uses the locale date for older days', () => {
    process.env.TZ = 'Australia/Sydney';
    const now = new Date(2026, 9, 6, 12);
    const older = new Date(2026, 9, 3, 12);

    expect(formatLocalDayLabel(now.getTime(), now.getTime())).toBe('Today');
    expect(formatLocalDayLabel(older.getTime(), now.getTime())).toBe(older.toLocaleDateString());
  });
});
