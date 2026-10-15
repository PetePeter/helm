import { describe, expect, it } from 'vitest';
import { parseClaudeStatuslineUsage } from '../../src/session/claude-statusline-usage.js';

describe('parseClaudeStatuslineUsage', () => {
  it('reads the combined current context and the reported model window', () => {
    expect(parseClaudeStatuslineUsage({
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        context_window_size: 200_000,
      },
    })).toEqual({ contextTokens: 16_700, contextWindow: 200_000 });
  });

  it('falls back to the component counts when combined totals are absent', () => {
    expect(parseClaudeStatuslineUsage({
      context_window: {
        current_usage: {
          input_tokens: 8_500,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 2_000,
          output_tokens: 1_200,
        },
        context_window_size: 200_000,
      },
    })).toEqual({ contextTokens: 16_700, contextWindow: 200_000 });
  });

  it('ignores empty or malformed usage snapshots', () => {
    expect(parseClaudeStatuslineUsage({ context_window: { total_input_tokens: 0, total_output_tokens: 0 } })).toBeNull();
    expect(parseClaudeStatuslineUsage({
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        current_usage: null,
        context_window_size: 200_000,
      },
    })).toBeNull();
    expect(parseClaudeStatuslineUsage({ context_window: { current_usage: null, context_window_size: 200_000 } })).toBeNull();
    expect(parseClaudeStatuslineUsage(null)).toBeUndefined();
  });
});
