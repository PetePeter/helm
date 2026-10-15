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

/** Read current usage and the model window from Claude Code's statusLine JSON. */
export function parseClaudeStatuslineUsage(input: unknown): ClaudeStatuslineUsage | null | undefined {
  const context = record(record(input)?.context_window);
  if (!context) return undefined;
  // Claude sets current_usage to null before the first API call and directly
  // after compaction; any previous combined totals are no longer current.
  if (Object.hasOwn(context, 'current_usage') && context.current_usage === null) return null;

  const current = record(context.current_usage);
  const totalInput = context.total_input_tokens;
  const totalOutput = context.total_output_tokens;
  const contextTokens = typeof totalInput === 'number' && Number.isFinite(totalInput)
    ? tokenCount(totalInput) + tokenCount(totalOutput)
    : current
      ? tokenCount(current.input_tokens)
        + tokenCount(current.cache_creation_input_tokens)
        + tokenCount(current.cache_read_input_tokens)
        + tokenCount(current.output_tokens)
      : 0;
  if (contextTokens <= 0) {
    return current || Number.isFinite(totalInput) || Number.isFinite(totalOutput) ? null : undefined;
  }

  const contextWindow = tokenCount(context.context_window_size);
  return { contextTokens, ...(contextWindow > 0 ? { contextWindow } : {}) };
}
