import { reactive, readonly } from 'vue';
import { deliveryClient, eventsClient } from '../ipc/clients.js';

/**
 * Renderer mirror of the main process's pending compaction handovers.
 *
 * A handover is armed by `session_compact` and pasted back automatically once
 * the session falls quiet. In between, the session's terminal is locked — not
 * for decoration, but because keystrokes are PTY output and PTY output resets
 * the silence timer the delivery is waiting on. Typing into a compacting session
 * would push its own handover out indefinitely.
 *
 * Module-level state, subscribed once: the events are per-window and every
 * consumer wants the same view of them.
 */
const pending = reactive(new Set<string>());
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  eventsClient.onHandoverArmed?.((event: { sessionId: string }) => pending.add(event.sessionId));
  eventsClient.onHandoverDelivered?.((event: { sessionId: string }) => pending.delete(event.sessionId));
  eventsClient.onHandoverLost?.((event: { sessionId: string }) => pending.delete(event.sessionId));
  // A reloaded renderer missed the armed events; main still holds the truth.
  void Promise.resolve(deliveryClient.handoverList?.())
    .then(ids => { for (const id of ids ?? []) pending.add(id); })
    .catch(error => console.warn('[Handover] Could not load pending handovers:', error));
}

export function useHandover() {
  subscribe();

  return {
    pending: readonly(pending),
    isPending: (sessionId: string | null | undefined): boolean =>
      sessionId !== null && sessionId !== undefined && pending.has(sessionId),
    /**
     * Give up on the handover. The main process reports the loss to the user —
     * the note is unrecoverable, because the context that wrote it is gone.
     */
    cancel: async (sessionId: string): Promise<void> => {
      await deliveryClient.handoverCancel(sessionId);
      pending.delete(sessionId);
    },
    /** Paste now; the lock lifts on the delivered event, once the paste lands. */
    sendNow: async (sessionId: string): Promise<void> => {
      await deliveryClient.handoverSendNow(sessionId);
    },
  };
}
