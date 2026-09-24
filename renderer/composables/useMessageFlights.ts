/**
 * Message flights: the envelope animation shown before every inter-session
 * paste. The main process holds the PTY write until the flight is acked, so
 * landing the envelope is what releases the message.
 *
 * Exactly one mounted component should host flights. The main process has a
 * timeout, so with no host the paste is still released after a short delay.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import type { SessionMessageFlight } from '../../src/session/message-flight.js';
import { MESSAGE_FLIGHT_COLORS } from '../state-colors.js';
import { sessionsClient } from '../ipc/clients.js';

export interface FlightPoint { x: number; y: number }

export interface MessageFlight {
  id: string;
  recipientSessionId: string;
  fromX: number;
  fromY: number;
  dx: number;
  dy: number;
  colour: string;
}

/** How long the recipient row keeps its landing flash. */
export const FLIGHT_LANDING_FLASH_MS = 600;

/** Where a sender with no anchor (phone, peer) starts its flight: the host's top-right corner. */
const CORNER_INSET_PX = 10;

export interface MessageFlightsOptions {
  /** The positioned element the flights are drawn in. */
  rootEl: Ref<HTMLElement | null>;
  /** The element a session's envelope leaves from or lands on, or null if it has none. */
  resolveAnchor: (sessionId: string) => HTMLElement | null;
}

export function useMessageFlights(options: MessageFlightsOptions) {
  const flights = ref<MessageFlight[]>([]);
  /** Recipients whose envelope just landed; each is cleared after the flash. */
  const landedSessionIds = ref<Set<string>>(new Set());
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopFlightEvents: (() => void) | null = null;

  function centreOf(sessionId: string): FlightPoint | null {
    const root = options.rootEl.value;
    // A hidden pane (inactive dock tab, v-show) stays mounted, but its
    // animation never runs: treat it as having no target so the paste is
    // released at once instead of after the main-process timeout.
    if (!root || root.checkVisibility?.() === false) return null;
    const anchor = options.resolveAnchor(sessionId);
    if (!anchor) return null;
    const anchorRect = anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return {
      x: anchorRect.left - rootRect.left + root.scrollLeft + anchorRect.width / 2,
      y: anchorRect.top - rootRect.top + root.scrollTop + anchorRect.height / 2,
    };
  }

  function cornerOf(): FlightPoint {
    const width = options.rootEl.value?.clientWidth ?? 0;
    return { x: Math.max(CORNER_INSET_PX, width - CORNER_INSET_PX), y: CORNER_INSET_PX + (options.rootEl.value?.scrollTop ?? 0) };
  }

  /** Fire-and-forget ack: a failed ack must not surface as an unhandled rejection. */
  function release(flightId: string): void {
    sessionsClient.ackSessionMessageFlight(flightId)?.catch(() => {});
  }

  function onFlight(event: SessionMessageFlight): void {
    const to = centreOf(event.recipientSessionId);
    if (!to) {
      // Nowhere to land (closed, filtered, pane hidden): release at once so
      // the held paste is never hostage to a missing target.
      release(event.flightId);
      return;
    }
    const from = centreOf(event.senderSessionId) ?? cornerOf();
    flights.value = [...flights.value, {
      id: event.flightId,
      recipientSessionId: event.recipientSessionId,
      fromX: from.x,
      fromY: from.y,
      dx: to.x - from.x,
      dy: to.y - from.y,
      colour: event.isReply ? MESSAGE_FLIGHT_COLORS.reply : MESSAGE_FLIGHT_COLORS.send,
    }];
  }

  function onFlightLanded(flightId: string): void {
    const flight = flights.value.find(f => f.id === flightId);
    if (!flight) return;
    flights.value = flights.value.filter(f => f.id !== flightId);
    release(flightId);
    flashRecipient(flight.recipientSessionId);
  }

  function flashRecipient(sessionId: string): void {
    landedSessionIds.value = new Set([...landedSessionIds.value, sessionId]);
    const timer = setTimeout(() => {
      flashTimers.delete(timer);
      const next = new Set(landedSessionIds.value);
      next.delete(sessionId);
      landedSessionIds.value = next;
    }, FLIGHT_LANDING_FLASH_MS);
    flashTimers.add(timer);
  }

  function flightStyle(flight: MessageFlight): Record<string, string> {
    return {
      left: `${flight.fromX}px`,
      top: `${flight.fromY}px`,
      '--flight-colour': flight.colour,
      '--flight-dx': `${flight.dx}px`,
      '--flight-dy': `${flight.dy}px`,
    };
  }

  onMounted(() => {
    stopFlightEvents = sessionsClient.onSessionMessageFlight?.(onFlight) ?? null;
  });
  onBeforeUnmount(() => {
    stopFlightEvents?.();
    stopFlightEvents = null;
    // Unmounting mid-flight must not strand a held paste until the timeout.
    for (const flight of flights.value) release(flight.id);
    flights.value = [];
    for (const timer of flashTimers) clearTimeout(timer);
    flashTimers.clear();
  });

  return { flights, landedSessionIds, onFlightLanded, flightStyle };
}
