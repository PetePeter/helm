/** Start of the timestamp's local calendar day. */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Label a local day relative to today without assuming every day is 24 hours. */
export function formatLocalDayLabel(timestamp: number, now = Date.now()): string {
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(timestamp);
  if (day === today) return 'Today';

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return 'Yesterday';

  return new Date(timestamp).toLocaleDateString();
}
