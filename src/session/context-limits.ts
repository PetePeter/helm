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

/** Where red sits on the context ring, as a share of the circle (the auto rule's red/window). */
export const RING_RED_AT = AUTO_RED_FILL;

export interface ContextRing {
  /** 0..1 of the circle; capped, so a session past the circle is `overflow`, not a bigger fill. */
  fill: number;
  amberAt: number;
  redAt: number;
  level: ContextLevel;
  overflow: boolean;
}

/**
 * The ring draws red at a fixed point of the circle and scales everything else
 * from the limits, so a user limit and the auto window share one picture: with
 * auto limits the circle is exactly the window. Undefined without limits — the
 * caller draws a plain dot.
 */
export function contextRing(tokens: number, limits: ContextLimits | undefined): ContextRing | undefined {
  if (!limits || limits.red <= 0) return undefined;
  const full = limits.red / RING_RED_AT;
  return {
    fill: Math.min(Math.max(tokens / full, 0), 1),
    amberAt: limits.amber / full,
    redAt: RING_RED_AT,
    level: contextLevel(tokens, limits),
    overflow: tokens > full,
  };
}

export function contextLevel(tokens: number, limits: ContextLimits | undefined): ContextLevel {
  if (!limits) return 'ok';
  return tokens > limits.red ? 'hot' : tokens > limits.amber ? 'warn' : 'ok';
}
