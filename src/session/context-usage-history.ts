import type { ContextUsageSample } from '../types/session.js';
import { isNumber, isRecord } from './persistence-utils.js';

/** Enough points for a readable trend without bloating sessions.yaml. */
export const CONTEXT_HISTORY_LIMIT = 120;

/** Append a token reading, skipping repeats so idle refreshes do not flatten the trend. */
export function appendContextSample(
  history: readonly ContextUsageSample[] | undefined,
  sample: ContextUsageSample,
): ContextUsageSample[] {
  const current = history ?? [];
  const last = current.at(-1);
  // Sources stamp their own measured-at; a stale reading must not draw the graph backwards.
  if (last && (last.tokens === sample.tokens || sample.at < last.at)) return [...current];
  return [...current, sample].slice(-CONTEXT_HISTORY_LIMIT);
}

export function isContextUsageSample(value: unknown): value is ContextUsageSample {
  return isRecord(value) && isNumber(value.at) && isNumber(value.tokens) && value.tokens >= 0;
}
