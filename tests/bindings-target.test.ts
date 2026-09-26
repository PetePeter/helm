// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver for jsdom
// ---------------------------------------------------------------------------

class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

// ---------------------------------------------------------------------------
// Shared mock references (declared before vi.mock for closure access)
// ---------------------------------------------------------------------------

const mockTerminalManager = {
  getActiveSessionId: vi.fn().mockReturnValue(null),
};

let mockGetTerminalManager = vi.fn().mockReturnValue(null);

const mockGamepadCli = {
  keyboardComboDown: vi.fn().mockResolvedValue({ success: true }),
  keyboardComboUp: vi.fn().mockResolvedValue({ success: true }),
  keyboardKeyTap: vi.fn().mockResolvedValue({ success: true }),
  keyboardSendKeyCombo: vi.fn().mockResolvedValue({ success: true }),
  ptyWrite: vi.fn().mockResolvedValue({ success: true }),
};

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../renderer/runtime/terminal-provider', () => ({
  getTerminalManager: (...args: any[]) => mockGetTerminalManager(...args),
}));

vi.mock('../renderer/utils', () => ({
  logEvent: vi.fn(),
  showScreen: vi.fn(),
  updateProfileDisplay: vi.fn(),
  getCliDisplayName: vi.fn((ct: string) => ct),
  resolveCliTypeRecord: vi.fn(() => null),
  toDirection: vi.fn(),
  getSequenceSyntaxHelpText: vi.fn().mockReturnValue(''),
}));

vi.mock('../renderer/screens/sessions', () => ({
  loadSessions: vi.fn(),
  spawnNewSession: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    Object.assign(this, {
      loadAddon: vi.fn(), open: vi.fn(), write: vi.fn(), focus: vi.fn(),
      blur: vi.fn(), clear: vi.fn(), dispose: vi.fn(), scrollToBottom: vi.fn(),
      scrollLines: vi.fn(),
      onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onResize: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      cols: 120, rows: 30,
    });
    return this;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    Object.assign(this, { fit: vi.fn() });
    return this;
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function (this: any) { return this; }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function (this: any) {
    Object.assign(this, {
      findNext: vi.fn().mockReturnValue(true),
      findPrevious: vi.fn().mockReturnValue(false),
    });
    return this;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { processConfigBinding, processConfigRelease, releaseAllHeldKeys, initConfigCache } from '../renderer/bindings';
import { state } from '../renderer/state';

// ============================================================================
// Tests
// ============================================================================

describe('binding action routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Release any held keys from previous tests
    releaseAllHeldKeys();
    vi.clearAllMocks();

    // Set up window.gamepadCli mock
    (window as any).gamepadCli = mockGamepadCli;

    // Reset state
    state.activeSessionId = 'session-1';
    state.sessions = [{ id: 'session-1', cliType: 'claude-code', name: 'Test', processId: 123 }];
    state.cliBindingsCache = {};

    // Default: terminal manager returns an active session (embedded terminal)
    mockTerminalManager.getActiveSessionId.mockReturnValue('session-1');
    mockGetTerminalManager.mockReturnValue(mockTerminalManager);
  });

  // -------------------------------------------------------------------------
  // keyboard action → PTY via sequence
  // -------------------------------------------------------------------------

  describe('keyboard binding routes to PTY', () => {
    it('calls ptyWrite when sequence is provided', async () => {
      state.cliBindingsCache['claude-code'] = {
        A: { action: 'keyboard', sequence: '{Enter}' },
      };

      processConfigBinding('A');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('session-1', expect.any(String));
    });

    it('routes multi-character text sequence to PTY', async () => {
      state.cliBindingsCache['claude-code'] = {
        B: { action: 'keyboard', sequence: 'hello' },
      };

      processConfigBinding('B');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('session-1', 'hello');
    });

    it('sends text, Enter, more text as separate PTY calls', async () => {
      state.cliBindingsCache['claude-code'] = {
        B: { action: 'keyboard', sequence: 'hello{Enter}world' },
      };

      processConfigBinding('B');
      await new Promise(r => setTimeout(r, 10));

      // executeSequenceString flushes buffered text before each key action,
      // sends the key escape separately, then flushes remaining text.
      // The explicit {Enter} satisfies the submit requirement, so impliedSubmit is skipped.
      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledTimes(3);
      expect(mockGamepadCli.ptyWrite).toHaveBeenNthCalledWith(1, 'session-1', 'hello');
      expect(mockGamepadCli.ptyWrite).toHaveBeenNthCalledWith(2, 'session-1', '\r');
      expect(mockGamepadCli.ptyWrite).toHaveBeenNthCalledWith(3, 'session-1', 'world');
    });

    it('does not call any voice/OS-level key methods', async () => {
      state.cliBindingsCache['claude-code'] = {
        A: { action: 'keyboard', sequence: '{Escape}' },
      };

      processConfigBinding('A');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardKeyTap).not.toHaveBeenCalled();
      expect(mockGamepadCli.keyboardSendKeyCombo).not.toHaveBeenCalled();
      expect(mockGamepadCli.keyboardComboDown).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // keyboard action requires sequence field
  // -------------------------------------------------------------------------

  describe('keyboard binding requires sequence', () => {
    it('logs warning and does nothing when sequence is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      state.cliBindingsCache['claude-code'] = {
        A: { action: 'keyboard' },
      };

      processConfigBinding('A');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('logs warning when sequence is not a string', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      state.cliBindingsCache['claude-code'] = {
        A: { action: 'keyboard', sequence: 42 },
      };

      processConfigBinding('A');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // voice tap — single key
  // -------------------------------------------------------------------------

  describe('voice tap binding (single key)', () => {
    it('defaults to OS-level robotjs even when terminal is active', async () => {
      state.cliBindingsCache['claude-code'] = {
        X: { action: 'voice', key: 'F1', mode: 'tap' },
      };

      processConfigBinding('X');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardKeyTap).toHaveBeenCalledWith('F1');
      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
    });

    it('routes to PTY when target is terminal', async () => {
      state.cliBindingsCache['claude-code'] = {
        X: { action: 'voice', key: 'F1', mode: 'tap', target: 'terminal' },
      };

      processConfigBinding('X');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('session-1', '\x1bOP');
      expect(mockGamepadCli.keyboardKeyTap).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // voice tap — combo (multiple keys)
  // -------------------------------------------------------------------------

  describe('voice tap binding (combo)', () => {
    it('defaults to OS-level robotjs for multi-key combo', async () => {
      state.cliBindingsCache['claude-code'] = {
        Y: { action: 'voice', key: 'Ctrl+Shift+V', mode: 'tap' },
      };

      processConfigBinding('Y');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardSendKeyCombo).toHaveBeenCalledWith(['Ctrl', 'Shift', 'V']);
      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
    });

    it('routes combo to PTY when target is terminal', async () => {
      state.cliBindingsCache['claude-code'] = {
        Y: { action: 'voice', key: 'Ctrl+Shift+V', mode: 'tap', target: 'terminal' },
      };

      processConfigBinding('Y');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('session-1', expect.any(String));
      expect(mockGamepadCli.keyboardSendKeyCombo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // voice hold — press
  // -------------------------------------------------------------------------

  describe('voice hold binding', () => {
    it('defaults to OS-level keyboardComboDown even with active terminal', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardComboDown).toHaveBeenCalledWith(['Ctrl', 'Alt']);
      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
    });

    it('routes to PTY when target is terminal', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold', target: 'terminal' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('session-1', expect.any(String));
      expect(mockGamepadCli.keyboardComboDown).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // voice hold — release
  // -------------------------------------------------------------------------

  describe('voice hold release', () => {
    it('calls keyboardComboUp for default OS-routed holds', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));
      expect(mockGamepadCli.keyboardComboDown).toHaveBeenCalledWith(['Ctrl', 'Alt']);

      processConfigRelease('RightTrigger');
      expect(mockGamepadCli.keyboardComboUp).toHaveBeenCalledWith(['Ctrl', 'Alt']);
    });

    it('skips keyboardComboUp for PTY-routed holds (target: terminal)', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold', target: 'terminal' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));
      expect(mockGamepadCli.ptyWrite).toHaveBeenCalled();

      processConfigRelease('RightTrigger');
      expect(mockGamepadCli.keyboardComboUp).not.toHaveBeenCalled();
    });

    it('does nothing for buttons that are not held', () => {
      processConfigRelease('A');
      expect(mockGamepadCli.keyboardComboUp).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // releaseAllHeldKeys
  // -------------------------------------------------------------------------

  describe('releaseAllHeldKeys', () => {
    it('releases OS-routed holds via keyboardComboUp', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold' },
        LeftTrigger: { action: 'voice', key: 'Shift+Space', mode: 'hold' },
      };

      processConfigBinding('RightTrigger');
      processConfigBinding('LeftTrigger');
      await new Promise(r => setTimeout(r, 10));

      releaseAllHeldKeys();

      expect(mockGamepadCli.keyboardComboUp).toHaveBeenCalledWith(['Ctrl', 'Alt']);
      expect(mockGamepadCli.keyboardComboUp).toHaveBeenCalledWith(['Shift', 'Space']);
    });

    it('skips keyboardComboUp for PTY-routed holds (target: terminal)', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold', target: 'terminal' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));

      releaseAllHeldKeys();

      expect(mockGamepadCli.keyboardComboUp).not.toHaveBeenCalled();
    });

    it('clears held state so subsequent release is a no-op', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));

      releaseAllHeldKeys();
      vi.clearAllMocks();

      // Second release should do nothing
      releaseAllHeldKeys();
      expect(mockGamepadCli.keyboardComboUp).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // voice target: 'os' override
  // -------------------------------------------------------------------------

  describe('voice target: os override', () => {
    it('forces robotjs even when terminal is active (tap)', async () => {
      state.cliBindingsCache['claude-code'] = {
        X: { action: 'voice', key: 'F1', mode: 'tap', target: 'os' },
      };

      processConfigBinding('X');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardKeyTap).toHaveBeenCalledWith('F1');
      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
    });

    it('forces robotjs even when terminal is active (hold)', async () => {
      state.cliBindingsCache['claude-code'] = {
        RightTrigger: { action: 'voice', key: 'Ctrl+Alt', mode: 'hold', target: 'os' },
      };

      processConfigBinding('RightTrigger');
      await new Promise(r => setTimeout(r, 10));

      expect(mockGamepadCli.keyboardComboDown).toHaveBeenCalledWith(['Ctrl', 'Alt']);
      expect(mockGamepadCli.ptyWrite).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// initConfigCache — cache population
// ============================================================================

describe('initConfigCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cliTypes = ['claude-code', 'copilot-cli'];
    state.cliBindingsCache = {};
    (window as any).gamepadCli = {
      ...mockGamepadCli,
      configGetBindings: vi.fn(),
    };
  });

  it('populates cliBindingsCache for all CLI types', async () => {
    const bindings = { A: { action: 'keyboard', sequence: '{Enter}' } };
    (window as any).gamepadCli.configGetBindings.mockResolvedValue(bindings);

    await initConfigCache();

    expect(state.cliBindingsCache['claude-code']).toEqual(bindings);
    expect(state.cliBindingsCache['copilot-cli']).toEqual(bindings);
  });

  it('overwrites stale cache entries on re-init', async () => {
    state.cliBindingsCache['claude-code'] = { X: { action: 'keyboard', sequence: 'old' } };

    const newBindings = { A: { action: 'keyboard', sequence: 'new' } };
    (window as any).gamepadCli.configGetBindings.mockResolvedValue(newBindings);

    await initConfigCache();

    expect(state.cliBindingsCache['claude-code']).toEqual(newBindings);
  });

  it('drops a tool whose binding profile was unset or deleted', async () => {
    state.cliBindingsCache['claude-code'] = { X: { action: 'keyboard', sequence: 'old' } };
    (window as any).gamepadCli.configGetBindings.mockResolvedValue(null);

    await initConfigCache();

    expect(state.cliBindingsCache['claude-code']).toBeUndefined();
  });

  it('does nothing when window.gamepadCli is unavailable', async () => {
    (window as any).gamepadCli = undefined;

    await initConfigCache();

    expect(state.cliBindingsCache).toEqual({});
  });
});
