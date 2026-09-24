/**
 * Inter-session message flights — the Session List envelope animation gate.
 *
 * A flight is broadcast BEFORE the message is pasted into the recipient's
 * PTY. The renderer animates an envelope from the sender's row to the
 * recipient's row and acks on landing; only then is delivery released.
 * Delivery is never hostage to the animation: the sender side enforces a
 * timeout, so headless MCP traffic (no renderer, no pane) degrades to a
 * short fixed delay instead of stalling.
 */

/** One enveloped inter-session send, as seen by the renderer. */
export interface SessionMessageFlight {
  /** Correlation id — the renderer acks this value on landing. */
  flightId: string;
  senderSessionId: string;
  senderSessionName: string;
  recipientSessionId: string;
  recipientName: string;
  expectsResponse: boolean;
  /**
   * True when the reverse direction was seen within the reply window —
   * replies (and replies to replies) fly a different colour than first sends.
   */
  isReply: boolean;
}

/** Default hold on the PTY paste while the envelope animation runs. */
export const DEFAULT_MESSAGE_FLIGHT_TIMEOUT_MS = 1600;

/** How long a prior send keeps making the reverse direction count as a reply. */
export const MESSAGE_FLIGHT_REPLY_WINDOW_MS = 10 * 60 * 1000;

export function getMessageFlightTimeoutMs(): number {
  const configured = process.env.HELM_MESSAGE_FLIGHT_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_MESSAGE_FLIGHT_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MESSAGE_FLIGHT_TIMEOUT_MS;
}
