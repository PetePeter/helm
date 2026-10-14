import { describe, expect, it } from 'vitest';
import { formatSessionContextUsage, sessionContextUsageTitle } from '../../renderer/session-context-usage.js';

describe('session context usage formatting', () => {
  it('shows a compact token count with percentage when the window is known', () => {
    const usage = { tokens: 18_400, window: 200_000 };
    expect(formatSessionContextUsage(usage)).toBe('ctx 18.4k · 9%');
    expect(sessionContextUsageTitle(usage)).toBe('18,400 context tokens · 9% of 200,000');
  });

  it('keeps the token count when no context window is available', () => {
    expect(formatSessionContextUsage({ tokens: 850 })).toBe('ctx 850');
    expect(sessionContextUsageTitle({ tokens: 850 })).toBe('850 context tokens');
  });

  it('does not show a badge for invalid or absent snapshots', () => {
    expect(formatSessionContextUsage(undefined)).toBeUndefined();
    expect(formatSessionContextUsage({ tokens: 0, window: 200_000 })).toBeUndefined();
  });
});
