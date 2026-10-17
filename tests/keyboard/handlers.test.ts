/**
 * @vitest-environment jsdom
 *
 * The real handler factories, driven with fake collaborators (no mocks — each
 * fake is a working stand-in that records what happened).
 *
 * Every case here is a bug that shipped. They all had the same cause: the
 * handler decided its own eligibility from a DOM probe instead of asking the
 * resolved context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDockShortcutKeyHandlers, createWorkspaceKeyHandlers, type WorkspaceKeyDeps } from '../../renderer/keyboard/handlers/workspace-keys.js';
import { createTerminalKeyHandlers, type TerminalKeyDeps } from '../../renderer/keyboard/handlers/terminal-keys.js';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../../renderer/keyboard/router.js';
import { type KeyEnvironment } from '../../renderer/keyboard/key-context.js';
import {
  PANE_ARTIFACTS,
  PANE_CHAT,
  PANE_DRAFT,
  PANE_MEMORIES,
  PANE_TERMINAL,
  dockPaneRegistry,
  type DockPaneDescriptor,
  type PaneId,
} from '../../renderer/dock-types.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

function fakeWorkspace() {
  const calls = { activated: [] as PaneId[], cycled: [] as number[], jumped: [] as number[], chips: [] as number[], spawned: 0, closed: 0 };
  const deps: WorkspaceKeyDeps = {
    activatePane: (pane) => { calls.activated.push(pane); },
    cycleSession: (direction) => { calls.cycled.push(direction); },
    jumpToSession: (slot) => { calls.jumped.push(slot); return true; },
    fireChipAction: (slot) => { calls.chips.push(slot); return true; },
    spawnSession: () => { calls.spawned += 1; },
    closeActiveSession: () => { calls.closed += 1; },
  };
  return { deps, calls };
}

function fakeTerminal() {
  const calls = { pty: [] as string[], pasted: [] as string[], escProtection: 0 };
  const deps: TerminalKeyDeps = {
    writePty: (_sessionId, data) => { calls.pty.push(data); },
    deliverText: async (_sessionId, text) => { calls.pasted.push(text); },
    readClipboardText: async () => 'clipboard text',
    isEscProtectionArmed: () => false,
    openEscProtection: () => { calls.escProtection += 1; },
  };
  return { deps, calls };
}

// ── Harness ─────────────────────────────────────────────────────────────────

let uninstall: (() => void) | null = null;
const registeredTestPanes: PaneId[] = [];

function install(over: Partial<KeyEnvironment> = {}): void {
  uninstall = installKeyRouter({
    getActiveSessionId: () => 'session-1',
    getFocusedPane: () => PANE_TERMINAL,
    isPaneVisible: () => true,
    isModalOpen: () => false,
    ...over,
  });
}

/** Dispatch from inside a real xterm DOM so terminal scope is genuinely exercised. */
function pressInTerminal(init: KeyboardEventInit): KeyboardEvent {
  document.body.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
  const helper = document.querySelector('.xterm-helper-textarea')!;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  helper.dispatchEvent(event);
  return event;
}

/** Dispatch from a focused plain textarea — the draft pad, a form field. */
function pressInField(init: KeyboardEventInit): KeyboardEvent {
  document.body.innerHTML = '<textarea id="field"></textarea>';
  const field = document.querySelector('#field') as HTMLTextAreaElement;
  field.focus();
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  resetKeyHandlers();
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  for (const paneId of registeredTestPanes.splice(0)) dockPaneRegistry.unregister(paneId);
});

// ── Workspace shortcuts ─────────────────────────────────────────────────────

describe('dock pane shortcuts', () => {
  // The reported regression: MainWindowApp guarded on closest('textarea'), and
  // xterm's helper textarea matched, so every Ctrl+Shift+<pane> died the moment
  // you were actually using a terminal.
  it('Ctrl+Shift+M activates Memories while typing in a terminal', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_MEMORIES]);
  });

  it('Ctrl+Shift+M activates Memories from a terminal', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_MEMORIES]);
  });

  it('Ctrl+Shift+A activates Artifacts from a terminal', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_ARTIFACTS]);
  });

  it('Ctrl+Shift+J activates Chat while typing', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    const event = pressInField({ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_CHAT]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes only pop-out pane shortcuts and Ctrl+G', () => {
    const activated: PaneId[] = [];
    createDockShortcutKeyHandlers(pane => activated.push(pane), 'popout').forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_TERMINAL });

    press({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    press({ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true });
    press({ key: 'g', code: 'KeyG', ctrlKey: true });

    expect(activated).toEqual([PANE_TERMINAL, PANE_DRAFT]);
  });

  // Pane shortcuts are navigation, not editing: typing in the draft pad (or any
  // field) must not trap you there.
  it('Ctrl+Shift+M activates Memories while typing in a text field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    const event = pressInField({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_MEMORIES]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cycles shared shortcuts from the focused pane and starts at the first elsewhere', () => {
    const sharedPanes: DockPaneDescriptor[] = [
      { id: 'test-shared-a', kind: 'tool', title: 'A', icon: 'A', shortcut: 'z', closable: true, home: 'left', dynamic: true },
      { id: 'test-shared-b', kind: 'tool', title: 'B', icon: 'B', shortcut: 'z', closable: true, home: 'left', dynamic: true },
    ];
    sharedPanes.forEach(pane => {
      dockPaneRegistry.register(pane);
      registeredTestPanes.push(pane.id);
    });
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    let focusedPane: PaneId | null = PANE_MEMORIES;
    install({ getFocusedPane: () => focusedPane });

    press({ key: 'Z', ctrlKey: true, shiftKey: true });
    focusedPane = 'test-shared-a';
    press({ key: 'Z', ctrlKey: true, shiftKey: true });
    focusedPane = 'test-shared-b';
    press({ key: 'Z', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual(['test-shared-a', 'test-shared-b', 'test-shared-a']);
  });

  it('Ctrl+Shift+D activates the draft pane', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([PANE_DRAFT]);
  });

  it('an unmapped Ctrl+Shift chord in a text field is left to the field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    const event = pressInField({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a dock shortcut is gated while a modal owns keyboard input', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install({ isModalOpen: () => true });

    const event = press({ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.activated).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Ctrl+G', () => {
  it('opens the draft pane from a terminal', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'g', code: 'KeyG', ctrlKey: true });

    expect(workspace.calls.activated).toEqual([PANE_DRAFT]);
  });

  it('opens the draft pane while typing in a text field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInField({ key: 'g', code: 'KeyG', ctrlKey: true });

    expect(workspace.calls.activated).toEqual([PANE_DRAFT]);
  });
});

describe('session cycling', () => {
  // Ctrl+Tab took a `querySelector('.plan-screen.visible')` branch that became
  // permanently true once the planner became a dock pane (v-show keeps inactive
  // panes mounted), so it re-selected the current session and looked dead.
  it('Ctrl+Tab cycles forward even with the plan pane mounted but not visible', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install({ isPaneVisible: (pane) => pane === PANE_TERMINAL });

    document.body.innerHTML = '<div class="plan-screen visible" style="display:none"></div>';
    press({ key: 'Tab', code: 'Tab', ctrlKey: true });

    expect(workspace.calls.cycled).toEqual([1]);
  });

  it('Ctrl+Shift+Tab cycles backward', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    press({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.cycled).toEqual([-1]);
  });

  it('cycles from a terminal too', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'Tab', code: 'Tab', ctrlKey: true });

    expect(workspace.calls.cycled).toEqual([1]);
  });

  it('cycles while typing in a text field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInField({ key: 'Tab', code: 'Tab', ctrlKey: true });

    expect(workspace.calls.cycled).toEqual([1]);
  });

  // Sessions are the spine; T/O/M/A/P are aspects onto the selected session.
  // Cycling moves the spine and leaves the aspect where it is.
  it('cycling never changes which pane is focused', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_MEMORIES });

    press({ key: 'Tab', code: 'Tab', ctrlKey: true });

    expect(workspace.calls.cycled).toEqual([1]);
    expect(workspace.calls.activated).toEqual([]);
  });
});

describe('session meta keys', () => {
  it('Ctrl+Shift+R renames through the Session List while the terminal is focused', () => {
    const terminal = fakeTerminal();
    const renames: string[] = [];
    terminal.deps.renameSession = (sessionId) => { renames.push(sessionId); };
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    const event = press({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true });

    expect(renames).toEqual(['session-1']);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('number accelerators', () => {
  it('Ctrl+3 jumps to the third session', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    press({ key: '3', code: 'Digit3', ctrlKey: true });

    expect(workspace.calls.jumped).toEqual([3]);
  });

  it('Ctrl+number selects through the shared session path before terminal input can see it', () => {
    const workspace = fakeWorkspace();
    const terminal = fakeTerminal();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    const event = pressInTerminal({ key: '3', code: 'Digit3', ctrlKey: true });

    expect(workspace.calls.jumped).toEqual([3]);
    expect(terminal.calls.pty).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Alt+1 fires the first chip action even when Alt remaps the key', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    press({ key: '¡', code: 'Digit1', altKey: true });

    expect(workspace.calls.chips).toEqual([1]);
  });
});

describe('session lifecycle shortcuts', () => {
  // Ctrl+Shift+N always worked mid-typing; the opt-in keeps that deliberate.
  it('Ctrl+Shift+N spawns a session from inside a text field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    document.body.innerHTML = '<textarea id="field"></textarea>';
    const field = document.querySelector('#field') as HTMLTextAreaElement;
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));

    expect(workspace.calls.spawned).toBe(1);
  });

  // Closing acts on the terminal you can see, so visibility is the test — you
  // routinely close a session with the sidebar focused and its terminal on screen.
  it('Ctrl+Shift+W closes the active session while the terminal is visible', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_MEMORIES });

    press({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.closed).toBe(1);
  });

  it('Ctrl+Shift+W stands down when no terminal is on screen', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_MEMORIES, isPaneVisible: (pane) => pane !== PANE_TERMINAL });

    press({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.closed).toBe(0);
  });

  it('Ctrl+Shift+W does not close a session while typing in an editable field', () => {
    const workspace = fakeWorkspace();
    createWorkspaceKeyHandlers(workspace.deps).forEach(registerKeyHandler);
    install();

    pressInField({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true });

    expect(workspace.calls.closed).toBe(0);
  });
});

// ── Terminal keys ───────────────────────────────────────────────────────────

describe('Escape', () => {
  // Escape was `preventDefault`ed at the top of the relay and then dropped by
  // the stale planner guard, so it reached neither the PTY nor xterm.
  it('reaches the PTY when the terminal is focused', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    press({ key: 'Escape', code: 'Escape' });

    expect(terminal.calls.pty).toEqual(['\x1b']);
  });

  it('opens the protection dialog instead when protection is armed', () => {
    const terminal = fakeTerminal();
    terminal.deps.isEscProtectionArmed = () => true;
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    press({ key: 'Escape', code: 'Escape' });

    expect(terminal.calls.escProtection).toBe(1);
    expect(terminal.calls.pty).toEqual([]);
  });

  it('is left to the pane when something other than the terminal has focus', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_MEMORIES });

    const event = press({ key: 'Escape', code: 'Escape' });

    expect(terminal.calls.pty).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Ctrl+V', () => {
  it('uses the managed paste path when the terminal is focused', async () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    press({ key: 'v', code: 'KeyV', ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(terminal.calls.pasted).toEqual(['clipboard text']);
  });

  // The artifact pane turns a paste into a new artifact, so the terminal must
  // not reduce the clipboard to text/plain first.
  it('is left alone when the artifact pane has focus', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_ARTIFACTS });

    const event = press({ key: 'v', code: 'KeyV', ctrlKey: true });

    expect(terminal.calls.pasted).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('plain key relay', () => {
  it('does not reach the PTY when another pane has focus', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install({ getFocusedPane: () => PANE_MEMORIES });

    press({ key: 'a', code: 'KeyA' });

    expect(terminal.calls.pty).toEqual([]);
  });

  // xterm.js owns its own keystrokes; relaying them too would double every
  // character the user types.
  it('does not double-send when the keystroke already landed in xterm', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    pressInTerminal({ key: 'a', code: 'KeyA' });

    expect(terminal.calls.pty).toEqual([]);
  });

  // Voice transcription and other synthetic typing arrive with the terminal
  // pane focused but no DOM focus inside xterm.
  it('relays synthetic typing aimed at a focused terminal pane', () => {
    const terminal = fakeTerminal();
    createTerminalKeyHandlers(terminal.deps).forEach(registerKeyHandler);
    install();

    press({ key: 'a', code: 'KeyA' });

    expect(terminal.calls.pty).toEqual(['a']);
  });
});
