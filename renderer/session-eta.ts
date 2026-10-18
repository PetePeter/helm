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
  return {
    text: isLate ? `🏁 ${relative}` : `🏁 ${time}`,
    title: `ETA ${time} (${relative}) · set ${setTime}${note ? ` · ${note}` : ''}`,
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
