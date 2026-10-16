/**
 * @vitest-environment jsdom
 *
 * Ctrl+<n> / Alt+<n> accelerators.
 *
 * These were two capture-phase `window` listeners instantiated per window; they
 * are router handlers now, so the suite drives them through the router the app
 * actually installs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNumberKeyHandlers } from '../../renderer/keyboard/handlers/number-keys.js';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../../renderer/keyboard/router.js';
import { PANE_TERMINAL } from '../../renderer/dock-types.js';

describe('number accelerators', () => {
  let jumpToSession: ReturnType<typeof vi.fn>;
  let fireChipAction: ReturnType<typeof vi.fn>;
  let uninstallRouter: (() => void) | null = null;
  let unregisters: Array<() => void> = [];
  let modalOpen = false;

  function install(): void {
    unregisters = createNumberKeyHandlers({
      jumpToSession: (slot) => jumpToSession(slot) as boolean,
      fireChipAction: (slot) => fireChipAction(slot) as boolean,
    }).map(registerKeyHandler);

    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => 'session-1',
      getFocusedPane: () => PANE_TERMINAL,
      isPaneVisible: () => true,
      isModalOpen: () => modalOpen,
    });
  }

  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    resetKeyHandlers();
    modalOpen = false;
    jumpToSession = vi.fn().mockReturnValue(true);
    fireChipAction = vi.fn().mockReturnValue(true);
    document.body.innerHTML = '<div id="root"></div>';
    install();
  });

  afterEach(() => {
    uninstallRouter?.();
    uninstallRouter = null;
    resetKeyHandlers();
  });

  it('ctrl: digits 1-9 emit the matching slot', () => {
    for (let digit = 1; digit <= 9; digit++) {
      press({ key: String(digit), code: `Digit${digit}`, ctrlKey: true });
    }

    expect(jumpToSession.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('ctrl: session jump works while an editable textarea has focus', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    const event = new KeyboardEvent('keydown', {
      key: '3',
      code: 'Digit3',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);

    expect(jumpToSession).toHaveBeenCalledWith(3);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves plain typing and Ctrl+Enter available to an editable textarea', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    const received = vi.fn();
    textarea.addEventListener('keydown', received);

    const typing = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
    textarea.dispatchEvent(typing);
    const send = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(send);

    expect(typing.defaultPrevented).toBe(false);
    expect(send.defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledTimes(2);
    expect(jumpToSession).not.toHaveBeenCalled();
  });

  it('ctrl: digit 0 emits slot 0', () => {
    press({ key: '0', code: 'Digit0', ctrlKey: true });

    expect(jumpToSession).toHaveBeenCalledWith(0);
  });

  it('alt: digits 1-9 emit the matching slot', () => {
    for (let digit = 1; digit <= 9; digit++) {
      press({ key: String(digit), code: `Digit${digit}`, altKey: true });
    }

    expect(fireChipAction.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('alt: digit 0 emits slot 0', () => {
    press({ key: '0', code: 'Digit0', altKey: true });

    expect(fireChipAction).toHaveBeenCalledWith(0);
  });

  it('ignores the wrong modifier (an alt press never reaches the ctrl scheme)', () => {
    press({ key: '1', code: 'Digit1', altKey: true });

    expect(jumpToSession).not.toHaveBeenCalled();
    expect(fireChipAction).toHaveBeenCalledWith(1);
  });

  it('ignores extra modifiers (ctrl+shift, ctrl+meta)', () => {
    press({ key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    press({ key: '1', code: 'Digit1', ctrlKey: true, metaKey: true });

    expect(jumpToSession).not.toHaveBeenCalled();
  });

  // Alt remaps e.key to a symbol on several layouts; e.code stays digit-stable.
  it('resolves the slot from e.code when alt remaps e.key to a symbol', () => {
    press({ key: '¡', code: 'Digit1', altKey: true });

    expect(fireChipAction).toHaveBeenCalledWith(1);
  });

  it('stands down while a modal owns the keyboard', () => {
    modalOpen = true;

    press({ key: '1', code: 'Digit1', ctrlKey: true });

    expect(jumpToSession).not.toHaveBeenCalled();
  });

  it('suppresses the key only when the slot is consumed', () => {
    expect(press({ key: '1', code: 'Digit1', ctrlKey: true }).defaultPrevented).toBe(true);
  });

  // An unmapped slot must fall through rather than swallowing the digit.
  it('falls through when the slot maps to nothing', () => {
    jumpToSession.mockReturnValue(false);

    const event = press({ key: '1', code: 'Digit1', ctrlKey: true });

    expect(jumpToSession).toHaveBeenCalledWith(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops responding once unregistered', () => {
    for (const unregister of unregisters) unregister();

    press({ key: '1', code: 'Digit1', ctrlKey: true });

    expect(jumpToSession).not.toHaveBeenCalled();
  });
});
