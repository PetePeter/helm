// @vitest-environment jsdom

/**
 * TerminalManager merges each persisted session record over the copy it already
 * holds. That merge is why unlocking used to be invisible: the persisted record
 * expressed "unlocked" by omitting `locked`, and an absent key cannot overwrite
 * a cached `locked: true`.
 *
 * These lock the merge behaviour from the consumer's side — whatever the store
 * says about a session's lock is what the renderer must see.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    Object.assign(this, {
      loadAddon: vi.fn(), open: vi.fn(), write: vi.fn(), focus: vi.fn(), blur: vi.fn(),
      dispose: vi.fn(), scrollToBottom: vi.fn(), attachCustomKeyEventHandler: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
      onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onResize: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onTitleChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, length: 30, getLine: vi.fn() } },
      cols: 120, rows: 30, options: {}, parser: { registerCsiHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
    });
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
  SearchAddon: vi.fn(function (this: any) { return this; }),
}));
vi.mock('../renderer/session-store.js', () => ({
  loadStoredSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../renderer/modals/context-menu.js', () => ({
  showContextMenu: vi.fn(),
}));

import { TerminalManager } from '../renderer/terminal/terminal-manager';

const LOCKED = { id: 'sess-1', name: 'copilot', cliType: 'copilot-cli', processId: 0, locked: true };

describe('TerminalManager lock hydration', () => {
  let container: HTMLElement;
  let mgr: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    (window as any).gamepadCli = {
      ptySpawn: vi.fn().mockResolvedValue({ success: true }),
      ptyWrite: vi.fn(), ptyResize: vi.fn(), ptyKill: vi.fn(), ptyMarkSwitching: vi.fn(),
      onPtyData: vi.fn().mockImplementation(() => () => {}),
      onPtyExit: vi.fn().mockImplementation(() => () => {}),
    };
    mgr = new TerminalManager(container);
  });

  afterEach(() => {
    mgr.dispose();
    delete (window as any).gamepadCli;
    document.body.innerHTML = '';
  });

  function lockOf(sessionId: string): boolean | undefined {
    return mgr.getManagedSessions().find(s => s.id === sessionId)?.locked;
  }

  it('clears a cached lock when the store reports the session unlocked', () => {
    mgr.hydrateSessions([LOCKED]);
    expect(lockOf('sess-1')).toBe(true);

    mgr.hydrateSessions([{ ...LOCKED, locked: false }]);

    expect(lockOf('sess-1')).toBe(false);
  });

  it('applies a lock taken while the record was already cached', () => {
    mgr.hydrateSessions([{ ...LOCKED, locked: false }]);

    mgr.hydrateSessions([LOCKED]);

    expect(lockOf('sess-1')).toBe(true);
  });

  it('keeps the lock visible on a session that owns a live terminal', () => {
    mgr.hydrateSessions([LOCKED]);
    mgr.adoptTerminal('sess-1', 'copilot-cli');

    expect(lockOf('sess-1')).toBe(true);

    mgr.hydrateSessions([{ ...LOCKED, locked: false }]);

    expect(lockOf('sess-1')).toBe(false);
  });
});
