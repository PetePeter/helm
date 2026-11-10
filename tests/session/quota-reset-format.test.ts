import { describe, expect, it } from 'vitest';
import { formatQuotaResetIn } from '../../renderer/session-context-usage.js';

const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const MIN = 60_000;

describe('formatQuotaResetIn', () => {
  it('shows hours and minutes inside a day', () => {
    expect(formatQuotaResetIn(now + (3 * 60 + 12) * MIN, now)).toBe('resets in 3h 12m');
  });

  it('shows days and hours beyond a day', () => {
    expect(formatQuotaResetIn(now + ((6 * 24 + 4) * 60 + 30) * MIN, now)).toBe('resets in 6d 4h');
  });

  it('shows minutes only under an hour, and <1m in the last minute', () => {
    expect(formatQuotaResetIn(now + 41 * MIN, now)).toBe('resets in 41m');
    expect(formatQuotaResetIn(now + 20_000, now)).toBe('resets in <1m');
  });

  it('returns nothing once the reset has passed', () => {
    expect(formatQuotaResetIn(now, now)).toBeUndefined();
    expect(formatQuotaResetIn(now - MIN, now)).toBeUndefined();
  });
});
