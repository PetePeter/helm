/**
 * session-alert — what counts as "something happened", stated once.
 *
 * Two surfaces answer this question: Telegram (`src/telegram/notifier.ts`) and
 * the paired phone (`src/mobile/mobile-alert-notifier.ts`). They notify through
 * completely different transports and always both — duplication between them is
 * ratified, because Telegram is the only path that survives being out of BLE
 * range and conditional suppression would make "was I told?" depend on link
 * state. See docs/chat-fan-out.md.
 *
 * What must NOT diverge is the DEFINITION: which transitions are worth a buzz.
 * Two copies of this rule would drift the day one surface learned about a new
 * state, and the drift would present as "my phone tells me things Telegram
 * doesn't", which nobody would file as a bug.
 *
 * Per-surface PREFERENCES deliberately live elsewhere — `TelegramConfig`'s
 * notifyOnComplete/notifyOnIdle/notifyOnError are Telegram's own and are read
 * only by Telegram. Reading them from the mobile path would couple the
 * transports, which is exactly what ChatBroker exists to prevent.
 */

import type { SessionState } from '../types/session.js';

/** The three classes a phone can silence independently. Mirrored in Kotlin's `AlertKind`. */
export type SessionAlertKind = 'attention' | 'completion' | 'idle';

/** States that mean the CLI is working. Leaving this set is the event. */
export const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(['implementing', 'planning']);

/** The short body a lock-screen row shows. The session's NAME is the title. */
const ALERT_TEXT: Record<SessionAlertKind, string> = {
  attention: 'Needs input',
  completion: 'Finished',
  idle: 'Went quiet',
};

const KIND_BY_STATE: Partial<Record<SessionState, SessionAlertKind>> = {
  completed: 'completion',
  idle: 'idle',
  waiting: 'attention',
};

/**
 * The one transition gate. Returns the alert class, or null when this is not an
 * event: still working, still stopped, or a state nobody has a class for.
 */
export function alertKindForTransition(
  previous: SessionState | undefined,
  next: SessionState | undefined,
): SessionAlertKind | null {
  if (!previous || !next) return null;
  if (!ACTIVE_STATES.has(previous)) return null;
  if (ACTIVE_STATES.has(next)) return null;
  return KIND_BY_STATE[next] ?? null;
}

/** The default body for an alert with nothing more specific to say. */
export function alertText(kind: SessionAlertKind): string {
  return ALERT_TEXT[kind];
}
