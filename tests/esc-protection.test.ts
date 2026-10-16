/**
 * ESC protection tests
 *
 * Tests the useEscProtection composable and keyboard bridge integration.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Vue
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue');
  return {
    ...actual,
    onMounted: vi.fn((fn: () => void) => fn()),
    onUnmounted: vi.fn(),
  };
});

import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useEscProtection } from '../renderer/composables/useEscProtection.js';
import { useModalStack } from '../renderer/composables/useModalStack.js';
import { useModalKeyboardBridge } from '../renderer/composables/useModalKeyboardBridge.js';
import EscProtectionModal from '../renderer/components/modals/EscProtectionModal.vue';
import { createTerminalKeyHandlers } from '../renderer/keyboard/handlers/terminal-keys.js';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../renderer/keyboard/router.js';
import { PANE_MEMORIES, PANE_TERMINAL, type PaneId } from '../renderer/dock-types.js';

describe('useEscProtection', () => {
  beforeEach(() => {
    // Reset composable state between tests
    const protection = useEscProtection();
    protection.dismissProtection();
  });

  describe('state transitions', () => {

    it('openProtection opens modal and stores sessionId', () => {
      const protection = useEscProtection();
      protection.openProtection('session-123', () => {});
      expect(protection.isProtecting.value).toBe(true);
      expect(protection.confirmingSessionId.value).toBe('session-123');
    });

    it('dismissProtection dismisses modal and clears sessionId', () => {
      const protection = useEscProtection();
      protection.openProtection('session-123', () => {});
      protection.dismissProtection();
      expect(protection.isProtecting.value).toBe(false);
      expect(protection.confirmingSessionId.value).toBeNull();
    });

    it('confirmProtection runs the stored callback and clears state', () => {
      const protection = useEscProtection();
      let confirmedFor: string | null = null;
      protection.openProtection('session-123', () => { confirmedFor = 'session-123'; });

      protection.confirmProtection();

      expect(confirmedFor).toBe('session-123');
      expect(protection.isProtecting.value).toBe(false);
      expect(protection.confirmingSessionId.value).toBeNull();
    });

    it('dismissProtection never runs the confirm callback', () => {
      const protection = useEscProtection();
      let ran = false;
      protection.openProtection('session-123', () => { ran = true; });

      protection.dismissProtection();

      expect(ran).toBe(false);
    });

    // A stale callback firing against a closed dialog would send a phantom
    // interrupt to whichever session happened to be active.
    it('confirmProtection is inert once the dialog is closed', () => {
      const protection = useEscProtection();
      let calls = 0;
      protection.openProtection('session-123', () => { calls += 1; });

      protection.confirmProtection();
      protection.confirmProtection();

      expect(calls).toBe(1);
    });
  });

  describe('multiple calls', () => {
    it('can open/close multiple times', () => {
      const protection = useEscProtection();
      protection.openProtection('session-1', () => {});
      expect(protection.confirmingSessionId.value).toBe('session-1');

      protection.dismissProtection();
      expect(protection.isProtecting.value).toBe(false);

      protection.openProtection('session-2', () => {});
      expect(protection.confirmingSessionId.value).toBe('session-2');
    });
  });
});

// ---------------------------------------------------------------------------
// Escape routing
//
// Escape reaches the PTY through the keyboard router's `terminal-escape`
// handler. It used to live in the relay's own capture listener, where an
// up-front preventDefault followed by a stale planner guard meant a press could
// be swallowed and then dropped — reaching neither the PTY nor xterm.
// ---------------------------------------------------------------------------

describe('Escape routing', () => {
  let ptyWrites: Array<{ sessionId: string; data: string }> = [];
  let uninstallRouter: (() => void) | null = null;

  interface RelayOptions {
    sessionId?: string | null;
    escProtectionEnabled?: boolean;
    focusedPane?: PaneId;
    modalOpen?: boolean;
  }

  function installRelay(options: RelayOptions = {}): void {
    const {
      sessionId = 'test-session',
      escProtectionEnabled = true,
      focusedPane = PANE_TERMINAL,
      modalOpen = false,
    } = options;

    const protection = useEscProtection();

    for (const handler of createTerminalKeyHandlers({
      writePty: (id, data) => { ptyWrites.push({ sessionId: id, data }); },
      deliverText: async () => {},
      readClipboardText: async () => '',
      isEscProtectionArmed: () => escProtectionEnabled,
      openEscProtection: (id) => protection.openProtection(id, () => {
        ptyWrites.push({ sessionId: id, data: '\x1b' });
      }),
    })) {
      registerKeyHandler(handler);
    }

    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => sessionId,
      getFocusedPane: () => focusedPane,
      isPaneVisible: () => true,
      // Reflect the real stack: once the protection dialog mounts, the router
      // must genuinely see `scope === 'modal'` and stand down.
      isModalOpen: () => modalOpen || useModalStack().isOpen.value,
    });
  }

  function pressEscape(target: EventTarget = document): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    resetKeyHandlers();
    ptyWrites = [];
    useEscProtection().dismissProtection();
    useModalStack().pop('escProtection');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    uninstallRouter?.();
    uninstallRouter = null;
    resetKeyHandlers();
  });

  it('first Escape opens the protection dialog instead of interrupting', () => {
    installRelay();

    pressEscape();

    expect(useEscProtection().isProtecting.value).toBe(true);
    expect(ptyWrites).toHaveLength(0);
  });

  // Protection must pre-empt xterm, which would otherwise send ESC itself.
  it('opens protection even when the keystroke lands inside xterm', () => {
    installRelay();
    document.body.innerHTML = '<div class="xterm" tabindex="0"><textarea class="xterm-helper-textarea"></textarea></div>';

    pressEscape(document.querySelector('.xterm-helper-textarea')!);

    expect(useEscProtection().isProtecting.value).toBe(true);
    expect(ptyWrites).toHaveLength(0);
  });

  it('sends ESC straight through when protection is disabled', () => {
    installRelay({ escProtectionEnabled: false });

    pressEscape();

    expect(useEscProtection().isProtecting.value).toBe(false);
    expect(ptyWrites).toEqual([{ sessionId: 'test-session', data: '\x1b' }]);
  });

  // The dialog is a modal, so `ctx.scope === 'modal'` gates every non-modal
  // handler out of the router. The confirmation therefore has to come from the
  // modal's own stack handler, not from a second pass through terminal-escape.
  it('second Escape confirms through the modal: sends ESC and closes the dialog', async () => {
    installRelay();
    const modal = mount(EscProtectionModal);

    pressEscape();
    await nextTick();

    expect(useEscProtection().isProtecting.value).toBe(true);
    expect(ptyWrites).toHaveLength(0);

    // Second press: the router stands down, the bridge maps Escape to 'B'.
    const secondEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(useModalKeyboardBridge().handler(secondEscape)).toBe(true);
    await nextTick();

    expect(ptyWrites).toEqual([{ sessionId: 'test-session', data: '\x1b' }]);
    expect(useEscProtection().isProtecting.value).toBe(false);
    modal.unmount();
  });

  // Same confirmation path, arriving as a gamepad press rather than a keystroke.
  it('gamepad B confirms the dialog', async () => {
    installRelay();
    const modal = mount(EscProtectionModal);

    pressEscape();
    await nextTick();

    expect(useModalStack().handleInput('B')).toBe(true);
    await nextTick();

    expect(ptyWrites).toEqual([{ sessionId: 'test-session', data: '\x1b' }]);
    expect(useEscProtection().isProtecting.value).toBe(false);
    modal.unmount();
  });

  // Any other button is a change of mind: close, send nothing.
  it('a non-confirm button dismisses without sending ESC', async () => {
    installRelay();
    const modal = mount(EscProtectionModal);

    pressEscape();
    await nextTick();

    useModalStack().handleInput('A');
    await nextTick();

    expect(ptyWrites).toHaveLength(0);
    expect(useEscProtection().isProtecting.value).toBe(false);
    modal.unmount();
  });

  it('stands down behind an ordinary modal', () => {
    installRelay({ modalOpen: true });

    pressEscape();

    expect(useEscProtection().isProtecting.value).toBe(false);
    expect(ptyWrites).toHaveLength(0);
  });

  // The regression that made Escape feel dead: it must never be suppressed
  // unless a handler actually consumed it.
  it('suppresses Escape only when it is consumed', () => {
    installRelay();

    expect(pressEscape().defaultPrevented).toBe(true);
  });

  it('leaves Escape untouched when no session is active', () => {
    installRelay({ sessionId: null });

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(ptyWrites).toHaveLength(0);
  });

  it('leaves Escape to the pane when the terminal is not focused', () => {
    installRelay({ focusedPane: PANE_MEMORIES });

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(ptyWrites).toHaveLength(0);
  });
});
