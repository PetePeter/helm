import type { SessionEta } from '../src/types/session.js';
import { formatElapsed } from '../src/utils/time-parser.js';

export interface SessionEtaDisplay {
  text: string;
  title: string;
  isLate: boolean;
}

/** Format the desktop row's ETA in local time and relative to the current clock. */
export function formatSessionEta(eta: SessionEta, now = Date.now()): SessionEtaDisplay {
  const time = formatLocalTime(eta.at);
  const isLate = now > eta.at;
  const relative = isLate
    ? `late ${Math.max(1, Math.ceil((now - eta.at) / 60_000))}m`
    : `in ${formatElapsed(eta.at - now)}`;
  const setTime = formatLocalTime(eta.setAt);
  const note = eta.note?.trim();
  const range = eta.range;
  // ~N: half the learned P10–P90 band, in minutes.
  const spread = range ? ` (~${Math.round((range.hi - range.lo) / 2 / 60_000)})` : '';
  const rangeText = range
    ? `80% range ${formatLocalTime(range.lo)}–${formatLocalTime(range.hi)} (${range.samples} past tasks)`
    : 'no range yet';
  return {
    text: `🏁 ${isLate ? relative : time}${spread}`,
    title: `ETA ${time} (${relative}) · ${rangeText} · set ${setTime}${note ? ` · ${note}` : ''}`,
    isLate,
  };
}

function formatLocalTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}
