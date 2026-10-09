// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '../renderer/terminal/terminal-manager.js';
import { setTerminalManager } from '../renderer/runtime/terminal-provider.js';

const navigationHarness = vi.hoisted(() => ({
  onNavigate: null as null | ((sessionId: string) => void),
  syncedSessionIds: [] as string[],
}));

class FakeResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver = FakeResizeObserver as never;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, {
      loadAddon() {}, open() {}, write() {}, focus() {}, blur() {}, clear() {}, dispose() {},
      scrollToBottom() {}, scrollLines() {}, hasSelection: () => false, getSelection: () => '',
      clearSelection() {}, attachCustomKeyEventHandler() {}, attachCustomWheelEventHandler() {},
      onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
      onTitleChange: () => ({ dispose() {} }),
      buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, length: 30, getLine() {} } },
      cols: 120, rows: 30, options: {}, parser: { registerCsiHandler: () => ({ dispose() {} }) },
    });
    return this;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function (this: object) { Object.assign(this, { fit() {} }); return this; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function (this: object) { return this; }) }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn(function (this: object) { Object.assign(this, { findNext: () => true, findPrevious: () => false }); return this; }) }));

vi.mock('../renderer/bindings.js', () => ({ initConfigCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../renderer/gamepad.js', () => ({ browserGamepad: { start() {}, stop() {}, onButton: () => () => {}, onRelease: () => () => {}, getCount: () => 0, setRepeatConfig() {} } }));
vi.mock('../renderer/composables/useGamepadBootstrap.js', () => ({ setupGamepad() {}, teardownGamepad() {} }));
vi.mock('../renderer/composables/useTimerRefresh.js', () => ({ startTimerRefresh() {}, stopTimerRefresh() {} }));
vi.mock('../renderer/composables/useFlashAttention.js', () => ({ useFlashAttention() {} }));
vi.mock('../renderer/composables/useUpdateCheck.js', () => ({ checkForAppUpdate() {} }));
vi.mock('../renderer/paste-handler.js', () => ({ setupKeyboardRelay() {} }));
vi.mock('../renderer/tab-cycling.js', () => ({ resolveNextTerminalId: () => null }));
vi.mock('../renderer/sort-logic.js', () => ({ sortSessions: (sessions: unknown[]) => sessions }));
vi.mock('../renderer/session-groups.js', () => ({
  buildSessionGroups: () => [], buildFlatNavList: () => [], findNavIndexBySessionId: () => 0,
}));
vi.mock('../renderer/screens/group-overview.js', () => ({
  setOutputBuffer() {}, setSessionStateGetter() {}, setActivityLevelGetter() {}, setTerminalManagerGetter() {},
  setSelectCardCallback() {}, setOverviewDismissCallback() {},
}));
vi.mock('../renderer/plans/plan-screen.js', () => ({
  setPlanScreenFitCallback() {}, setPlanScreenCloseCallback() {}, setPlanScreenOpenCallback() {}, refreshCanvasIfVisible() {},
}));
vi.mock('../renderer/screens/sessions-spawn.js', () => ({ setTerminalManagerGetter() {} }));
vi.mock('../renderer/screens/sessions.js', () => ({ updateSessionsFocus() {}, getTabCycleSessionIds: () => [] }));
vi.mock('../renderer/stores/draft-editor-registry.js', () => ({ initDraftEditor() {} }));
vi.mock('../renderer/screens/sessions-plans.js', () => ({ refreshPlanBadges: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../renderer/stores/chip-bar.js', () => ({ useChipBarStore: () => ({ refresh: vi.fn() }) }));
vi.mock('../renderer/stores/navigation.js', () => ({
  useNavigationStore: () => ({
    navigateToSession: async (sessionId: string) => { navigationHarness.onNavigate?.(sessionId); },
    syncSidebarToSession: (sessionId: string) => { navigationHarness.syncedSessionIds.push(sessionId); },
  }),
}));

let dataListener: ((sessionId: string, data: string) => void) | undefined;
let gamepadCli: Record<string, unknown>;

afterEach(() => {
  navigationHarness.onNavigate = null;
  navigationHarness.syncedSessionIds.length = 0;
  setTerminalManager(null);
  delete (window as Window & { gamepadCli?: unknown }).gamepadCli;
  delete (window as Window & { sessionStore?: unknown }).sessionStore;
  document.body.innerHTML = '';
});

describe('doSpawnShell', () => {
  it('preserves focus changes made while the shell becomes ready and refreshes after a write failure', async () => {
    dataListener = undefined;
    let spawnedSessionId = '';
    gamepadCli = {
      ptySpawn: async (sessionId: string) => {
        spawnedSessionId = sessionId;
        return { success: true };
      },
      ptyWrite: async () => ({ success: false, error: 'write denied' }),
      ptyResize() {},
      ptyKill() {},
      onPtyData: (listener: typeof dataListener) => { dataListener = listener; return () => { dataListener = undefined; }; },
      onPtyExit: () => () => {},
      configGetSessionGroupPrefs: async () => ({ order: [], collapsed: [], bookmarked: [], overviewHidden: [] }),
      configGetCliTypes: async () => [],
      configGetWorkingDirs: async () => [],
      projectList: async () => [],
      draftList: async () => [],
      artifactCounts: async () => ({}),
      planStartableForDir: async () => [],
      planDoingForSession: async () => [],
    };
    (window as Window & { gamepadCli?: unknown }).gamepadCli = gamepadCli;
    (window as Window & { sessionStore?: unknown }).sessionStore = { load: async () => [] };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const manager = new TerminalManager(container);
    setTerminalManager(manager);
    const { state } = await import('../renderer/state.js');
    const { sessionsState } = await import('../renderer/screens/sessions-state.js');
    state.sessions = [];
    sessionsState.activeFocus = 'spawn';
    let shellRun: Promise<void> | undefined;

    try {
      const { doSpawnShell } = await import('../renderer/composables/useAppBootstrap.js');
      let shellNavigated!: (sessionId: string) => void;
      const navigated = new Promise<string>(resolve => { shellNavigated = resolve; });
      navigationHarness.onNavigate = shellNavigated;
      shellRun = doSpawnShell('echo setup');
      const sessionId = await navigated;
      await Promise.resolve();

      expect(sessionsState.activeFocus).toBe('sessions');
      expect(navigationHarness.syncedSessionIds).toEqual([sessionId]);
      expect(spawnedSessionId).toBe(sessionId);

      sessionsState.activeFocus = 'plans';
      dataListener?.(sessionId, 'C:\\>');
      await expect(shellRun).rejects.toThrow('write denied');

      expect(state.sessions.some(session => session.name === 'Shell' && session.cliType === 'shell')).toBe(true);
      expect(sessionsState.activeFocus).toBe('plans');
      expect(navigationHarness.syncedSessionIds).toEqual([sessionId]);
    } finally {
      if (spawnedSessionId) dataListener?.(spawnedSessionId, 'C:\\>');
      await shellRun?.catch(() => {});
      manager.dispose();
    }
  });

  it('does not change focus or sidebar selection when shell creation fails', async () => {
    dataListener = undefined;
    gamepadCli = {
      ptySpawn: async () => ({ success: false, error: 'spawn failed' }),
      ptyWrite: async () => ({ success: true }),
      ptyResize() {},
      ptyKill() {},
      onPtyData: (listener: typeof dataListener) => { dataListener = listener; return () => { dataListener = undefined; }; },
      onPtyExit: () => () => {},
      configGetSessionGroupPrefs: async () => ({ order: [], collapsed: [], bookmarked: [], overviewHidden: [] }),
      configGetCliTypes: async () => [],
      configGetWorkingDirs: async () => [],
      projectList: async () => [],
      draftList: async () => [],
      artifactCounts: async () => ({}),
      planStartableForDir: async () => [],
      planDoingForSession: async () => [],
    };
    (window as Window & { gamepadCli?: unknown }).gamepadCli = gamepadCli;
    (window as Window & { sessionStore?: unknown }).sessionStore = { load: async () => [] };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const manager = new TerminalManager(container);
    setTerminalManager(manager);
    const { sessionsState } = await import('../renderer/screens/sessions-state.js');
    sessionsState.activeFocus = 'plans';

    try {
      const { doSpawnShell } = await import('../renderer/composables/useAppBootstrap.js');

      await expect(doSpawnShell('echo setup')).rejects.toThrow('The shell session could not be created.');

      expect(sessionsState.activeFocus).toBe('plans');
      expect(navigationHarness.syncedSessionIds).toEqual([]);
    } finally {
      manager.dispose();
    }
  });
});
