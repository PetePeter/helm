/**
 * @vitest-environment jsdom
 *
 * The router is the single owner of global keyboard input: one listener, an
 * explicitly declared precedence chain, and the only place that suppresses an
 * event. It replaced eight competing capture-phase listeners whose priority was
 * an accident of module import order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installKeyRouter,
  registerKeyHandler,
  resetKeyHandlers,
  type KeyHandler,
} from '../../renderer/keyboard/router.js';
import { type KeyEnvironment } from '../../renderer/keyboard/key-context.js';
import { PANE_SESSIONS, PANE_TERMINAL } from '../../renderer/dock-types.js';

let uninstall: (() => void) | null = null;

function install(over: Partial<KeyEnvironment> = {}): void {
  uninstall = installKeyRouter({
    getActiveSessionId: () => 'session-1',
    getFocusedPane: () => PANE_TERMINAL,
    isPaneVisible: () => true,
    isModalOpen: () => false,
    ...over,
  });
}

function handler(over: Partial<KeyHandler> & Pick<KeyHandler, 'id' | 'scope'>): KeyHandler {
  return { handle: () => true, ...over };
}

function press(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  resetKeyHandlers();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetKeyHandlers();
});

describe('claim chain', () => {
  it('the first handler that returns true wins and later handlers never run', () => {
    const second = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'first', scope: 'global', handle: () => true }));
    registerKeyHandler(handler({ id: 'second', scope: 'global', handle: second }));
    install();

    press();

    expect(second).not.toHaveBeenCalled();
  });

  it('a handler returning false passes the event on', () => {
    const second = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'first', scope: 'global', handle: () => false }));
    registerKeyHandler(handler({ id: 'second', scope: 'global', handle: second }));
    install();

    press();

    expect(second).toHaveBeenCalledOnce();
  });

  it('a handler whose claims() is false is never asked to handle', () => {
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'picky', scope: 'global', claims: () => false, handle }));
    install();

    press();

    expect(handle).not.toHaveBeenCalled();
  });

  // The whole point of the refactor. Registration order used to BE the
  // priority, so importing a module earlier silently outranked another.
  it('precedence follows declared scope, not registration order', () => {
    const order: string[] = [];
    registerKeyHandler(handler({ id: 'terminal', scope: 'terminal', handle: () => { order.push('terminal'); return false; } }));
    registerKeyHandler(handler({ id: 'pane', scope: 'pane', handle: () => { order.push('pane'); return false; } }));
    registerKeyHandler(handler({ id: 'global', scope: 'global', handle: () => { order.push('global'); return false; } }));
    registerKeyHandler(handler({ id: 'modal', scope: 'modal', handle: () => { order.push('modal'); return false; } }));
    install();

    press();

    expect(order).toEqual(['modal', 'global', 'pane', 'terminal']);
  });

  it('handlers within one scope keep registration order', () => {
    const order: string[] = [];
    registerKeyHandler(handler({ id: 'a', scope: 'global', handle: () => { order.push('a'); return false; } }));
    registerKeyHandler(handler({ id: 'b', scope: 'global', handle: () => { order.push('b'); return false; } }));
    install();

    press();

    expect(order).toEqual(['a', 'b']);
  });
});

describe('event suppression', () => {
  // Handlers return a boolean; the router alone suppresses. paste-handler used
  // to preventDefault Escape up-front and then fall through to a stale guard
  // that dropped it — Escape reached neither the PTY nor xterm.
  it('a claimed key is default-prevented and stopped', () => {
    registerKeyHandler(handler({ id: 'eater', scope: 'global', handle: () => true }));
    install();

    expect(press().defaultPrevented).toBe(true);
  });

  it('an unclaimed key is left completely untouched so xterm can handle it', () => {
    registerKeyHandler(handler({ id: 'passer', scope: 'global', handle: () => false }));
    install();

    expect(press().defaultPrevented).toBe(false);
  });

  it('a key with no registered handlers at all is untouched', () => {
    install();

    expect(press().defaultPrevented).toBe(false);
  });
});

describe('editable scope', () => {
  function focusInput(): HTMLInputElement {
    document.body.innerHTML = '<input id="field" />';
    const field = document.querySelector('#field') as HTMLInputElement;
    field.focus();
    return field;
  }

  function pressIn(field: Element, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...init });
    field.dispatchEvent(event);
    return event;
  }

  it('an editable field blocks ordinary handlers', () => {
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'global', scope: 'global', handle }));
    install();

    pressIn(focusInput());

    expect(handle).not.toHaveBeenCalled();
  });

  // Ctrl+Shift+N (new session) has always worked while typing in a field; the
  // opt-in keeps that explicit instead of implicit in handler ordering.
  it('allowInEditable opts a handler back in', () => {
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'spawn', scope: 'global', allowInEditable: true, handle }));
    install();

    pressIn(focusInput(), { key: 'N', ctrlKey: true, shiftKey: true });

    expect(handle).toHaveBeenCalledOnce();
  });

  it('modal handlers are never blocked by an editable field', () => {
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'modal', scope: 'modal', handle }));
    install({ isModalOpen: () => true });

    pressIn(focusInput());

    expect(handle).toHaveBeenCalledOnce();
  });

  // A terminal is not an editable field, however much its hidden textarea looks
  // like one. This is the exact regression that killed Ctrl+Shift+<pane>.
  it('a terminal does not count as an editable field', () => {
    document.body.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
    const helper = document.querySelector('.xterm-helper-textarea')!;
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'global', scope: 'global', handle }));
    install();

    pressIn(helper, { key: 'O', ctrlKey: true, shiftKey: true });

    expect(handle).toHaveBeenCalledOnce();
  });
});

describe('dropped-keystroke warning', () => {
  // The parked-focus bug: space (and every other character) fell through the
  // whole chain because DOM focus had drifted to non-terminal chrome, and it
  // stayed dead until an unrelated flow happened to re-focus the terminal.
  // The router is the single chokepoint that sees every fall-through, so it
  // is where the diagnosis is logged — with the parked element, which is the
  // evidence for *why*.
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function focusInput(): HTMLInputElement {
    document.body.innerHTML = '<input id="field" />';
    const field = document.querySelector('#field') as HTMLInputElement;
    field.focus();
    return field;
  }

  function pressIn(field: Element, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...init });
    field.dispatchEvent(event);
    return event;
  }

  it('warns when a printable key falls through while the terminal pane is the keyboard target', () => {
    document.body.innerHTML = '<button id="parked"></button>';
    (document.querySelector('#parked') as HTMLButtonElement).focus();
    install();

    press({ key: ' ' });

    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
    expect(message).toContain('" "');
    expect(message).toContain('session-1');
    expect(message).toContain('button#parked');
  });

  it('stays silent when no session is active', () => {
    install({ getActiveSessionId: () => null });
    press();

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when an editable field owns the key', () => {
    install();
    pressIn(focusInput());

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when xterm owns the key', () => {
    document.body.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
    const helper = document.querySelector('.xterm-helper-textarea')!;
    install();
    pressIn(helper);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent while a modal is open', () => {
    install({ isModalOpen: () => true });
    press();

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the keyboard target is a non-terminal pane', () => {
    install({ getFocusedPane: () => PANE_SESSIONS });
    press();

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent for modifier-only, multi-char and modified keys', () => {
    install();
    press({ key: 'Shift' });
    press({ key: 'Enter' });
    press({ key: 'a', ctrlKey: true });

    expect(warn).not.toHaveBeenCalled();
  });

  it('throttles repeats inside the window', () => {
    install();
    press({ key: 'a' });
    press({ key: 'b' });

    expect(warn).toHaveBeenCalledOnce();
  });

  it('stays silent when a handler claims the key', () => {
    registerKeyHandler(handler({ id: 'eater', scope: 'global', handle: () => true }));
    install();
    press();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('unregistering stops a handler claiming', () => {
    const handle = vi.fn(() => true);
    const unregister = registerKeyHandler(handler({ id: 'transient', scope: 'global', handle }));
    install();

    unregister();
    press();

    expect(handle).not.toHaveBeenCalled();
  });

  it('uninstalling removes the listener', () => {
    const handle = vi.fn(() => true);
    registerKeyHandler(handler({ id: 'x', scope: 'global', handle }));
    install();

    uninstall?.();
    uninstall = null;
    press();

    expect(handle).not.toHaveBeenCalled();
  });
});
