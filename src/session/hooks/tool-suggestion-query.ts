/** Build bounded, private query text from one completed tool call. */

import type { HookEvent } from './hook-normaliser.js';

const ARGUMENTS_CAP = 800;
const RESULT_CAP = 1_200;
const OMIT_KEY = /(secret|token|password|credential)/i;

interface WalkBudget {
  nodes: number;
}

function boundedRedact(value: unknown, budget: WalkBudget, depth = 0): unknown {
  if (budget.nodes-- <= 0) return '[truncated]';
  if (depth >= 5) return '[depth limit]';
  if (typeof value === 'string') return value.slice(0, 200);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => boundedRedact(item, budget, depth + 1));
  }
  if (value && typeof value === 'object') {
    // Stop at the key cap while iterating: Object.entries would materialize every key first.
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const key in value as Record<string, unknown>) {
      if (kept >= 40) break;
      if (!Object.hasOwn(value, key) || OMIT_KEY.test(key)) continue;
      out[key] = boundedRedact((value as Record<string, unknown>)[key], budget, depth + 1);
      kept++;
    }
    return out;
  }
  return value;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function buildToolSuggestionQuery(event: HookEvent): string | null {
  const parts: string[] = [];
  const toolName = event.toolName?.trim();
  if (toolName) parts.push(`tool ${toolName.slice(0, 80)}`);

  if (event.toolInput) {
    const safeInput = boundedRedact(event.toolInput, { nodes: 120 });
    const args = jsonText(safeInput).slice(0, ARGUMENTS_CAP);
    if (args) parts.push(`arguments ${args}`);
  }

  if (event.toolResponse !== undefined && event.toolResponse !== null) {
    // Bound the walk BEFORE serializing: a huge result must not be stringified whole.
    const result = (typeof event.toolResponse === 'string'
      ? event.toolResponse
      : jsonText(boundedRedact(event.toolResponse, { nodes: 120 })))
      .slice(0, RESULT_CAP);
    if (result) parts.push(`result ${result}`);
  }

  const query = parts.join('\n');
  return query.trim() ? query : null;
}
