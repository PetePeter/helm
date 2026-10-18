import { describe, expect, it } from 'vitest';
import { formatTokens } from '../../src/session/format-tokens.js';

describe('formatTokens', () => {
  it('uses compact axis labels while rounding to a stable precision', () => {
    expect(formatTokens(999.5)).toBe('1,000');
    expect(formatTokens(1_250)).toBe('1.3k');
    expect(formatTokens(1_245_000)).toBe('1.25M');
  });

  it('keeps tooltip values exact and grouped', () => {
    expect(formatTokens(1_234_567, false)).toBe('1,234,567');
  });
});
