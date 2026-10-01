import { describe, expect, it } from 'vitest';
import { promptStaleness } from '../src/session/prompt-staleness.js';

const MIN = 60_000;

describe('promptStaleness', () => {
  it('uses 5 / 60 minute defaults', () => {
    expect(promptStaleness(0, 5 * MIN, undefined)).toBe('fresh');
    expect(promptStaleness(0, 5 * MIN + 1, undefined)).toBe('warn');
    expect(promptStaleness(0, 60 * MIN + 1, undefined)).toBe('expired');
  });

  it('honours per-CLI thresholds', () => {
    expect(promptStaleness(0, 3 * MIN, { cacheWarnMinutes: 2, cacheExpireMinutes: 10 })).toBe('warn');
    expect(promptStaleness(0, 11 * MIN, { cacheWarnMinutes: 2, cacheExpireMinutes: 10 })).toBe('expired');
  });

  it('a CLI with no prompt cache (local model) never goes stale', () => {
    expect(promptStaleness(0, 10 ** 12, { noPromptCache: true })).toBe('fresh');
  });

  it('a never-prompted session is fresh', () => {
    expect(promptStaleness(undefined, 10 ** 12, undefined)).toBe('fresh');
  });
});
