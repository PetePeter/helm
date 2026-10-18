/** Compact chart axes while keeping tooltip values grouped and exact. */
export function formatTokens(value: number, compact = true): string {
  if (compact && value >= 1e6) return `${+(value / 1e6).toFixed(2)}M`;
  if (compact && value >= 1e3) return `${+(value / 1e3).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
}
