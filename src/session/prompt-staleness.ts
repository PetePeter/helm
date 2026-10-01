/**
 * How stale a session is since its last prompt. Two per-CLI thresholds: the
 * warn point (a short prompt cache has expired — Mess pokes stop, the row has
 * faded out) and the expire point (a long cache has gone too).
 */
export const DEFAULT_CACHE_WARN_MINUTES = 5;
export const DEFAULT_CACHE_EXPIRE_MINUTES = 60;

export type PromptStaleness = 'fresh' | 'warn' | 'expired';

export interface StalenessThresholds {
  cacheWarnMinutes?: number;
  cacheExpireMinutes?: number;
  /** A local model has no prompt cache to lose: the session never goes stale. */
  noPromptCache?: boolean;
}

export function warnAfterMs(t: StalenessThresholds | null | undefined): number {
  return (t?.cacheWarnMinutes || DEFAULT_CACHE_WARN_MINUTES) * 60_000;
}

export function expireAfterMs(t: StalenessThresholds | null | undefined): number {
  return (t?.cacheExpireMinutes || DEFAULT_CACHE_EXPIRE_MINUTES) * 60_000;
}

/** When a quiet session stops being nudged (Mess) or warmed: never, with no prompt cache to protect. */
export function dormantAfterMs(t: StalenessThresholds | null | undefined): number {
  return t?.noPromptCache ? Infinity : warnAfterMs(t);
}

/** A session never prompted, or on a CLI with no prompt cache, has nothing cached to lose: it is fresh. */
export function promptStaleness(lastPromptAt: number | undefined, now: number, t: StalenessThresholds | null | undefined): PromptStaleness {
  if (lastPromptAt === undefined || t?.noPromptCache) return 'fresh';
  const age = now - lastPromptAt;
  if (age > expireAfterMs(t)) return 'expired';
  if (age > warnAfterMs(t)) return 'warn';
  return 'fresh';
}
