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
 * The event is a turn ending — the session's activity leaving 'active'. Hooked
 * CLIs report that exactly (Stop); unhooked ones fall back to output timing.
 * No agent bookkeeping is involved: the model never has to announce it is done.
 *
 * Per-surface PREFERENCES deliberately live elsewhere — `TelegramConfig`'s
 * notifyOnComplete is Telegram's own and is read only by Telegram.
 */

import type { ActivityLevel } from '../types/session.js';

/** The three classes a phone can silence independently. Mirrored in Kotlin's `AlertKind`. */
export type SessionAlertKind = 'attention' | 'completion' | 'idle';

/** The short body a lock-screen row shows. The session's NAME is the title. */
const ALERT_TEXT: Record<SessionAlertKind, string> = {
  attention: 'Needs input',
  completion: 'Finished',
  idle: 'Went quiet',
};

/**
 * The one transition gate. Returns the alert class, or null when this is not an
 * event: still working, already stopped, or an unknown end.
 */
export function alertKindForTransition(
  previous: ActivityLevel | undefined,
  next: ActivityLevel | undefined,
): SessionAlertKind | null {
  if (previous !== 'active' || !next || next === 'active') return null;
  return 'completion';
}

/** The default body for an alert with nothing more specific to say. */
export function alertText(kind: SessionAlertKind): string {
  return ALERT_TEXT[kind];
}
