/**
 * Terminal key registration — binds the terminal handler set to a window's
 * lifecycle and supplies its collaborators.
 *
 * Replaces `useKeyboardRelay` / `setupKeyboardRelay`, which owned a
 * capture-phase `document` listener of its own. Ownership now sits with the
 * keyboard router; this composable only says what the terminal can do and when.
 */

import { onMounted, onUnmounted, ref } from 'vue';
import { createTerminalKeyHandlers } from '../keyboard/handlers/terminal-keys.js';
import { registerKeyHandler } from '../keyboard/router.js';
import { deliverBulkText } from '../paste-handler.js';
import { terminalClient } from '../ipc/clients.js';
import { useEscProtection } from './useEscProtection.js';

export interface TerminalKeysOptions {
  getActiveSessionId: () => string | null;
  /** Reads the persisted setting. Async, so the answer is cached for the key path. */
  getEscProtectionEnabled?: () => Promise<boolean>;
  renameSession?: (sessionId: string) => void;
  clearNotifications?: (sessionId: string) => void;
}

export function useTerminalKeys(options: TerminalKeysOptions): void {
  const unregisters: Array<() => void> = [];

  // The setting lives behind async IPC but the key path must answer
  // synchronously, so it is cached and refreshed after every Escape. A toggle
  // therefore takes effect on the press after the one that observed it.
  const escProtectionEnabled = ref(true);

  async function refreshEscProtection(): Promise<void> {
    if (!options.getEscProtectionEnabled) return;
    try {
      escProtectionEnabled.value = await options.getEscProtectionEnabled();
    } catch (error) {
      console.error('[Keyboard] Failed to read ESC protection setting:', error);
      escProtectionEnabled.value = true;
    }
  }

  onMounted(() => {
    void refreshEscProtection();
    const escProtection = useEscProtection();

    function writePty(sessionId: string, data: string): void {
      void terminalClient.ptyWrite(sessionId, data);
      if (data === '\x1b') void refreshEscProtection();
    }

    const handlers = createTerminalKeyHandlers({
      writePty,
      deliverText: (sessionId, text) => deliverBulkText(sessionId, text),
      readClipboardText: () => navigator.clipboard.readText(),
      isEscProtectionArmed: () => escProtectionEnabled.value,
      openEscProtection: (sessionId) => escProtection.openProtection(
        sessionId,
        () => writePty(sessionId, '\x1b'),
      ),
      renameSession: options.renameSession,
      clearNotifications: options.clearNotifications,
    });

    for (const handler of handlers) unregisters.push(registerKeyHandler(handler));
  });

  onUnmounted(() => {
    for (const unregister of unregisters.splice(0)) unregister();
  });
}
