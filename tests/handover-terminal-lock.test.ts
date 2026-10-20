/**
 * Handover terminal lock — only the compacting session's terminal is locked.
 *
 * Keystrokes are PTY output, and PTY output resets the silence the handover
 * paste waits on, so keys aimed at that terminal are dropped. Nothing else is:
 * the lock is not a modal, so session switching, Draft and Chat keep working.
 *
 * Driven through the real key router and terminal key handlers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

type Listener = (event: { sessionId: string }) => void;
const listeners = { armed: [] as Listener[], delivered: [] as Listener[] };
const ptyWrites: Array<{ sessionId: string; data: string }> = [];

// Stubbed before the composables are imported: useHandover subscribes on first use.
(globalThis as any).window.helm = {
  events: {
    onHandoverArmed: (cb: Listener) => { listeners.armed.push(cb); return () => {}; },
    onHandoverDelivered: (cb: Listener) => { listeners.delivered.push(cb); return () => {}; },
    onHandoverLost: () => () => {},
  },
  terminal: {
    ptyWrite: async (sessionId: string, data: string) => { ptyWrites.push({ sessionId, data }); },
  },
  delivery: {},
};

const { useTerminalKeys } = await import('../renderer/composables/useTerminalKeys.js');
const { isKeyboardModalOpen } = await import('../renderer/keyboard/install.js');
const { installKeyRouter, registerKeyHandler, resetKeyHandlers } = await import('../renderer/keyboard/router.js');
const { PANE_TERMINAL } = await import('../renderer/dock-types.js');

const COMPACTING = 'compacting-session';
const OTHER = 'other-session';

describe('handover terminal lock', () => {
  let activeSessionId = COMPACTING;
  let uninstallRouter: (() => void) | null = null;
  let wrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    ptyWrites.length = 0;
    activeSessionId = COMPACTING;
    wrapper = mount(defineComponent({
      setup() { useTerminalKeys({ getActiveSessionId: () => activeSessionId }); return () => null; },
    }));
    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => activeSessionId,
      getFocusedPane: () => PANE_TERMINAL as any,
      isPaneVisible: () => true,
      isModalOpen: isKeyboardModalOpen,
    });
  });

  afterEach(() => {
    for (const cb of listeners.delivered) cb({ sessionId: COMPACTING });
    wrapper?.unmount();
    uninstallRouter?.();
    resetKeyHandlers();
  });

  const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const arm = () => { for (const cb of listeners.armed) cb({ sessionId: COMPACTING }); };

  it('drops keys aimed at the compacting terminal, and takes them again once delivered', () => {
    arm();
    press('a');
    press('Escape');
    expect(ptyWrites).toEqual([]);

    for (const cb of listeners.delivered) cb({ sessionId: COMPACTING });
    press('a');
    expect(ptyWrites).toEqual([{ sessionId: COMPACTING, data: 'a' }]);
  });

  it('is not a modal: app shortcuts still fire and other sessions still type', () => {
    arm();
    expect(isKeyboardModalOpen()).toBe(false);

    const shortcuts: string[] = [];
    registerKeyHandler({
      id: 'test-switch-session',
      scope: 'global',
      handle: (ctx) => { if (ctx.combo === 'ctrl+tab') { shortcuts.push('switch'); return true; } return false; },
    });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(shortcuts).toEqual(['switch']);

    activeSessionId = OTHER;
    press('b');
    expect(ptyWrites).toEqual([{ sessionId: OTHER, data: 'b' }]);
  });
});
