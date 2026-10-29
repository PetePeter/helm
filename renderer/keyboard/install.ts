/**
 * Router installation — the wiring that turns app state into a `KeyEnvironment`.
 *
 * Kept out of `router.ts` so the router core stays free of store imports and
 * testable without Pinia, and out of the shell components so the "what counts
 * as a modal" answer has exactly one definition across every window.
 */

import { isAnyBridgeModalVisible } from '../stores/modal-bridge.js';
import { useModalStack } from '../composables/useModalStack.js';
import { hasAttachedModal } from '../modals/modal-base.js';
import type { PaneId } from '../dock-types.js';
import { installKeyRouter, type KeyEnvironment } from './router.js';
import { createKeypressCounter } from './keypress-counter.js';
import { timeClient } from '../ipc/clients.js';

/**
 * Does something modal own the keyboard right now?
 *
 * Sourced from the modal systems' own lifecycles — the Vue modal stack, the
 * bridge modals, and the imperative modal-base attachments — rather than from
 * `querySelector('.modal-overlay.modal--visible')`. The DOM probe was copied
 * into eight call sites and could not see a modal that had not rendered yet.
 */
export function isKeyboardModalOpen(): boolean {
  return useModalStack().isOpen.value || isAnyBridgeModalVisible() || hasAttachedModal();
}

/** Install the router for any window whose panes come from a dock workspace. */
export function installDockKeyRouter(env: {
  getActiveSessionId: () => string | null;
  getFocusedPane: () => PaneId | null;
  isPaneVisible: (pane: PaneId) => boolean;
  /** Panels that take over the shell without being modals (settings, draft editor). */
  isPanelOpen: () => boolean;
}): () => void {
  const environment: KeyEnvironment = {
    getActiveSessionId: env.getActiveSessionId,
    getFocusedPane: env.getFocusedPane,
    isPaneVisible: env.isPaneVisible,
    // A full-shell panel blocks workspace keys exactly like a modal does, which
    // is what every hand-rolled guard used to do inline.
    isModalOpen: () => isKeyboardModalOpen() || env.isPanelOpen(),
  };

  const counter = createKeypressCounter((sessionId, count, at) => {
    const record = timeClient.timeRecordKeys;
    if (!record) return; // A renderer reload can precede the main process and preload restart.
    void record(sessionId, count, at).catch(error => console.warn('[Keypresses] Failed to record batch:', error));
  });
  const uninstall = installKeyRouter(environment, (event, sessionId) => counter.record(sessionId, event));
  window.addEventListener('pagehide', counter.flush);
  return () => { uninstall(); window.removeEventListener('pagehide', counter.flush); counter.flush(); };
}
