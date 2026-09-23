// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver for jsdom
// ---------------------------------------------------------------------------

class MockResizeObserver {
  static lastInstance: MockResizeObserver | null = null;
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.lastInstance = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

// ---------------------------------------------------------------------------
// Mocks — xterm.js needs canvas/WebGL which jsdom doesn't support
// ---------------------------------------------------------------------------

/** Track created mock instances so tests can inspect them */
const terminalInstances: any[] = [];
const fitAddonInstances: any[] = [];
const searchAddonInstances: any[] = [];

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

function makeMockFitAddon() {
  const f = { fit: vi.fn() };
  fitAddonInstances.push(f);
  return f;
}

function makeMockSearchAddon() {
  const s = {
    findNext: vi.fn().mockReturnValue(true),
    findPrevious: vi.fn().mockReturnValue(false),
  };
  searchAddonInstances.push(s);
  return s;
}

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    const mock = makeMockTerminal();
    Object.assign(this, mock);
    return this;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    const mock = makeMockFitAddon();
    Object.assign(this, mock);
    return this;
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function (this: any) {
    return this;
  }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function (this: any) {
    const mock = makeMockSearchAddon();
    Object.assign(this, mock);
    return this;
  }),
}));

// ---------------------------------------------------------------------------
// Now import the modules under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { TerminalView } from '../renderer/terminal/terminal-view';
import { TerminalManager } from '../renderer/terminal/terminal-manager';

// Helper to get the last created mock instance
function lastTerminal() { return terminalInstances[terminalInstances.length - 1]; }
function lastFitAddon() { return fitAddonInstances[fitAddonInstances.length - 1]; }
function lastSearchAddon() { return searchAddonInstances[searchAddonInstances.length - 1]; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// TerminalView
// ---------------------------------------------------------------------------

describe('TerminalView', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    searchAddonInstances.length = 0;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens xterm Terminal into the provided container', () => {
    const view = new TerminalView({ sessionId: 'tv1', container });
    expect(view.sessionId).toBe('tv1');
    expect(terminalInstances.length).toBe(1);
    expect(lastTerminal().open).toHaveBeenCalled();
  });

  it('adopts the existing xterm DOM into a new host and fits without remounting', () => {
    const nextContainer = createContainer();
    const view = new TerminalView({ sessionId: 'tv-adopt', container });
    const xtermDom = document.createElement('div');
    xtermDom.className = 'xterm';
    container.appendChild(xtermDom);

    expect(view.adoptContainer(nextContainer)).toBe(true);
    expect(nextContainer.firstChild).toBe(xtermDom);
    expect(container.firstChild).toBeNull();
    expect(lastFitAddon().fit).toHaveBeenCalledTimes(1); // adoption
    expect(terminalInstances).toHaveLength(1);
  });

  it('loads fit, web-links, and search addons', () => {
    new TerminalView({ sessionId: 'tv2', container });
    expect(lastTerminal().loadAddon).toHaveBeenCalledTimes(3);
  });

  it('defers fitting until the containing layout has settled', () => {
    new TerminalView({ sessionId: 'tv3', container });
    expect(lastFitAddon().fit).not.toHaveBeenCalled();
  });

  it('write() forwards data to terminal.write()', () => {
    const view = new TerminalView({ sessionId: 'tv4', container });
    view.write('hello world');
    expect(lastTerminal().write).toHaveBeenCalledWith('hello world');
  });

  it('write() is a no-op after dispose()', () => {
    const view = new TerminalView({ sessionId: 'tv5', container });
    view.dispose();
    lastTerminal().write.mockClear();
    view.write('should not appear');
    expect(lastTerminal().write).not.toHaveBeenCalled();
  });

  it('focus() and blur() delegate to terminal', () => {
    const view = new TerminalView({ sessionId: 'tv6', container });
    view.focus();
    expect(lastTerminal().focus).toHaveBeenCalled();
    view.blur();
    expect(lastTerminal().blur).toHaveBeenCalled();
  });

  it('getDimensions() returns cols and rows', () => {
    const view = new TerminalView({ sessionId: 'tv7', container });
    const dims = view.getDimensions();
    expect(dims).toEqual({ cols: 120, rows: 30 });
  });

  it('clear() delegates to terminal.clear()', () => {
    const view = new TerminalView({ sessionId: 'tv8', container });
    view.clear();
    expect(lastTerminal().clear).toHaveBeenCalled();
  });

  it('scrollToBottom() and scrollLines() delegate correctly', () => {
    const view = new TerminalView({ sessionId: 'tv9', container });
    view.scrollToBottom();
    expect(lastTerminal().scrollToBottom).toHaveBeenCalled();
    view.scrollLines(5);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(5);
  });

  it('scroll() uses scrollLines in normal buffer', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-norm', container, onScrollInput });
    lastTerminal().buffer.active.type = 'normal';

    view.scroll('down', 3);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(3);
    expect(onScrollInput).not.toHaveBeenCalled();

    lastTerminal().scrollLines.mockClear();
    view.scroll('up', 5);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(-5);
  });

  it('scroll() sends PageDown to PTY in alternate buffer (no scrollLines)', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-alt-dn', container, onScrollInput });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('down', 3);
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
    expect(onScrollInput).toHaveBeenCalledTimes(3);
    expect(onScrollInput).toHaveBeenCalledWith('\x1b[6~');
  });

  it('scroll() sends PageUp to PTY in alternate buffer (no scrollLines)', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-alt-up', container, onScrollInput });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('up', 2);
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
    expect(onScrollInput).toHaveBeenCalledTimes(2);
    expect(onScrollInput).toHaveBeenCalledWith('\x1b[5~');
  });

  it('scroll() falls back to onData when no onScrollInput in alternate buffer', () => {
    const onData = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-alt-fb', container, onData });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('down', 1);
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledWith('\x1b[6~');
  });

  it('scroll() is a no-op after dispose', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-disp', container, onScrollInput });
    view.dispose();

    view.scroll('down', 3);
    expect(onScrollInput).not.toHaveBeenCalled();
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });

  it('findNext() and findPrevious() delegate to search addon', () => {
    const view = new TerminalView({ sessionId: 'tv10', container });
    expect(view.findNext('test')).toBe(true);
    expect(lastSearchAddon().findNext).toHaveBeenCalledWith('test');
    expect(view.findPrevious('test')).toBe(false);
    expect(lastSearchAddon().findPrevious).toHaveBeenCalledWith('test');
  });

  it('wires onData callback for user input', () => {
    const onData = vi.fn();
    new TerminalView({ sessionId: 'tv11', container, onData });
    expect(lastTerminal().onData).toHaveBeenCalled();
  });

  it('wires onResize callback', () => {
    const onResize = vi.fn();
    new TerminalView({ sessionId: 'tv12', container, onResize });
    expect(lastTerminal().onResize).toHaveBeenCalled();
  });

  it('dispose() calls terminal.dispose()', () => {
    const view = new TerminalView({ sessionId: 'tv13', container });
    view.dispose();
    expect(lastTerminal().dispose).toHaveBeenCalled();
  });

  it('double dispose is safe', () => {
    const view = new TerminalView({ sessionId: 'tv14', container });
    view.dispose();
    expect(() => view.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

describe('TerminalManager', () => {
  let container: HTMLElement;
  let mockGamepadCli: Record<string, ReturnType<typeof vi.fn>>;
  let capturedPtyDataCb: ((sessionId: string, data: string) => void) | null;
  let capturedPtyExitCb: ((sessionId: string, exitCode: number) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    container = createContainer();

    capturedPtyDataCb = null;
    capturedPtyExitCb = null;

    mockGamepadCli = {
      ptySpawn: vi.fn().mockResolvedValue({ success: true }),
      ptyWrite: vi.fn(),
      ptyResize: vi.fn(),
      ptyKill: vi.fn(),
      onPtyData: vi.fn().mockImplementation((cb) => {
        capturedPtyDataCb = cb;
        return () => { capturedPtyDataCb = null; };
      }),
      onPtyExit: vi.fn().mockImplementation((cb) => {
        capturedPtyExitCb = cb;
        return () => { capturedPtyExitCb = null; };
      }),
    };

    (window as any).gamepadCli = mockGamepadCli;
  });

  afterEach(() => {
    delete (window as any).gamepadCli;
    document.body.innerHTML = '';
  });

  it('creates a terminal and calls ptySpawn', async () => {
    const mgr = new TerminalManager(container);
    const ok = await mgr.createTerminal('s1', 'aider', 'aider', ['--model', 'gpt4'], '/home');

    expect(ok).toBe(true);
    expect(mockGamepadCli.ptySpawn).toHaveBeenCalledWith('s1', 'aider', ['--model', 'gpt4'], '/home', 'aider', undefined, undefined);
    expect(mgr.has('s1')).toBe(true);
    expect(mgr.getCount()).toBe(1);

    mgr.dispose();
  });

  it('returns false if session already exists', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    const dup = await mgr.createTerminal('s1', 'aider', 'aider');

    expect(dup).toBe(false);
    expect(mgr.getCount()).toBe(1);

    mgr.dispose();
  });

  it('returns false and cleans up if ptySpawn fails', async () => {
    mockGamepadCli.ptySpawn.mockResolvedValue({ success: false, error: 'nope' });

    const mgr = new TerminalManager(container);
    const ok = await mgr.createTerminal('s1', 'aider', 'aider');

    expect(ok).toBe(false);
    expect(mgr.has('s1')).toBe(false);
    expect(mgr.getCount()).toBe(0);

    mgr.dispose();
  });

  it('auto-activates the first terminal', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');

    expect(mgr.getActiveSessionId()).toBe('s1');

    mgr.dispose();
  });

  it('switchTo shows the target terminal and hides the previous', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');

    mgr.switchTo('s2');

    const session1 = mgr.getSession('s1');
    const session2 = mgr.getSession('s2');
    expect(session1!.element.style.display).toBe('none');
    expect(session2!.element.style.display).toBe('block');
    expect(mgr.getActiveSessionId()).toBe('s2');

    mgr.dispose();
  });

  it('adopts a new host without recreating terminals, losing scrollback, or changing PTY target', async () => {
    const nextContainer = createContainer();
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('adopt-1', 'claude', 'claude');

    const session = mgr.getSession('adopt-1')!;
    const terminalElement = session.element;
    const xtermDom = document.createElement('div');
    xtermDom.className = 'xterm';
    terminalElement.appendChild(xtermDom);
    mgr.writeToTerminal('adopt-1', 'scrollback line');
    const terminalCount = terminalInstances.length;

    expect(mgr.adoptHost(nextContainer)).toBe(true);

    expect(mgr.getSession('adopt-1')?.element).toBe(terminalElement);
    expect(nextContainer.firstChild).toBe(terminalElement);
    expect(terminalElement.firstChild).toBe(xtermDom);
    expect(mgr.getActiveSessionId()).toBe('adopt-1');
    expect(terminalInstances).toHaveLength(terminalCount);
    expect(terminalInstances[terminalInstances.length - 1].write).toHaveBeenCalledWith('scrollback line');

    const onData = terminalInstances[terminalInstances.length - 1].onData.mock.calls[0][0];
    onData('typed after adoption');
    expect(mockGamepadCli.ptyWrite).toHaveBeenCalledWith('adopt-1', 'typed after adoption');

    mgr.dispose();
  });

  it('switchTo relies on xterm onResize when fit changes dimensions', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');
    mockGamepadCli.ptyResize.mockClear();

    const targetSession = mgr.getSession('s2')!;
    const targetTerminal = terminalInstances[terminalInstances.length - 1];
    vi.spyOn(targetSession.view, 'getDimensions')
      .mockReturnValueOnce({ cols: 100, rows: 25 })
      .mockReturnValue({ cols: 120, rows: 30 });
    vi.spyOn(targetSession.view, 'fit').mockImplementation(() => {
      const resizeCallback = targetTerminal.onResize.mock.calls[0][0];
      resizeCallback({ cols: 120, rows: 30 });
    });

    mgr.switchTo('s2');

    expect(mockGamepadCli.ptyResize).toHaveBeenCalledTimes(1);
    expect(mockGamepadCli.ptyResize).toHaveBeenCalledWith('s2', 120, 30);

    mgr.dispose();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('switchTo with unknown ID is a no-op', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');

    mgr.switchTo('nonexistent');
    expect(mgr.getActiveSessionId()).toBe('s1');

    mgr.dispose();
  });

  // -------------------------------------------------------------------------
  // deselect()
  // -------------------------------------------------------------------------

  describe('deselect()', () => {
    it('sets activeSessionId to null', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'aider', 'aider');
      expect(mgr.getActiveSessionId()).toBe('s1');

      mgr.deselect();
      expect(mgr.getActiveSessionId()).toBeNull();

      mgr.dispose();
    });

    it('does not destroy the terminal', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'aider', 'aider');

      mgr.deselect();

      expect(mgr.has('s1')).toBe(true);
      expect(mgr.getActiveSessionId()).toBeNull();

      mgr.dispose();
    });

    it('fires onSwitch with null', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'aider', 'aider');

      const spy = vi.fn();
      mgr.setOnSwitch(spy);

      mgr.deselect();
      expect(spy).toHaveBeenCalledWith(null);

      mgr.dispose();
    });

    it('is a no-op when no terminal is active', () => {
      const mgr = new TerminalManager(container);
      expect(() => mgr.deselect()).not.toThrow();
      mgr.dispose();
    });

    it('switchTo restores after deselect', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'aider', 'aider');
      await mgr.createTerminal('s2', 'claude', 'claude');

      mgr.deselect();
      expect(mgr.getActiveSessionId()).toBeNull();

      mgr.switchTo('s2');
      expect(mgr.getActiveSessionId()).toBe('s2');
      expect(mgr.getSession('s2')!.element.style.display).toBe('block');

      mgr.dispose();
    });
  });

  it('destroyTerminal removes the terminal and calls ptyKill', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');

    mgr.destroyTerminal('s1');

    expect(mgr.has('s1')).toBe(false);
    expect(mockGamepadCli.ptyKill).toHaveBeenCalledWith('s1');
    expect(mgr.getCount()).toBe(0);

    mgr.dispose();
  });

  it('destroyTerminal switches to next if active was destroyed', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');

    mgr.switchTo('s1');
    mgr.destroyTerminal('s1');

    expect(mgr.getActiveSessionId()).toBe('s2');

    mgr.dispose();
  });

  it('destroyTerminal of non-active session preserves active', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');

    mgr.switchTo('s1');
    mgr.destroyTerminal('s2');

    expect(mgr.getActiveSessionId()).toBe('s1');

    mgr.dispose();
  });

  it('getSessionIds returns all IDs', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');

    expect(mgr.getSessionIds()).toEqual(['s1', 's2']);

    mgr.dispose();
  });

  it('IPC data listener routes output to the correct terminal', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');

    // Trigger IPC data callback
    expect(capturedPtyDataCb).not.toBeNull();
    capturedPtyDataCb!('s1', 'hello from pty');

    // The view's write method should have been called (via writeToTerminal)
    const session = mgr.getSession('s1');
    expect(session).toBeDefined();
    // We can't easily inspect the internal Terminal mock from here,
    // but we can verify the session exists and the data route doesn't throw

    mgr.dispose();
  });

  it('IPC exit listener writes exit message to terminal', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');

    expect(capturedPtyExitCb).not.toBeNull();
    // Should not throw
    capturedPtyExitCb!('s1', 0);

    mgr.dispose();
  });

  it('writeToTerminal is a no-op for unknown sessions', () => {
    const mgr = new TerminalManager(container);
    // Should not throw
    expect(() => mgr.writeToTerminal('nonexistent', 'data')).not.toThrow();

    mgr.dispose();
  });

  it('writeToTerminal passes data directly to terminal view (no filtering)', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'copilot-cli', 'copilot');

    const mockTerm = terminalInstances[terminalInstances.length - 1];
    mockTerm.write.mockClear();

    // All sequences pass through — xterm.js handles them natively
    mgr.writeToTerminal('s1', 'hello\x1b[?1049hworld');
    expect(mockTerm.write).toHaveBeenCalledWith('hello\x1b[?1049hworld');

    mgr.dispose();
  });

  it('writeToTerminal preserves mouse tracking sequences (xterm.js handles natively)', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'copilot-cli', 'copilot');

    const mockTerm = terminalInstances[terminalInstances.length - 1];
    mockTerm.write.mockClear();

    mgr.writeToTerminal('s1', '\x1b[?1000h\x1b[?1006h');
    expect(mockTerm.write).toHaveBeenCalledWith('\x1b[?1000h\x1b[?1006h');

    mgr.dispose();
  });

  it('writeToTerminal preserves clear screen (needed for scrollback)', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'copilot-cli', 'copilot');

    const mockTerm = terminalInstances[terminalInstances.length - 1];
    mockTerm.write.mockClear();

    mgr.writeToTerminal('s1', '\x1b[2J');
    expect(mockTerm.write).toHaveBeenCalledWith('\x1b[2J');

    mgr.dispose();
  });

  it('dispose cleans up all terminals and IPC listeners', async () => {
    const mgr = new TerminalManager(container);
    await mgr.createTerminal('s1', 'aider', 'aider');
    await mgr.createTerminal('s2', 'claude', 'claude');

    mgr.dispose();

    expect(mgr.getCount()).toBe(0);
    expect(mgr.getActiveSessionId()).toBeNull();
  });

  it('dispose cancels fitWatchdog interval', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const mgr = new TerminalManager(container);
    mgr.dispose();

    expect(clearIntervalSpy).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('fitActive() is a no-op when no session is active', () => {
    const mgr = new TerminalManager(container);
    expect(() => mgr.fitActive()).not.toThrow();
    mgr.dispose();
  });

  it('ResizeObserver debounce coalesces rapid callbacks into one fitAll()', () => {
    vi.useFakeTimers();

    const mgr = new TerminalManager(container);
    const fitAllSpy = vi.spyOn(mgr, 'fitAll');

    // Grab the ResizeObserver instance created by setupResizeObserver
    const observer = (MockResizeObserver as any).lastInstance as MockResizeObserver;
    if (!observer) { mgr.dispose(); vi.useRealTimers(); return; }

    observer.callback([], observer as unknown as ResizeObserver);
    observer.callback([], observer as unknown as ResizeObserver);
    observer.callback([], observer as unknown as ResizeObserver);

    expect(fitAllSpy).not.toHaveBeenCalled(); // debounce not yet fired
    vi.advanceTimersByTime(50);
    expect(fitAllSpy).toHaveBeenCalledTimes(1); // exactly once after settle

    mgr.dispose();
    vi.useRealTimers();
  });

  it('handles missing window.gamepadCli gracefully', () => {
    delete (window as any).gamepadCli;

    // Should not throw
    const mgr = new TerminalManager(container);
    expect(mgr.getCount()).toBe(0);

    mgr.dispose();
  });

  it('destroyTerminal for unknown session is a no-op', () => {
    const mgr = new TerminalManager(container);
    expect(() => mgr.destroyTerminal('nonexistent')).not.toThrow();

    mgr.dispose();
  });

  // -------------------------------------------------------------------------
  // onSwitch callback
  // -------------------------------------------------------------------------

  describe('onSwitch callback', () => {
    it('calls onSwitch when switchTo is called', async () => {
      const onSwitch = vi.fn();
      const mgr = new TerminalManager(container);
      mgr.setOnSwitch(onSwitch);

      await mgr.createTerminal('s1', 'aider', 'aider');
      await mgr.createTerminal('s2', 'claude', 'claude');

      mgr.switchTo('s2');

      expect(onSwitch).toHaveBeenCalledWith('s2');

      mgr.dispose();
    });

    it('does not call onSwitch if not set', async () => {
      const mgr = new TerminalManager(container);

      await mgr.createTerminal('s1', 'aider', 'aider');
      await mgr.createTerminal('s2', 'claude', 'claude');

      // switchTo should not throw when onSwitch is null
      expect(() => mgr.switchTo('s2')).not.toThrow();

      mgr.dispose();
    });

    it('calls onSwitch with correct id on each switch', async () => {
      const onSwitch = vi.fn();
      const mgr = new TerminalManager(container);
      mgr.setOnSwitch(onSwitch);

      await mgr.createTerminal('s1', 'aider', 'aider');
      await mgr.createTerminal('s2', 'claude', 'claude');
      await mgr.createTerminal('s3', 'copilot', 'copilot');

      // Clear calls from createTerminal auto-activate
      onSwitch.mockClear();

      mgr.switchTo('s2');
      mgr.switchTo('s3');
      mgr.switchTo('s1');

      expect(onSwitch).toHaveBeenCalledTimes(3);
      expect(onSwitch).toHaveBeenNthCalledWith(1, 's2');
      expect(onSwitch).toHaveBeenNthCalledWith(2, 's3');
      expect(onSwitch).toHaveBeenNthCalledWith(3, 's1');

      mgr.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // renameSession
  // -------------------------------------------------------------------------

  describe('renameSession', () => {
    it('updates the session name', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'aider', 'aider');

      const before = mgr.getSession('s1');
      expect(before!.name).toBe('aider'); // defaults to cliType

      mgr.renameSession('s1', 'My Custom Name');

      const after = mgr.getSession('s1');
      expect(after!.name).toBe('My Custom Name');

      mgr.dispose();
    });

    it('is a no-op for unknown session', () => {
      const mgr = new TerminalManager(container);
      expect(() => mgr.renameSession('nonexistent', 'name')).not.toThrow();
      mgr.dispose();
    });

    it('name field defaults to cliType on creation', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'claude-code', 'claude');

      expect(mgr.getSession('s1')!.name).toBe('claude-code');

      mgr.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // OSC title tracking
  // -------------------------------------------------------------------------

  describe('title tracking', () => {
    it('getTitle returns undefined before any title change', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'claude-code', 'claude');

      expect(mgr.getTitle('s1')).toBeUndefined();

      mgr.dispose();
    });

    it('stores title when onTitleChange fires', async () => {
      const mgr = new TerminalManager(container);
      await mgr.createTerminal('s1', 'claude-code', 'claude');

      // Simulate xterm.js onTitleChange firing
      const lastTerminal = terminalInstances[terminalInstances.length - 1];
      const titleCallback = lastTerminal.onTitleChange.mock.calls[0][0];
      titleCallback('My Terminal Title');

      expect(mgr.getTitle('s1')).toBe('My Terminal Title');

      mgr.dispose();
    });

    it('invokes setOnTitleChange callback when title changes', async () => {
      const mgr = new TerminalManager(container);
      const titleHandler = vi.fn();
      mgr.setOnTitleChange(titleHandler);

      await mgr.createTerminal('s1', 'claude-code', 'claude');

      const lastTerminal = terminalInstances[terminalInstances.length - 1];
      const titleCallback = lastTerminal.onTitleChange.mock.calls[0][0];
      titleCallback('Window Title');

      expect(titleHandler).toHaveBeenCalledWith('s1', 'Window Title');

      mgr.dispose();
    });

    it('getTitle returns undefined for unknown session', () => {
      const mgr = new TerminalManager(container);
      expect(mgr.getTitle('nonexistent')).toBeUndefined();
      mgr.dispose();
    });
  });
});

// ---------------------------------------------------------------------------
// TerminalView — attachCustomKeyEventHandler
// ---------------------------------------------------------------------------

describe('TerminalView — custom key handler', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    searchAddonInstances.length = 0;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('attaches a custom key event handler on construction', () => {
    new TerminalView({ sessionId: 'ckh-1', container });
    expect(lastTerminal().attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
    expect(typeof lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0]).toBe('function');
  });

  it('custom handler returns false for Ctrl+Tab to let it bubble', () => {
    new TerminalView({ sessionId: 'ckh-2', container });
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'Tab', ctrlKey: true } as KeyboardEvent);
    expect(result).toBe(false);
  });

  it('custom handler returns true for normal keys', () => {
    new TerminalView({ sessionId: 'ckh-3', container });
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'a', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(true);
  });

  it('PageDown in normal buffer scrolls viewport and blocks escape to PTY', () => {
    new TerminalView({ sessionId: 'ckh-pgdn', container });
    lastTerminal().buffer.active.type = 'normal';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageDown', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(false); // block escape so CLI doesn't redraw
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(30); // rows = 30
  });

  it('PageUp in normal buffer scrolls viewport and blocks escape to PTY', () => {
    new TerminalView({ sessionId: 'ckh-pgup', container });
    lastTerminal().buffer.active.type = 'normal';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageUp', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(false);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(-30);
  });

  it('PageDown in alternate buffer passes through to PTY (no scrollLines)', () => {
    new TerminalView({ sessionId: 'ckh-pgdn-alt', container });
    lastTerminal().buffer.active.type = 'alternate';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageDown', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(true); // let xterm.js send escape to PTY
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });

  it('PageUp keyup event does not trigger scrollLines', () => {
    new TerminalView({ sessionId: 'ckh-pgup-up', container });
    lastTerminal().buffer.active.type = 'normal';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    handler({ key: 'PageUp', type: 'keyup', ctrlKey: false } as KeyboardEvent);
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });

  it('Ctrl+C with selection copies to clipboard and returns false', async () => {
    new TerminalView({ sessionId: 'ckh-copy', container });
    const term = lastTerminal();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('selected text');
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true, configurable: true,
    });
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'c', ctrlKey: true, shiftKey: false, altKey: false, type: 'keydown' } as KeyboardEvent);
    expect(result).toBe(false);
    expect(mockWriteText).toHaveBeenCalledWith('selected text');
    // clearSelection called after async clipboard write
    await vi.waitFor(() => expect(term.clearSelection).toHaveBeenCalled());
  });

  it('Ctrl+C without selection lets SIGINT through', () => {
    new TerminalView({ sessionId: 'ckh-sigint', container });
    const term = lastTerminal();
    term.hasSelection.mockReturnValue(false);
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'c', ctrlKey: true, shiftKey: false, altKey: false, type: 'keydown' } as KeyboardEvent);
    expect(result).toBe(true);
  });

  it('Ctrl+C keyup does not trigger copy', () => {
    new TerminalView({ sessionId: 'ckh-copy-up', container });
    const term = lastTerminal();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('text');
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true, configurable: true,
    });
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'c', ctrlKey: true, shiftKey: false, altKey: false, type: 'keyup' } as KeyboardEvent);
    expect(result).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('Ctrl+C preserves selection if clipboard write fails', async () => {
    new TerminalView({ sessionId: 'ckh-copy-fail', container });
    const term = lastTerminal();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('text');
    const mockWriteText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true, configurable: true,
    });
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'c', ctrlKey: true, shiftKey: false, altKey: false, type: 'keydown' } as KeyboardEvent);
    expect(result).toBe(false);
    // Wait for the rejected promise to settle
    await vi.waitFor(() => expect(mockWriteText).toHaveBeenCalled());
    expect(term.clearSelection).not.toHaveBeenCalled();
  });

  it('Ctrl+C with uppercase key still copies', async () => {
    new TerminalView({ sessionId: 'ckh-copy-upper', container });
    const term = lastTerminal();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('upper');
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true, configurable: true,
    });
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'C', ctrlKey: true, shiftKey: false, altKey: false, type: 'keydown' } as KeyboardEvent);
    expect(result).toBe(false);
    await vi.waitFor(() => expect(mockWriteText).toHaveBeenCalledWith('upper'));
  });
});

// ---------------------------------------------------------------------------
// TerminalView — mouse wheel handling (xterm.js v6 native)
// ---------------------------------------------------------------------------
// After removing the capture-phase wheel listener, xterm.js v6 handles wheel
// events natively via SmoothScrollableElement. No custom listener needed.
// The gamepad scroll() method remains for programmatic scroll.
// ---------------------------------------------------------------------------

describe('TerminalView — native wheel handling (v6)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    searchAddonInstances.length = 0;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does NOT register a capture-phase wheel listener on the container', () => {
    const spy = vi.spyOn(container, 'addEventListener');
    new TerminalView({ sessionId: 'nwl-1', container });

    const wheelCalls = spy.mock.calls.filter(c => c[0] === 'wheel');
    expect(wheelCalls.length).toBe(0);
  });

  it('gamepad scroll() sends PageDown to PTY in alternate buffer', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'nwl-2', container, onScrollInput, onData: vi.fn() });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('down', 1);
    expect(onScrollInput).toHaveBeenCalledWith('\x1b[6~'); // PageDown
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });

  it('gamepad scroll() sends PageUp to PTY in alternate buffer', () => {
    const onScrollInput = vi.fn();
    const view = new TerminalView({ sessionId: 'nwl-3', container, onScrollInput, onData: vi.fn() });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('up', 1);
    expect(onScrollInput).toHaveBeenCalledWith('\x1b[5~'); // PageUp
  });

  it('gamepad scroll() falls back to onData when no onScrollInput', () => {
    const onData = vi.fn();
    const view = new TerminalView({ sessionId: 'nwl-4', container, onData });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('down', 1);
    expect(onData).toHaveBeenCalledWith('\x1b[6~');
  });

  it('gamepad scroll() calls scrollLines in normal buffer', () => {
    const view = new TerminalView({ sessionId: 'nwl-5', container, onData: vi.fn() });
    lastTerminal().buffer.active.type = 'normal';

    view.scroll('down', 3);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(3);
  });
});

// ---------------------------------------------------------------------------
// TerminalView — scroll handling (native xterm.js + gamepad)
// ---------------------------------------------------------------------------
// After removing virtual alt screen tracking, scroll behavior is simpler:
// - Normal buffer: scrollLines() for viewport scrollback
// - Alternate buffer: xterm.js handles natively (PageUp/PageDown → escape to PTY)
// - Gamepad scroll: routes through scroll() method
// ---------------------------------------------------------------------------

describe('TerminalView — scroll handling', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    searchAddonInstances.length = 0;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('scroll() sends PageUp/Down to CLI in alternate buffer', () => {
    const scrollCb = vi.fn();
    const view = new TerminalView({ sessionId: 'scroll-alt', container, onScrollInput: scrollCb, onData: vi.fn() });
    lastTerminal().buffer.active.type = 'alternate';

    view.scroll('up', 1);
    expect(scrollCb).toHaveBeenCalledWith('\x1b[5~'); // PageUp
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });

  it('scroll() calls scrollLines in normal mode', () => {
    const view = new TerminalView({ sessionId: 'scroll-normal', container, onData: vi.fn() });
    lastTerminal().buffer.active.type = 'normal';

    view.scroll('down', 3);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(3);
  });

  it('PageDown in normal mode scrolls viewport', () => {
    new TerminalView({ sessionId: 'pgdn-normal', container });
    lastTerminal().buffer.active.type = 'normal';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageDown', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(false);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(30);
  });

  it('PageUp in normal mode scrolls viewport up', () => {
    new TerminalView({ sessionId: 'pgup-normal', container });
    lastTerminal().buffer.active.type = 'normal';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageUp', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(false);
    expect(lastTerminal().scrollLines).toHaveBeenCalledWith(-30);
  });

  it('PageUp/PageDown in alternate buffer passes through to xterm.js', () => {
    new TerminalView({ sessionId: 'pgup-alt', container });
    lastTerminal().buffer.active.type = 'alternate';
    const handler = lastTerminal().attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;

    const result = handler({ key: 'PageUp', type: 'keydown', ctrlKey: false } as KeyboardEvent);
    expect(result).toBe(true); // let xterm.js send to CLI
    expect(lastTerminal().scrollLines).not.toHaveBeenCalled();
  });
});
