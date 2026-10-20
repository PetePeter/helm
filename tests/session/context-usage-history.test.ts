import { describe, expect, it } from 'vitest';
import { appendContextSample, CONTEXT_HISTORY_LIMIT } from '../../src/session/context-usage-history.js';

describe('appendContextSample', () => {
  it('keeps only the newest samples once the cap is reached', () => {
    let history = undefined as ReturnType<typeof appendContextSample> | undefined;
    for (let i = 1; i <= CONTEXT_HISTORY_LIMIT + 5; i++) history = appendContextSample(history, { at: i, tokens: i * 10 });
    expect(history).toHaveLength(CONTEXT_HISTORY_LIMIT);
    expect(history![0]).toEqual({ at: 6, tokens: 60 });
    expect(history!.at(-1)).toEqual({ at: CONTEXT_HISTORY_LIMIT + 5, tokens: (CONTEXT_HISTORY_LIMIT + 5) * 10 });
  });

  it('does not add a point when the token count is unchanged', () => {
    const history = appendContextSample([{ at: 1, tokens: 500 }], { at: 2, tokens: 500 });
    expect(history).toEqual([{ at: 1, tokens: 500 }]);
  });

  it('records a compaction drop as a normal point', () => {
    const history = appendContextSample([{ at: 1, tokens: 150_000 }], { at: 2, tokens: 20_000 });
    expect(history.map((s) => s.tokens)).toEqual([150_000, 20_000]);
  });

  // Regression: statusline and transcript readings carry their own measured-at,
  // so a stale reading could land last and the graph drew backwards in time.
  it('ignores a reading older than the newest one', () => {
    const history = appendContextSample([{ at: 10, tokens: 500 }], { at: 5, tokens: 400 });
    expect(history).toEqual([{ at: 10, tokens: 500 }]);
  });
});
