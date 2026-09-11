/**
 * MobileAlertNotifier — the reason BLE was chosen over everything else.
 *
 * A session changing state on the desktop buzzes the phone in your pocket with
 * no cloud, no APNs, no Firebase and no Telegram in the path: the alert goes out
 * over the already-open GATT link, and the phone's foreground service turns it
 * into a lock-screen row.
 *
 * ```mermaid
 * graph LR
 *     SM[SessionManager<br/>session:updated] --> MAN[MobileAlertNotifier]
 *     NM[NotificationManager<br/>notify_user / flash_attention] --> MAN
 *     MAN -->|chat record with a kind| MCB[MobileChatBridge]
 *     MCB -->|BLE| PH[Phone]
 * ```
 *
 * Three things it deliberately does NOT do:
 *
 * NO DEDUPLICATION. `TelegramNotifier` keeps a per-session suppression window;
 * this does not mirror it. The phone keys its notification on the session id, so
 * ten alerts from one session REPLACE into one row — a better mechanism, and one
 * that does not need the desktop to guess a window. (That is a different thing
 * from the ratified duplication BETWEEN Telegram and the app, which stays.)
 *
 * NO PREFERENCES. It never reads TelegramConfig. Per-transport notification
 * preferences are a real question and a config-surface plan; borrowing
 * Telegram's would couple two transports that ChatBroker exists to keep apart.
 *
 * NO RETRY. An alert not carried by the link is dropped. It was only true when
 * it happened, and a queue would deliver "needs input" about something finished
 * an hour ago.
 *
 * It owns ONE piece of state, and only because nothing else does: the last state
 * each session was seen in. `session:updated` carries the new value and not the
 * old one, and a transition is the event — a level is not.
 */

import { logger } from '../utils/logger.js';
import { alertKindForTransition, alertText } from '../session/session-alert.js';
import type { SessionAlertKind } from '../session/session-alert.js';
import type { SessionState } from '../types/session.js';

/** The slice of MobileChatBridge this drives. Narrow by design: no gate, no BLE. */
export interface MobileAlertSink {
  sendAlert(sessionId: string, kind: SessionAlertKind, text: string): boolean;
}

/** What `session:updated` gives us, reduced to the two fields that matter. */
export interface ObservedSession {
  id: string;
  aiagentState?: SessionState;
}

/** The body for a flash, which carries no text of its own by design. */
export const FLASH_ALERT_TEXT = 'Needs your attention';

export class MobileAlertNotifier {
  private readonly lastState = new Map<string, SessionState>();

  constructor(private readonly sink: MobileAlertSink) {}

  /**
   * One `session:updated`. Pushes only on an active → non-active transition of
   * the session's AIAGENT phase, which is the same gate Telegram uses.
   */
  observe(session: ObservedSession): void {
    const previous = this.lastState.get(session.id);
    const next = session.aiagentState;
    if (next) this.lastState.set(session.id, next);
    else this.lastState.delete(session.id);

    const kind = alertKindForTransition(previous, next);
    if (kind) this.push(session.id, kind, alertText(kind));
  }

  /** A gone session must not leave a state behind for a reused id to transition from. */
  forget(sessionId: string): void {
    this.lastState.delete(sessionId);
  }

  /**
   * `notify_user`. The agent's own words are the body; the phone titles the row
   * with the session name, so the title it passed would only repeat what the
   * user can already see.
   */
  notified(sessionId: string, _title: string, content: string): void {
    this.push(sessionId, 'attention', content);
  }

  /** `flash_attention`. No text of its own — it IS the "needs you" event. */
  flashed(sessionId: string): void {
    this.push(sessionId, 'attention', FLASH_ALERT_TEXT);
  }

  /** Nothing here throws into a caller: an alert never breaks what triggered it. */
  private push(sessionId: string, kind: SessionAlertKind, text: string): void {
    try {
      this.sink.sendAlert(sessionId, kind, text);
    } catch (error) {
      logger.warn(`[MobileAlert] Could not push a ${kind} alert: ${error}`);
    }
  }
}
