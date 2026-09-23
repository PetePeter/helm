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

function makeMockTerminal() {
  return {
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
}

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    Object.assign(this, makeMockTerminal());
    return this;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) { this.fit = vi.fn(); return this; }),
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TerminalManager } from '../renderer/terminal/terminal-manager';

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * Closing a session lands on detachTerminal (doCloseSession → cleanupRendererSession),
 * while a failed spawn / PTY exit lands on destroyTerminal. Both must hand over to the
 * session the user can actually see next, not the oldest terminal in creation order.
 */
describe('TerminalManager successor selection', () => {
  let container: HTMLElement;
  let mgr: TerminalManager;
  let switched: Array<string | null>;
  let emptyCalls: number;

  /** Creates terminals in an order deliberately different from the visible order. */
  async function createTerminals(...ids: string[]): Promise<void> {
    for (const id of ids) await mgr.createTerminal(id, 'claude-code', 'claude');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    container = createContainer();

    (window as any).gamepadCli = {
      ptySpawn: vi.fn().mockResolvedValue({ success: true }),
      ptyWrite: vi.fn(),
      ptyResize: vi.fn(),
      ptyKill: vi.fn(),
      ptyMarkSwitching: vi.fn(),
      onPtyData: vi.fn().mockReturnValue(() => {}),
      onPtyExit: vi.fn().mockReturnValue(() => {}),
    };

    switched = [];
    emptyCalls = 0;
    mgr = new TerminalManager(container);
    mgr.setOnSwitch((id) => switched.push(id));
    mgr.setOnEmpty(() => { emptyCalls++; });
  });

  afterEach(() => {
    mgr.dispose();
    delete (window as any).gamepadCli;
    document.body.innerHTML = '';
  });

  it('detachTerminal switches to the visible neighbour, not the creation-order first', async () => {
    await createTerminals('created-first', 'closing', 'visible-next');
    // Sidebar order puts created-first last — creation order would wrongly pick it
    mgr.setVisibleOrderProvider(() => ['closing', 'visible-next', 'created-first']);
    mgr.switchTo('closing');

    mgr.detachTerminal('closing');

    expect(mgr.getActiveSessionId()).toBe('visible-next');
    expect(emptyCalls).toBe(0);
  });

  it('destroyTerminal switches to the visible neighbour', async () => {
    await createTerminals('created-first', 'closing', 'visible-next');
    mgr.setVisibleOrderProvider(() => ['closing', 'visible-next', 'created-first']);
    mgr.switchTo('closing');

    mgr.destroyTerminal('closing');

    expect(mgr.getActiveSessionId()).toBe('visible-next');
  });

  it('never selects a session hidden in a collapsed group', async () => {
    await createTerminals('collapsed-member', 'closing', 'visible');
    // Collapsed-group members are absent from navList, hence absent here
    mgr.setVisibleOrderProvider(() => ['closing', 'visible']);
    mgr.switchTo('closing');

    mgr.detachTerminal('closing');

    expect(mgr.getActiveSessionId()).toBe('visible');
  });

  it('deselects when terminals remain but none are visible', async () => {
    await createTerminals('collapsed-member', 'closing');
    mgr.setVisibleOrderProvider(() => ['closing']);
    mgr.switchTo('closing');
    switched.length = 0;

    mgr.detachTerminal('closing');

    expect(mgr.getActiveSessionId()).toBeNull();
    expect(switched).toEqual([null]);
    expect(emptyCalls).toBe(0);
    expect(mgr.getCount()).toBe(1); // the collapsed member is still alive
  });

  it('fires onEmpty when the last terminal goes away', async () => {
    await createTerminals('only');
    mgr.setVisibleOrderProvider(() => ['only']);
    mgr.switchTo('only');

    mgr.detachTerminal('only');

    expect(emptyCalls).toBe(1);
    expect(mgr.getActiveSessionId()).toBeNull();
  });

  it('falls back to creation order when no visible-order provider is registered', async () => {
    await createTerminals('created-first', 'closing');
    mgr.switchTo('closing');

    mgr.detachTerminal('closing');

    expect(mgr.getActiveSessionId()).toBe('created-first');
  });
});
