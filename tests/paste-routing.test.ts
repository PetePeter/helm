// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockShowEditorPopup, mockState, mockGetTerminalManager } = vi.hoisted(() => ({
  mockShowEditorPopup: vi.fn(),
  mockState: {
    sessions: [] as Array<{ id: string; cliType: string }>,
    cliToolsCache: {} as Record<string, { submitSuffix?: string }>,
  },
  mockGetTerminalManager: vi.fn().mockReturnValue(null),
}));

// Mock sequence parser module before importing paste-handler
vi.mock('../src/input/sequence-parser', () => ({
  parseSequence: (input: string) => {
    const actions: any[] = [];
    let i = 0;
    while (i < input.length) {
      if (input[i] === '{') {
        const closeIdx = input.indexOf('}', i + 1);
        if (closeIdx === -1) break;
        const token = input.slice(i + 1, closeIdx);
        if (token.includes('+')) {
          const keys = token.split('+').map(k => k.trim());
          actions.push({ type: 'combo', keys });
        } else {
          actions.push({ type: 'key', key: token });
        }
        i = closeIdx + 1;
      } else {
        let text = '';
        while (i < input.length && input[i] !== '{') {
          text += input[i];
          i++;
        }
        if (text) actions.push({ type: 'text', value: text });
      }
    }
    return actions;
  },
}));

// Mock bindings module before importing paste-handler
vi.mock('../renderer/bindings', () => ({
  keyToPtyEscape: (key: string) => {
    const map: Record<string, string> = {
      'enter': '\r', 'send': '\r', 'tab': '\t', 'escape': '\x1b', 'esc': '\x1b', 'backspace': '\x7f',
      'delete': '\x1b[3~',
      'up': '\x1b[A', 'down': '\x1b[B', 'left': '\x1b[D', 'right': '\x1b[C',
      'arrowup': '\x1b[A', 'arrowdown': '\x1b[B', 'arrowleft': '\x1b[D', 'arrowright': '\x1b[C',
      'home': '\x1b[H', 'end': '\x1b[F', 'pageup': '\x1b[5~', 'pagedown': '\x1b[6~',
      'insert': '\x1b[2~',
      'f1': '\x1bOP', 'f2': '\x1bOQ', 'f3': '\x1bOR', 'f4': '\x1bOS',
      'f5': '\x1b[15~', 'f6': '\x1b[17~', 'f7': '\x1b[18~', 'f8': '\x1b[19~',
      'f9': '\x1b[20~', 'f10': '\x1b[21~', 'f11': '\x1b[23~', 'f12': '\x1b[24~',
      'space': ' ',
    };
    return map[key.toLowerCase()] ?? key;
  },
  comboToPtyEscape: (keys: string[]) => {
    if (keys.length === 2 && keys[0].toLowerCase() === 'ctrl') {
      const k = keys[1].toUpperCase();
      if (k.length === 1 && k >= 'A' && k <= 'Z') {
        return String.fromCharCode(k.charCodeAt(0) - 64);
      }
    }
    return keys.join('');
  },
}));

vi.mock('../renderer/editor/editor-popup.js', () => ({
  showEditorPopup: mockShowEditorPopup,
}));

vi.mock('../renderer/state.js', () => ({
  state: mockState,
}));

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  getTerminalManager: mockGetTerminalManager,
}));

vi.mock('../renderer/composables/useEscProtection.js', () => ({
  useEscProtection: () => ({
    isProtecting: { value: false },
    openProtection: vi.fn(),
    dismissProtection: vi.fn(),
  }),
}));

import { deliverBulkText, parseSubmitSuffix } from '../renderer/paste-handler';
import { createTerminalKeyHandlers } from '../renderer/keyboard/handlers/terminal-keys.js';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../renderer/keyboard/router.js';
import { PANE_ARTIFACTS, PANE_TERMINAL } from '../renderer/dock-types.js';

// ============================================================================
// Tests
// ============================================================================

describe('terminal keys', () => {
  let mockPtyWrite: ReturnType<typeof vi.fn>;
  let getActiveSessionId: ReturnType<typeof vi.fn>;
  let hasPendingQuestion: ReturnType<typeof vi.fn>;
  let clearNotifications: ReturnType<typeof vi.fn>;
  let restoreRequestAnimationFrame: (() => void) | null = null;
  let uninstallRouter: (() => void) | null = null;
  let focusedPane: typeof PANE_TERMINAL | typeof PANE_ARTIFACTS = PANE_TERMINAL;

  /**
   * Registers the real terminal handlers on the shared router.
   *
   * `isModalOpen` reads the DOM here only to stand in for the modal systems the
   * shell consults (`isKeyboardModalOpen`), keeping these tests' existing
   * "a modal is on screen" setup meaningful.
   */
  function installTerminalKeys(): void {
    for (const handler of createTerminalKeyHandlers({
      writePty: (sessionId, data) => { void (window as any).gamepadCli.ptyWrite(sessionId, data); },
      deliverText: (sessionId, text) => deliverBulkText(sessionId, text),
      readClipboardText: () => navigator.clipboard.readText(),
      openPromptEditor: (sessionId) => { void mockShowEditorPopup(sessionId); },
      isEscProtectionArmed: () => false,
      openEscProtection: () => {},
      clearNotifications,
    })) {
      registerKeyHandler(handler);
    }

    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => getActiveSessionId(),
      getFocusedPane: () => focusedPane,
      isPaneVisible: () => true,
      isModalOpen: () => document.querySelector('.modal-overlay.modal--visible') !== null,
    });
  }

  beforeEach(() => {
    mockPtyWrite = vi.fn().mockResolvedValue({ success: true });
    getActiveSessionId = vi.fn().mockReturnValue(null);
    hasPendingQuestion = vi.fn().mockReturnValue(false);
    mockState.sessions = [];
    mockState.cliToolsCache = {};
    mockGetTerminalManager.mockReturnValue(null);
    mockShowEditorPopup.mockReset();
    mockShowEditorPopup.mockResolvedValue('editor text');

    (window as any).gamepadCli = { ptyWrite: mockPtyWrite };

    // Polyfill navigator.clipboard for jsdom
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockResolvedValue('pasted text'), writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    restoreRequestAnimationFrame = () => {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    };

    clearNotifications = vi.fn();
    focusedPane = PANE_TERMINAL;
    resetKeyHandlers();
    installTerminalKeys();
  });

  afterEach(() => {
    uninstallRouter?.();
    uninstallRouter = null;
    resetKeyHandlers();
    restoreRequestAnimationFrame?.();
    restoreRequestAnimationFrame = null;
    vi.restoreAllMocks();
  });

  function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    document.dispatchEvent(e);
    return e;
  }

  // ---------------------------------------------------------------------------
  // Ctrl+V paste
  // ---------------------------------------------------------------------------

  describe('Ctrl+V paste', () => {
    it('writes clipboard text to PTY when terminal is active', async () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(navigator.clipboard.readText).toHaveBeenCalled();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'pasted text');
    });

    // Ownership is by focused pane now: the artifact pane turns a paste into a
    // new artifact, so the terminal must not reduce it to text/plain first.
    it('leaves Ctrl+V to the artifact pane for native image/file paste', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      focusedPane = PANE_ARTIFACTS;
      const panel = document.createElement('div');
      panel.className = 'artifact-panel';
      const button = document.createElement('button');
      panel.appendChild(button);
      document.body.appendChild(panel);

      const e = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
      button.dispatchEvent(e);
      await new Promise(r => setTimeout(r, 10));

      expect(e.defaultPrevented).toBe(false);
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();
      document.body.removeChild(panel);
    });

    it('does nothing when no terminal is active', async () => {
      getActiveSessionId.mockReturnValue(null);

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('does not write empty clipboard text', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      (navigator.clipboard.readText as any).mockResolvedValue('');

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('handles clipboard read failure gracefully', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      (navigator.clipboard.readText as any).mockRejectedValue(new Error('denied'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(warnSpy).toHaveBeenCalledWith('[Keyboard] clipboard read failed:', expect.any(Error));
      expect(mockPtyWrite).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('prevents default on Ctrl+V when terminal is active', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      const e = fireKey('v', { ctrlKey: true });
      expect(e.defaultPrevented).toBe(true);
    });

    it('does not intercept Ctrl+V when an input field has focus', async () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const e = fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(e.defaultPrevented).toBe(false);
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });

    it('does not intercept Ctrl+V when a textarea has focus', async () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      const e = fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(e.defaultPrevented).toBe(false);
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();

      document.body.removeChild(textarea);
    });

    it('still writes clipboard text when a question is pending', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      hasPendingQuestion.mockReturnValue(true);

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'pasted text');
    });

    it('does not relay Ctrl+N as a PTY control character', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('n', { ctrlKey: true });

      expect(mockPtyWrite).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Character relay (simulated typing from OpenWhisper etc.)
  // ---------------------------------------------------------------------------

  describe('character relay', () => {
    it('relays printable characters to PTY', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('a');
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'a');
    });

    it('relays uppercase characters', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('A', { shiftKey: true });
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'A');
    });

    it('relays Enter as carriage return', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('Enter');
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\r');
    });

    it('relays Escape as escape character', async () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('Escape');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x1b');
    });

    it('relays Ctrl+C as control character', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('c', { ctrlKey: true });
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x03');
    });

    it('does nothing when no terminal is active', () => {
      getActiveSessionId.mockReturnValue(null);

      fireKey('a');
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('skips modifier-only keys', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('Control');
      fireKey('Shift');
      fireKey('Alt');
      fireKey('Meta');
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('prevents default on relayed characters', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const e = fireKey('x');
      expect(e.defaultPrevented).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Skip conditions
  // ---------------------------------------------------------------------------

  describe('skip conditions', () => {
    it('skips regular keys when xterm.js element is the target', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const xtermDiv = document.createElement('div');
      xtermDiv.classList.add('xterm');
      document.body.appendChild(xtermDiv);

      const e = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      xtermDiv.dispatchEvent(e);

      expect(mockPtyWrite).not.toHaveBeenCalled();
      document.body.removeChild(xtermDiv);
    });

    it('Ctrl+V paste works even when xterm.js has focus', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      (navigator.clipboard.readText as any).mockResolvedValue('paste from xterm');

      const xtermDiv = document.createElement('div');
      xtermDiv.classList.add('xterm');
      document.body.appendChild(xtermDiv);

      const e = new KeyboardEvent('keydown', {
        key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
      });
      xtermDiv.dispatchEvent(e);
      await new Promise(r => setTimeout(r, 10));

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'paste from xterm');
      document.body.removeChild(xtermDiv);
    });

    it('Ctrl+V paste works when xterm.js hidden textarea has focus', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      (navigator.clipboard.readText as any).mockResolvedValue('paste from xterm textarea');

      const xtermDiv = document.createElement('div');
      xtermDiv.classList.add('xterm');
      const hiddenTextarea = document.createElement('textarea');
      xtermDiv.appendChild(hiddenTextarea);
      document.body.appendChild(xtermDiv);
      hiddenTextarea.focus();

      const e = fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(e.defaultPrevented).toBe(true);
      expect(navigator.clipboard.readText).toHaveBeenCalled();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'paste from xterm textarea');
      document.body.removeChild(xtermDiv);
    });

    it('skips when an input field has focus', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      fireKey('a');
      expect(mockPtyWrite).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });

    it('skips when a textarea has focus', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      fireKey('a');
      expect(mockPtyWrite).not.toHaveBeenCalled();

      document.body.removeChild(textarea);
    });

    it('skips Alt key combos', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('a', { altKey: true });
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('skips Meta key combos', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('a', { metaKey: true });
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Modal overlay guard
  // ---------------------------------------------------------------------------

  describe('modal overlay guard', () => {
    let overlay: HTMLDivElement;

    beforeEach(() => {
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay modal--visible';
      document.body.appendChild(overlay);
    });

    afterEach(() => {
      document.body.removeChild(overlay);
    });

    it('blocks Ctrl+V paste for default PTY mode when a modal overlay is visible', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      mockState.sessions = [{ id: 'sess-1', cliType: 'codex' }];
      navigator.clipboard.readText.mockResolvedValue('hello');

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('does not intercept Ctrl+V when a modal input has focus', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      mockState.sessions = [{ id: 'sess-1', cliType: 'codex' }];
      navigator.clipboard.readText.mockResolvedValue('hello');

      const input = document.createElement('input');
      overlay.appendChild(input);
      input.focus();

      const e = fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(e.defaultPrevented).toBe(false);
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('blocks printable key relay when a modal overlay is visible', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('a');
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('blocks Ctrl+letter relay when a modal overlay is visible', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('c', { ctrlKey: true });
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('blocks named key relay when a modal overlay is visible', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('Enter');
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });

    it('resumes relay when modal overlay is hidden', async () => {
      getActiveSessionId.mockReturnValue('sess-1');
      overlay.classList.remove('modal--visible');

      fireKey('v', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 10));

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'pasted text');
    });
  });

  // ---------------------------------------------------------------------------
  // Ctrl+Shift+B — clear session notifications
  // ---------------------------------------------------------------------------

  describe('Ctrl+Shift+B', () => {
    it('clears notifications for the active session when no modal is active', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('B', { ctrlKey: true, shiftKey: true });

      expect(clearNotifications).toHaveBeenCalledWith('sess-1');
    });

    it('stands down while a modal owns the keyboard', () => {
      getActiveSessionId.mockReturnValue('sess-1');
      const modal = document.createElement('div');
      modal.className = 'modal-overlay modal--visible';
      document.body.appendChild(modal);

      fireKey('B', { ctrlKey: true, shiftKey: true });

      expect(clearNotifications).not.toHaveBeenCalled();
      document.body.removeChild(modal);
    });

    it('does nothing when no session is active', () => {
      getActiveSessionId.mockReturnValue(null);

      fireKey('B', { ctrlKey: true, shiftKey: true });

      expect(clearNotifications).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe('single delivery', () => {
    // Several terminal handlers are registered at once; the router stops at the
    // first that consumes the key, so a character is never written twice.
    it('writes a relayed character to the PTY exactly once', () => {
      getActiveSessionId.mockReturnValue('sess-1');

      fireKey('a');

      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
    });
  });
});

// ============================================================================
// deliverBulkText — paste mode routing
// ============================================================================

describe('deliverBulkText', () => {
  let mockPtyWrite: ReturnType<typeof vi.fn>;
  let restoreRequestAnimationFrame: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPtyWrite = vi.fn();

    (window as any).gamepadCli = {
      ptyWrite: mockPtyWrite,
    };

    // Reset shared mockState between tests
    mockState.sessions = [];
    mockState.cliToolsCache = {};
    mockGetTerminalManager.mockReturnValue(null);

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    restoreRequestAnimationFrame = () => {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreRequestAnimationFrame?.();
    restoreRequestAnimationFrame = null;
    vi.restoreAllMocks();
  });

  it('writes the full text to the PTY in one call', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];

    const promise = deliverBulkText('sess-1', 'hello');
    await promise;

    expect(mockPtyWrite).toHaveBeenCalledOnce();
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello');
  });

  it('marks background PTY writes as programmatic and settles before submitting', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];

    const promise = deliverBulkText('sess-1', 'hello', { deliveryContext: 'background', submitSuffix: '\n' });
    await vi.runAllTimersAsync();
    await promise;

    expect(mockPtyWrite.mock.calls).toEqual([
      ['sess-1', 'hello', { inputOrigin: 'programmatic' }],
      ['sess-1', '\n', { inputOrigin: 'programmatic' }],
    ]);
  });

  // Background delivery used to skip bracketed paste on purpose: it wrote the
  // payload and its submit suffix as a SINGLE write, and a \r tacked onto the
  // end of a paste block does not submit. That combined write is gone — the
  // suffix is now its own write after a settle delay — so the exclusion only
  // survived as a stale constraint, and it cost us the newline protection:
  // an unwrapped multi-line envelope is submitted a line at a time and the
  // recipient keeps only the final fragment.
  it('bracket-pastes background multi-line text so it is not submitted line-by-line', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
    mockGetTerminalManager.mockReturnValue({
      getSession: () => ({
        view: { isBracketedPasteEnabled: () => true },
      }),
    });

    const promise = deliverBulkText('sess-1', 'first\nsecond', { deliveryContext: 'background', submitSuffix: '\r' });
    await vi.runAllTimersAsync();
    await promise;

    expect(mockPtyWrite.mock.calls).toEqual([
      ['sess-1', '\x1b[200~first\nsecond\x1b[201~', { inputOrigin: 'programmatic' }],
      ['sess-1', '\r', { inputOrigin: 'programmatic' }],
    ]);
  });

  it('leaves background text raw when the CLI has not enabled bracketed paste', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
    mockGetTerminalManager.mockReturnValue({
      getSession: () => ({
        view: { isBracketedPasteEnabled: () => false },
      }),
    });

    const promise = deliverBulkText('sess-1', 'first\nsecond', { deliveryContext: 'background', submitSuffix: '\r' });
    await vi.runAllTimersAsync();
    await promise;

    // Markers would be typed out literally by a CLI that never enabled DEC 2004.
    expect(mockPtyWrite.mock.calls[0][1]).toBe('first\nsecond');
  });

  // The root-cause fix for "text lands on the prompt but is never sent": Ink-based
  // TUIs (Copilot CLI) need a beat to ingest a paste before they honour Enter.
  it('waits the settle delay between the text write and the submit suffix', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];

    const promise = deliverBulkText('sess-1', 'hello', { submitSuffix: '\r' });
    await vi.advanceTimersByTimeAsync(0);

    // Text is out; the suffix must still be parked behind the settle delay.
    expect(mockPtyWrite).toHaveBeenCalledOnce();
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello');

    await vi.runAllTimersAsync();
    await promise;

    expect(mockPtyWrite).toHaveBeenCalledTimes(2);
    expect(mockPtyWrite).toHaveBeenNthCalledWith(2, 'sess-1', '\r');
  });

  it('does not delay a submit-only delivery', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];

    await deliverBulkText('sess-1', '', { submitSuffix: '\r' });

    expect(mockPtyWrite).toHaveBeenCalledOnce();
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\r');
  });

  it('no session found — falls back to ptyWrite', async () => {
    // sessions is empty — no match for 'unknown'
    mockState.sessions = [];
    mockState.cliToolsCache = {};

    const promise = deliverBulkText('unknown', 'hello');
    await promise;

    expect(mockPtyWrite).toHaveBeenCalledOnce();
    expect(mockPtyWrite).toHaveBeenCalledWith('unknown', 'hello');
  });

  it('empty text — does nothing', async () => {
    mockState.sessions = [{ id: 'sess-1', cliType: 'copilot' }];

    await deliverBulkText('sess-1', '');

    expect(mockPtyWrite).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Bracketed paste mode
  // ---------------------------------------------------------------------------

  describe('bracketed paste wrapping', () => {
    it('wraps text in bracketed paste markers when terminal has bracketedPasteMode enabled', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? {
          view: { isBracketedPasteEnabled: () => true },
        } : undefined,
      });

      await deliverBulkText('sess-1', 'hello');

      expect(mockPtyWrite).toHaveBeenCalledOnce();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x1b[200~hello\x1b[201~');
    });

    it('sends raw text when bracketedPasteMode is disabled', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? {
          view: { isBracketedPasteEnabled: () => false },
        } : undefined,
      });

      await deliverBulkText('sess-1', 'hello');

      expect(mockPtyWrite).toHaveBeenCalledOnce();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello');
    });

    it('sends raw text when terminal manager is unavailable (fallback)', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue(null);

      await deliverBulkText('sess-1', 'hello');

      expect(mockPtyWrite).toHaveBeenCalledOnce();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello');
    });

    it('sends raw text when session view is not found', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue({
        getSession: () => undefined,
      });

      await deliverBulkText('sess-1', 'hello');

      expect(mockPtyWrite).toHaveBeenCalledOnce();
      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello');
    });

    it('wraps multiline text correctly in brackets', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? {
          view: { isBracketedPasteEnabled: () => true },
        } : undefined,
      });

      await deliverBulkText('sess-1', 'line1\nline2\nline3');

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x1b[200~line1\nline2\nline3\x1b[201~');
    });
  });

  // ---------------------------------------------------------------------------
  // Bracketed paste readiness wait — fixes multi-line selection into a session
  // that has not yet enabled DEC 2004 (e.g. just-spawned "new session with
  // selection"), which otherwise submits line-by-line and drops all but the last.
  // ---------------------------------------------------------------------------

  describe('bracketed paste readiness wait (multi-line)', () => {
    it('waits for bracketed paste to turn on, then wraps multi-line text', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      let enabled = false;
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? {
          view: { isBracketedPasteEnabled: () => enabled },
        } : undefined,
      });

      const promise = deliverBulkText('sess-1', 'line1\nline2');
      // Parked in the readiness wait — nothing delivered yet.
      expect(mockPtyWrite).not.toHaveBeenCalled();

      enabled = true;
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x1b[200~line1\nline2\x1b[201~');
    });

    it('gives up after the budget and delivers multi-line text raw', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? {
          view: { isBracketedPasteEnabled: () => false },
        } : undefined,
      });

      const promise = deliverBulkText('sess-1', 'line1\nline2');
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'line1\nline2');
    });

    it('does not wait for single-line text', async () => {
      mockState.sessions = [{ id: 'sess-1', cliType: 'claude' }];
      const isEnabled = vi.fn().mockReturnValue(false);
      mockGetTerminalManager.mockReturnValue({
        getSession: (id: string) => id === 'sess-1' ? { view: { isBracketedPasteEnabled: isEnabled } } : undefined,
      });

      await deliverBulkText('sess-1', 'single line');

      expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'single line');
      // Only the initial synchronous check — no polling loop for single-line text.
      expect(isEnabled).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // PTY individual mode (char-by-char PTY writes for Ink-based CLIs)
  // ---------------------------------------------------------------------------

  // =========================================================================
  // submitSuffix — Helm inter-session messages auto-execution
  // =========================================================================

  describe('submitSuffix option — auto-execution with bracketed paste', () => {
    let mockTerminalManager: any;

    beforeEach(() => {
      mockTerminalManager = {
        getSession: vi.fn((sessionId: string) => ({
          id: sessionId,
          view: {
            isBracketedPasteEnabled: vi.fn().mockReturnValue(true),
          },
        })),
      };
      mockGetTerminalManager.mockReturnValue(mockTerminalManager);
      mockState.sessions = [{ id: 'helm-test', cliType: 'claude-code' }];
    });

    it('PTY mode: submitSuffix appended OUTSIDE bracketed paste markers', async () => {
      const promise = deliverBulkText('helm-test', 'hello', { submitSuffix: '\n' });
      await vi.runAllTimersAsync();
      await promise;

      // writePtySubmitSuffix sends suffix as a separate ptyWrite call
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite).toHaveBeenNthCalledWith(1, 'helm-test', '\x1b[200~hello\x1b[201~');
      expect(mockPtyWrite).toHaveBeenNthCalledWith(2, 'helm-test', '\n');
    });

    it('PTY mode: withReturn ignored when submitSuffix provided', async () => {
      const promise = deliverBulkText('helm-test', 'test', { withReturn: true, submitSuffix: '\n' });
      await vi.runAllTimersAsync();
      await promise;

      // submitSuffix takes precedence over withReturn; suffix sent as separate call
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite).toHaveBeenNthCalledWith(1, 'helm-test', '\x1b[200~test\x1b[201~');
      expect(mockPtyWrite).toHaveBeenNthCalledWith(2, 'helm-test', '\n');
    });

    it('PTY mode without bracketed paste: submitSuffix still appended', async () => {
      const mockSession = {
        id: 'helm-test',
        view: {
          isBracketedPasteEnabled: vi.fn().mockReturnValue(false),
        },
      };
      mockTerminalManager.getSession.mockReturnValue(mockSession);

      const promise = deliverBulkText('helm-test', 'cmd', { submitSuffix: '\n' });
      await vi.runAllTimersAsync();
      await promise;

      // Text and suffix are separate ptyWrite calls
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite).toHaveBeenNthCalledWith(1, 'helm-test', 'cmd');
      expect(mockPtyWrite).toHaveBeenNthCalledWith(2, 'helm-test', '\n');
    });

    it('PTY mode waits for ptyWrite before resolving', async () => {
      let resolveWrite!: () => void;
      mockPtyWrite.mockReturnValue(new Promise<void>(resolve => {
        resolveWrite = resolve;
      }));

      let resolved = false;
      const promise = deliverBulkText('helm-test', 'cmd', { submitSuffix: '\n' }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      // Both ptyWrite calls share the same mock promise; resolving once unblocks both
      resolveWrite();
      await vi.runAllTimersAsync();
      await promise;

      expect(resolved).toBe(true);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite).toHaveBeenNthCalledWith(1, 'helm-test', '\x1b[200~cmd\x1b[201~');
      expect(mockPtyWrite).toHaveBeenNthCalledWith(2, 'helm-test', '\n');
    });

  });

  // =========================================================================
  // parseSubmitSuffix — sequence syntax support
  // =========================================================================

  describe('parseSubmitSuffix', () => {
    it('undefined — defaults to carriage return', () => {
      expect(parseSubmitSuffix(undefined)).toBe('\r');
    });

    it('empty string — defaults to carriage return', () => {
      expect(parseSubmitSuffix('')).toBe('\r');
    });

    it('escape notation \\r — returns carriage return', () => {
      expect(parseSubmitSuffix('\\r')).toBe('\r');
    });

    it('escape notation \\n — returns line feed', () => {
      expect(parseSubmitSuffix('\\n')).toBe('\n');
    });

    it('escape notation \\t — returns tab', () => {
      expect(parseSubmitSuffix('\\t')).toBe('\t');
    });

    it('escape notation \\r\\n — returns CRLF', () => {
      expect(parseSubmitSuffix('\\r\\n')).toBe('\r\n');
    });

    it('{Enter} — returns carriage return', () => {
      expect(parseSubmitSuffix('{Enter}')).toBe('\r');
    });

    it('{enter} lowercase — returns carriage return', () => {
      expect(parseSubmitSuffix('{enter}')).toBe('\r');
    });

    it('{Send} — returns carriage return (identical to Enter)', () => {
      expect(parseSubmitSuffix('{Send}')).toBe('\r');
    });

    it('{send} lowercase — returns carriage return', () => {
      expect(parseSubmitSuffix('{send}')).toBe('\r');
    });

    it('{F1} — returns F1 escape sequence', () => {
      expect(parseSubmitSuffix('{F1}')).toBe('\x1bOP');
    });

    it('{Tab} — returns tab character', () => {
      expect(parseSubmitSuffix('{Tab}')).toBe('\t');
    });

    it('{Escape} — returns escape character', () => {
      expect(parseSubmitSuffix('{Escape}')).toBe('\x1b');
    });

    it('unrecognized sequence {Unknown} — falls back to keyToPtyEscape', () => {
      // keyToPtyEscape will return 'Unknown' as-is if not recognized
      const result = parseSubmitSuffix('{Unknown}');
      expect(result).toBe('Unknown');
    });

    it('malformed sequence (no closing brace) — returns as-is', () => {
      expect(parseSubmitSuffix('{Enter')).toBe('{Enter');
    });

    it('text without braces — returns as-is', () => {
      expect(parseSubmitSuffix('some text')).toBe('some text');
    });

    it('text with spaces — accepted and returned as-is', () => {
      expect(parseSubmitSuffix('hello world')).toBe('hello world');
    });

    it('{Ctrl+C} — returns Ctrl+C escape sequence', () => {
      const result = parseSubmitSuffix('{Ctrl+C}');
      expect(result).toBe('\x03');
    });

    it('mixed sequence and text {Enter}hello — parses correctly', () => {
      const result = parseSubmitSuffix('{Enter}hello');
      expect(result).toBe('\rhello');
    });

    it('multiple sequences {Enter}{Tab} — parses all', () => {
      const result = parseSubmitSuffix('{Enter}{Tab}');
      expect(result).toBe('\r\t');
    });
  });
});
