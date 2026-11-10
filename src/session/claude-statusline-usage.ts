type Json = Record<string, unknown>;

export interface ClaudeStatuslineUsage {
  contextTokens: number;
  contextWindow?: number;
}

function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read the current context and the model window from Claude Code's statusLine JSON.
 * Only current_usage is the live context; total_input/output_tokens are session-cumulative
 * and would overfill the ring. current_usage is null before the first call and after compaction.
 */
export function parseClaudeStatuslineUsage(input: unknown): ClaudeStatuslineUsage | null | undefined {
  const context = record(record(input)?.context_window);
  if (!context) return undefined;

  const current = record(context.current_usage);
  const contextTokens = current
    ? tokenCount(current.input_tokens)
      + tokenCount(current.cache_creation_input_tokens)
      + tokenCount(current.cache_read_input_tokens)
      + tokenCount(current.output_tokens)
    : 0;
  if (contextTokens <= 0) return null;

  const contextWindow = tokenCount(context.context_window_size);
  return { contextTokens, ...(contextWindow > 0 ? { contextWindow } : {}) };
}
