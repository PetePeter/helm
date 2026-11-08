import { getMessageFlightTimeoutMs, type SessionMessageFlight } from '../../session/message-flight.js';

export interface MessageFlightGateOptions {
  /** True when the session belongs to the profile the renderer is showing. */
  isSessionVisible: (sessionId: string) => boolean;
  /** Renderers to draw the envelope in. */
  broadcast: (flight: SessionMessageFlight) => void;
  /** Observes every flight, visible or not (operator open-relay tracking). */
  observe?: (flight: SessionMessageFlight) => void;
}

/**
 * Holds a PTY paste until the renderer acks the envelope landing. Only the
 * active profile's renderer draws or acks a flight: an inactive profile's
 * flight names sessions the renderer must not learn about, so it is released
 * at once instead of being broadcast.
 */
export class MessageFlightGate {
  private readonly pending = new Map<string, { release: () => void; recipientSessionId: string }>();

  constructor(private readonly options: MessageFlightGateOptions) {}

  send = (flight: SessionMessageFlight): Promise<void> => new Promise<void>(resolve => {
    this.options.observe?.(flight);
    if (!this.options.isSessionVisible(flight.recipientSessionId)) {
      resolve();
      return;
    }
    this.pending.set(flight.flightId, { release: resolve, recipientSessionId: flight.recipientSessionId });
    this.options.broadcast(flight);
    // Late-ack sanitation: drop the entry once the sender side has certainly
    // moved on, so the map cannot grow without bound.
    setTimeout(() => {
      if (this.pending.get(flight.flightId)?.release === resolve) this.pending.delete(flight.flightId);
    }, getMessageFlightTimeoutMs() + 5000).unref?.();
  });

  /** Releases the held paste; a flight for a now-inactive profile's session is ignored. */
  ack(flightId: unknown): void {
    const entry = typeof flightId === 'string' ? this.pending.get(flightId) : undefined;
    if (!entry || !this.options.isSessionVisible(entry.recipientSessionId)) return;
    this.pending.delete(flightId as string);
    entry.release();
  }
}
