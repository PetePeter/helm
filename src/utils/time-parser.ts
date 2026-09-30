/**
 * Parses a human-readable time string into a future Date.
 *
 * Supported formats:
 *   Absolute (today/tomorrow if already passed):
 *     "9pm", "9:30pm", "9:30 pm", "21:00", "9:30", "9"
 *   Relative:
 *     "in 30 minutes", "in 2 hours", "in 1 hour"
 *
 * Returns null if the string cannot be parsed.
 */
export function parseScheduledTime(raw: string): Date | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();

  const relative = parseRelative(text);
  if (relative !== null) return relative;

  return parseAbsolute(text);
}

/**
 * Format elapsed milliseconds in long form for session activity timers.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 5) return 'just now';
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/** Format elapsed milliseconds as a ticking clock, `d:hh:mm:ss` — the session row timer. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86_400);
  return `${days}:${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

// ---------- Relative ---------------------------------------------------------

function parseRelative(text: string): Date | null {
  const m = text.match(/^in\s+(\d+(?:\.\d+)?)\s+(minute|minutes|min|mins|hour|hours|hr|hrs)$/);
  if (!m) return null;
  const amount = parseFloat(m[1]);
  const isHours = /^h/.test(m[2]);
  const ms = isHours ? amount * 3_600_000 : amount * 60_000;
  return new Date(Date.now() + ms);
}

// ---------- Absolute ---------------------------------------------------------

function parseAbsolute(text: string): Date | null {
  // Remove optional "at" prefix, e.g. "at 9pm"
  const cleaned = text.replace(/^at\s+/, '');

  // Patterns: "9pm", "9:30pm", "9:30 pm", "21:00", "9:30", "9"
  const m = cleaned.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/,
  );
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  if (meridiem === 'am') {
    if (hours === 12) hours = 0;
  } else if (meridiem === 'pm') {
    if (hours !== 12) hours += 12;
  }
  // No meridiem and no colon with single digit: treat as 24-h (e.g. "9" = 09:00)

  if (hours > 23) return null;

  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (candidate.getTime() <= Date.now()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}
