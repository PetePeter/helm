// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver
// ---------------------------------------------------------------------------

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

// ---------------------------------------------------------------------------
// Mocks — xterm.js DOM surface
// ---------------------------------------------------------------------------

const terminalInstances: any[] = [];

function makeMockTerminal() {
  const t = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollLines: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false),
    getSelection: vi.fn().mockReturnValue(''),
    clearSelection: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    attachCustomWheelEventHandler: vi.fn(),
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onResize: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onTitleChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, length: 30, getLine: vi.fn() } },
    cols: 120,
    rows: 30,
    options: {},
    parser: { registerCsiHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
  };
  terminalInstances.push(t);
  return t;
}

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    Object.assign(this, makeMockTerminal());
    return this;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    this.fit = vi.fn();
    return this;
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function (this: any) { return this; }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function (this: any) {
    this.findNext = vi.fn().mockReturnValue(true);
    this.findPrevious = vi.fn().mockReturnValue(false);
    return this;
  }),
}));

vi.mock('../renderer/session-store.js', () => ({
  loadStoredSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../renderer/modals/context-menu.js', () => ({
  showContextMenu: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TerminalManager } from '../renderer/terminal/terminal-manager';
import { PtyOutputBuffer } from '../renderer/terminal/pty-output-buffer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function makeGamepadCli() {
  return {
    ptySpawn: vi.fn().mockResolvedValue({ success: true }),
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    ptyKill: vi.fn(),
    ptyMarkSwitching: vi.fn(),
    onPtyData: vi.fn().mockImplementation((cb: any) => () => {}),
    onPtyExit: vi.fn().mockImplementation((cb: any) => () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalManager.ensureTerminal', () => {
  let container: HTMLElement;
  let mgr: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    document.body.innerHTML = '';
    container = createContainer();
    (window as any).gamepadCli = makeGamepadCli();
    mgr = new TerminalManager(container);
  });

  afterEach(() => {
    mgr.dispose();
    delete (window as any).gamepadCli;
    document.body.innerHTML = '';
  });

  it('is idempotent — calling twice creates exactly one view', () => {
    mgr.hydrateSessions([{ id: 'sess-1', name: 'claude', cliType: 'claude-code', processId: 0 }]);

    mgr.ensureTerminal('sess-1');
    mgr.ensureTerminal('sess-1');

    expect(mgr.getCount()).toBe(1);
    expect(terminalInstances.length).toBe(1);
  });

  it('is a safe no-op for unknown session (not in managedSessions)', () => {
    mgr.ensureTerminal('ghost-id');

    expect(mgr.getCount()).toBe(0);
    expect(mgr.hasTerminal('ghost-id')).toBe(false);
  });

  it('creates a view for a known session with no xterm view yet', () => {
    mgr.hydrateSessions([{ id: 'sess-2', name: 'aider', cliType: 'aider', processId: 0, workingDir: '/tmp' }]);
    expect(mgr.hasTerminal('sess-2')).toBe(false);

    mgr.ensureTerminal('sess-2');

    expect(mgr.hasTerminal('sess-2')).toBe(true);
    expect(mgr.getCount()).toBe(1);
  });

  it('replays PtyOutputBuffer scrollback into the new view', () => {
    mgr.hydrateSessions([{ id: 'sess-3', name: 'claude', cliType: 'claude-code', processId: 0 }]);

    // Simulate PTY output that arrived before the view existed
    const buf = mgr.getOutputBuffer();
    buf.append('sess-3', 'line one\nline two\nline three\n');

    mgr.ensureTerminal('sess-3');

    const t = terminalInstances[terminalInstances.length - 1];
    expect(t.write).toHaveBeenCalledWith('line one\nline two\nline three');
  });

  it('no replay write when buffer is empty', () => {
    mgr.hydrateSessions([{ id: 'sess-4', name: 'claude', cliType: 'claude-code', processId: 0 }]);

    mgr.ensureTerminal('sess-4');

    const t = terminalInstances[terminalInstances.length - 1];
    expect(t.write).not.toHaveBeenCalled();
  });

  it('is a no-op for a session already adopted via adoptTerminal', () => {
    mgr.hydrateSessions([{ id: 'sess-5', name: 'claude', cliType: 'claude-code', processId: 0 }]);
    mgr.adoptTerminal('sess-5', 'claude-code');
    const countAfterAdopt = terminalInstances.length;

    mgr.ensureTerminal('sess-5');

    expect(terminalInstances.length).toBe(countAfterAdopt);
    expect(mgr.getCount()).toBe(1);
  });

  it('Group Overview PtyOutputBuffer reads are unaffected', () => {
    const buf = mgr.getOutputBuffer();
    buf.append('sess-6', 'hello\nworld\n');

    const lines = buf.getLastLines('sess-6', 10);
    expect(lines).toEqual(['hello', 'world']);
  });
});
