/**
 * PendingHandoverModal keyboard containment.
 *
 * The lock is mechanical: keystrokes are PTY output, and PTY output resets the
 * silence timer the handover delivery waits on. A key that leaks through to the
 * terminal does not merely type a stray character — it defers the session's own
 * handover, which is the failure this dialog exists to prevent.
 *
 * Driven through the real key router, not a stub: a stubbed router passes while
 * the real one leaks.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const armedCallbacks: Array<(event: { sessionId: string }) => void> = [];
const cancelled: string[] = [];

// Stubbed before the composable is imported: it subscribes on first use.
(globalThis as any).window.helm = {
  events: {
    onHandoverArmed: (cb: (event: { sessionId: string }) => void) => {
      armedCallbacks.push(cb);
      return () => {};
    },
    onHandoverDelivered: () => () => {},
    onHandoverLost: () => () => {},
  },
  delivery: {
    handoverCancel: async (sessionId: string) => { cancelled.push(sessionId); },
  },
};

const PendingHandoverModal = (await import('../renderer/components/modals/PendingHandoverModal.vue')).default;
const { useModalStack } = await import('../renderer/composables/useModalStack.js');
const { isKeyboardModalOpen } = await import('../renderer/keyboard/install.js');
const { createTerminalKeyHandlers } = await import('../renderer/keyboard/handlers/terminal-keys.js');
const { installKeyRouter, registerKeyHandler, resetKeyHandlers } = await import('../renderer/keyboard/router.js');
const { PANE_TERMINAL, PANE_PLAN_SCREEN } = await import('../renderer/dock-types.js');

const SESSION = 'compacting-session';
const MODAL_ID = 'pending-handover-modal';

describe('PendingHandoverModal keyboard containment', () => {
  let ptyWrites: Array<{ sessionId: string; data: string }> = [];
  let uninstallRouter: (() => void) | null = null;
  let focusedPane: string = PANE_TERMINAL;

  function installTerminalKeys(): void {
    for (const handler of createTerminalKeyHandlers({
      writePty: (id, data) => { ptyWrites.push({ sessionId: id, data }); },
      deliverText: async () => {},
      readClipboardText: async () => '',
      isEscProtectionArmed: () => false,
      openEscProtection: () => {},
    })) {
      registerKeyHandler(handler);
    }

    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => SESSION,
      getFocusedPane: () => focusedPane as any,
      isPaneVisible: () => true,
      isModalOpen: isKeyboardModalOpen,
    });
  }

  /** Arm a handover the way the main process would. */
  function arm(sessionId = SESSION): void {
    for (const cb of armedCallbacks) cb({ sessionId });
  }

  function mountModal(terminalFocused: boolean) {
    return mount(PendingHandoverModal, {
      props: { sessionId: SESSION, terminalFocused },
    });
  }

  function press(key: string): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  beforeEach(() => {
    resetKeyHandlers();
    ptyWrites = [];
    cancelled.length = 0;
    focusedPane = PANE_TERMINAL;
    useModalStack().pop(MODAL_ID);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    uninstallRouter?.();
    uninstallRouter = null;
    resetKeyHandlers();
    useModalStack().pop(MODAL_ID);
  });

  it('locks the terminal while a handover is pending and its terminal is focused', async () => {
    installTerminalKeys();
    const modal = mountModal(true);
    await nextTick();

    // Nothing pending yet — the terminal must still work normally.
    press('q');
    expect(isKeyboardModalOpen()).toBe(false);
    expect(ptyWrites).toHaveLength(1);

    arm();
    await nextTick();

    expect(isKeyboardModalOpen()).toBe(true);
    press('q');
    expect(ptyWrites).toHaveLength(1);

    modal.unmount();
  });

  it('does not claim the keyboard when the pending session is not the focused pane', async () => {
    focusedPane = PANE_PLAN_SCREEN;
    installTerminalKeys();
    const modal = mountModal(false);
    await nextTick();

    arm();
    await nextTick();

    // A background session compacting must not freeze the rest of the app.
    expect(isKeyboardModalOpen()).toBe(false);

    modal.unmount();
  });

  it('cancels the handover on Escape and releases the lock', async () => {
    installTerminalKeys();
    const modal = mountModal(true);
    await nextTick();
    arm();
    await nextTick();

    press('Escape');
    await vi.waitFor(() => expect(cancelled).toEqual([SESSION]));
    await nextTick();

    expect(isKeyboardModalOpen()).toBe(false);
    expect(ptyWrites).toHaveLength(0);

    modal.unmount();
  });
});
