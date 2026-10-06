/**
 * Tests for session:close IPC handler routing through PtyManager.
 *
 * Verifies that session:close uses ptyManager.kill() instead of
 * raw process.kill(), preventing stale PTY entries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron ipcMain before importing handler
const electronMockState = vi.hoisted(() => {
  const handlers = new Map<string, Function>();
  const browserWindowInstances: Array<any> = [];
  const BrowserWindowMock = vi.fn(function BrowserWindow(this: any, options: Record<string, unknown>) {
    this.id = browserWindowInstances.length + 101;
    this.options = options;
    this.loadFile = vi.fn();
    this.on = vi.fn();
    this.webContents = { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    this.close = vi.fn();
    this.isDestroyed = vi.fn(() => false);
    this.isMaximized = vi.fn(() => false);
    this.getBounds = vi.fn(() => ({ width: 800, height: 600, x: 10, y: 20 }));
    browserWindowInstances.push(this);
  });
  return { handlers, browserWindowInstances, BrowserWindowMock };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      electronMockState.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: electronMockState.BrowserWindowMock,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupSessionHandlers } from '../src/electron/ipc/session-handlers.js';
import type { SessionManager } from '../src/session/manager.js';
import type { PtyManager } from '../src/session/pty-manager.js';
import type { DraftManager } from '../src/session/draft-manager.js';
import type { WindowManager } from '../src/electron/window-manager.js';
import type { ConfigLoader } from '../src/config/loader.js';

function createMockSessionManager(sessions: Record<string, any> = {}): SessionManager {
   return {
    getSession: vi.fn((id: string) => sessions[id] ?? null),
    removeSession: vi.fn(),
    getAllSessions: vi.fn(() => Object.values(sessions)),
    setActiveSession: vi.fn(),
    getActiveSession: vi.fn(),
    renameSession: vi.fn(),
    hasSession: vi.fn((id: string) => id in sessions),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function createMockPtyManager(): PtyManager {
  return {
    kill: vi.fn(),
    has: vi.fn(),
    write: vi.fn(),
    spawn: vi.fn(),
    killAll: vi.fn(),
  } as unknown as PtyManager;
}

function createMockDraftManager(): DraftManager {
  return {
    clearSession: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getSessionDrafts: vi.fn(() => []),
    exportAll: vi.fn(() => ({})),
    importAll: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as DraftManager;
}

function createMockWindowManager(): WindowManager {
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  return {
    getMainWindow: vi.fn(() => mainWindow),
    getWindowIdForSession: vi.fn(() => undefined),
    getWindow: vi.fn(() => undefined),
    unassignSession: vi.fn(),
    unregisterWindow: vi.fn(),
    registerWindow: vi.fn(),
    assignSessionToWindow: vi.fn(),
    isSessionSnappedOut: vi.fn(() => false),
    focusWindowForSession: vi.fn(() => true),
  } as unknown as WindowManager;
}

function createMockConfigLoader(): ConfigLoader {
  return {
    getSnapOutWindowPrefs: vi.fn(() => null),
    setSnapOutWindowPrefs: vi.fn(),
  } as unknown as ConfigLoader;
}

describe('session:close IPC handler', () => {
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let ptyManager: ReturnType<typeof createMockPtyManager>;
  let draftManager: ReturnType<typeof createMockDraftManager>;
  let windowManager: ReturnType<typeof createMockWindowManager>;
  let configLoader: ReturnType<typeof createMockConfigLoader>;
  let mainWindowSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    electronMockState.handlers.clear();
    electronMockState.browserWindowInstances.length = 0;
    electronMockState.BrowserWindowMock.mockClear();
  });

  function setup(sessions: Record<string, any> = {}) {
    sessionManager = createMockSessionManager(sessions);
    ptyManager = createMockPtyManager();
    draftManager = createMockDraftManager();
    windowManager = createMockWindowManager();
    mainWindowSend = (windowManager.getMainWindow as any)().webContents.send;
    configLoader = createMockConfigLoader();
    setupSessionHandlers(sessionManager, ptyManager, draftManager, windowManager, configLoader);
  }

  it('calls ptyManager.kill() with session id', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999 },
    });

    const handler = electronMockState.handlers.get('session:close')!;
    const result = await handler({}, 'sess-1');

    expect(ptyManager.kill).toHaveBeenCalledWith('sess-1');
    expect(draftManager.clearSession).toHaveBeenCalledWith('sess-1');
    expect(result).toEqual({ success: true });
  });

  it('still removes session via sessionManager even if ptyManager.kill throws', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999 },
    });

    (ptyManager.kill as any).mockImplementation(() => {
      throw new Error('PTY already dead');
    });

    const handler = electronMockState.handlers.get('session:close')!;
    const result = await handler({}, 'sess-1');

    expect(ptyManager.kill).toHaveBeenCalledWith('sess-1');
    expect(sessionManager.removeSession).toHaveBeenCalledWith('sess-1');
    expect(draftManager.clearSession).toHaveBeenCalledWith('sess-1');
    expect(result).toEqual({ success: true });
  });

  it('returns error when session not found', async () => {
    setup(); // no sessions

    const handler = electronMockState.handlers.get('session:close')!;
    const result = await handler({}, 'nonexistent');

    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Session not found' });
  });

  it('focuses the owning window when session:setActive is called', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999 },
    });

    const handler = electronMockState.handlers.get('session:setActive')!;
    await handler({}, 'sess-1');

    expect(sessionManager.setActiveSession).toHaveBeenCalledWith('sess-1');
    expect(windowManager.focusWindowForSession).toHaveBeenCalledWith('sess-1');
  });

  it('forwards a popped-out context-menu action to the focused main window', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999 },
    });

    const action = { id: 'drafts', targetSessionId: 'sess-1', selectedText: '' };
    const handler = electronMockState.handlers.get('session:dispatchContextMenuAction')!;
    const result = await handler({}, action);

    expect(result).toEqual({ success: true });
    expect((windowManager.getMainWindow as any)().focus).toHaveBeenCalledOnce();
    expect(mainWindowSend).toHaveBeenCalledWith('session:contextMenuAction', action);
  });

  it('rejects context-menu actions with missing targets or unknown sessions', async () => {
    setup();
    const handler = electronMockState.handlers.get('session:dispatchContextMenuAction')!;

    expect(handler({}, { id: 'drafts', targetSessionId: null, selectedText: '' }))
      .toEqual({ success: false, error: 'Context-menu action requires a target session' });
    expect(handler({}, { id: 'drafts', targetSessionId: 'missing', selectedText: '' }))
      .toEqual({ success: false, error: 'Session not found' });
    expect(mainWindowSend).not.toHaveBeenCalled();
  });

  it('creates snap-out windows without parenting them to the main window', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999, workingDir: 'C:\\work\\demo-app' },
    });

    const handler = electronMockState.handlers.get('session:snapOut')!;
    const result = await handler({}, 'sess-1');

    expect(result).toEqual({ success: true, windowId: 101 });
    expect(electronMockState.BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(electronMockState.browserWindowInstances[0]?.options).not.toHaveProperty('parent');
    expect(electronMockState.browserWindowInstances[0]?.options?.title).toBe('Test - claude-code - demo-app');
    expect(windowManager.assignSessionToWindow).toHaveBeenCalledWith('sess-1', 101);
  });

  it('updates snapped-out window title and notifies its renderer on rename', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999, workingDir: 'C:\\work\\demo-app', windowId: 101 },
    });
    const updatedSession = { id: 'sess-1', name: 'Renamed', cliType: 'claude-code', processId: 9999, workingDir: 'C:\\work\\demo-app', windowId: 101 };
    const childWindow = {
      isDestroyed: vi.fn(() => false),
      setTitle: vi.fn(),
      webContents: { send: vi.fn() },
    };
    (sessionManager.renameSession as any).mockReturnValue(updatedSession);
    (windowManager.getWindowIdForSession as any).mockReturnValue(101);
    (windowManager.getWindow as any).mockReturnValue(childWindow);

    const handler = electronMockState.handlers.get('session:rename')!;
    const result = await handler({}, 'sess-1', 'Renamed');

    expect(result).toEqual({ success: true, session: updatedSession });
    expect(childWindow.setTitle).toHaveBeenCalledWith('Renamed - claude-code - demo-app');
    expect(childWindow.webContents.send).toHaveBeenCalledWith('session:updated', updatedSession);
  });

  it('notifies the main window when an explicit snap-back closes the child window', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999, workingDir: 'C:\\work\\demo-app', windowId: 101 },
    });

    const snapOutHandler = electronMockState.handlers.get('session:snapOut')!;
    const snapOutResult = await snapOutHandler({}, 'sess-1');
    const childWindow = electronMockState.browserWindowInstances[0]!;
    const closedHandler = childWindow.on.mock.calls.find(([event]: [string]) => event === 'closed')?.[1];
    childWindow.close.mockImplementation(() => closedHandler?.());

    (windowManager.isSessionSnappedOut as any).mockReturnValue(true);
    (windowManager.getWindowIdForSession as any).mockReturnValue(snapOutResult.windowId);
    (windowManager.getWindow as any).mockReturnValue(childWindow);
    mainWindowSend.mockClear();
    (sessionManager.updateSession as any).mockClear();
    (windowManager.unassignSession as any).mockClear();
    (windowManager.unregisterWindow as any).mockClear();

    const snapBackHandler = electronMockState.handlers.get('session:snapBack')!;
    const result = await snapBackHandler({}, 'sess-1');

    expect(result).toEqual({ success: true });
    expect(childWindow.close).toHaveBeenCalled();
    expect(windowManager.unregisterWindow).toHaveBeenCalledWith(101);
    expect(windowManager.unassignSession).toHaveBeenCalledWith('sess-1');
    expect(sessionManager.updateSession).toHaveBeenCalledWith('sess-1', { windowId: undefined });
    expect(mainWindowSend).toHaveBeenCalledWith('session:snapBack', 'sess-1');
  });

  it('does not notify the main window when a snapped-out session window closes after the session is gone', async () => {
    setup({
      'sess-1': { id: 'sess-1', name: 'Test', cliType: 'claude-code', processId: 9999, workingDir: 'C:\\work\\demo-app', windowId: 101 },
    });

    const snapOutHandler = electronMockState.handlers.get('session:snapOut')!;
    await snapOutHandler({}, 'sess-1');
    const childWindow = electronMockState.browserWindowInstances[0]!;
    const closedHandler = childWindow.on.mock.calls.find(([event]: [string]) => event === 'closed')?.[1];
    mainWindowSend.mockClear();
    (sessionManager.hasSession as any).mockReturnValue(false);

    closedHandler?.();

    expect(mainWindowSend).not.toHaveBeenCalledWith('session:snapBack', 'sess-1');
  });
});
