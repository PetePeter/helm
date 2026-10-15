/**
 * When a session's context turns amber or red. One rule for the desktop row
 * graph, MCP and the phone: a CLI type's manual token counts when set,
 * otherwise a fixed share of the context window.
 */

export interface ContextLimits { amber: number; red: number }
export type ContextLevel = 'ok' | 'warn' | 'hot';

export const AUTO_AMBER_FILL = 0.75;
export const AUTO_RED_FILL = 0.9;

export interface ContextLimitsConfig { contextLimits?: ContextLimits }

/** Manual limits count only when both are positive and red sits above amber. */
export const isValidContextLimits = (l: ContextLimits | null | undefined): l is ContextLimits =>
  !!l && l.amber > 0 && l.red > l.amber;

export function resolveContextLimits(
  cli: ContextLimitsConfig | null | undefined,
  window: number | undefined,
): ContextLimits | undefined {
  if (isValidContextLimits(cli?.contextLimits)) return { amber: cli.contextLimits.amber, red: cli.contextLimits.red };
  if (!window || window <= 0) return undefined;
  return { amber: Math.round(window * AUTO_AMBER_FILL), red: Math.round(window * AUTO_RED_FILL) };
}

export function contextLevel(tokens: number, limits: ContextLimits | undefined): ContextLevel {
  if (!limits) return 'ok';
  return tokens > limits.red ? 'hot' : tokens > limits.amber ? 'warn' : 'ok';
}
