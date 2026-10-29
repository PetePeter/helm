// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { state } from '../renderer/state.js';

const mockSetTerminalManager = vi.fn();
const mockRefreshChipBar = vi.fn().mockResolvedValue(undefined);

let currentLocalSessions = new Map<string, { cliType: string; name: string; cwd?: string; title?: string }>();
let persistedSessions: Array<any> = [];
let ptyExitHandler: ((sessionId: string, exitCode: number) => void) | null = null;

const mockTerminalManager = {
  getOutputBuffer: vi.fn(() => ({ clear: vi.fn(), append: vi.fn() })),
  setOnEmpty: vi.fn(),
  setOnSwitch: vi.fn(),
  setVisibleOrderProvider: vi.fn(),
  setOnTitleChange: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  getSessionIds: vi.fn(() => Array.from(currentLocalSessions.keys())),
  getManagedSessions: vi.fn(() => []),
  hydrateFromStore: vi.fn(() => Promise.resolve([...persistedSessions])),
  getSession: vi.fn((id: string) => {
    const session = currentLocalSessions.get(id);
    return session ? { sessionId: id, ...session } : undefined;
  }),
  hasTerminal: vi.fn((id: string) => currentLocalSessions.has(id)),
  has: vi.fn((id: string) => currentLocalSessions.has(id)),
  detachTerminal: vi.fn((id: string) => {
    currentLocalSessions.delete(id);
  }),
  fitActive: vi.fn(),
  deselect: vi.fn(),
  switchTo: vi.fn(),
  adoptTerminal: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../renderer/bindings.js', () => ({
  initConfigCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../renderer/gamepad.js', () => ({
  browserGamepad: {
    start: vi.fn(),
    stop: vi.fn(),
    onButton: vi.fn(() => () => {}),
    onRelease: vi.fn(() => () => {}),
    getCount: vi.fn(() => 0),
    setRepeatConfig: vi.fn(),
  },
}));

vi.mock('../renderer/terminal/terminal-manager.js', () => ({
  TerminalManager: vi.fn(function MockTerminalManager() {
    return mockTerminalManager;
  }),
}));

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  setTerminalManager: mockSetTerminalManager,
  getTerminalManager: vi.fn(() => mockTerminalManager),
}));

vi.mock('../renderer/paste-handler.js', () => ({
  setupKeyboardRelay: vi.fn(),
}));

vi.mock('../renderer/tab-cycling.js', () => ({
  resolveNextTerminalId: vi.fn(() => null),
}));

vi.mock('../renderer/sort-logic.js', () => ({
  sortSessions: vi.fn((sessions: unknown[]) => sessions),
}));

vi.mock('../renderer/session-groups.js', () => ({
  groupSessionsByDirectory: vi.fn(() => []),
  buildSessionGroups: vi.fn(() => []),
  buildFlatNavList: vi.fn(() => []),
  filterVisibleSessions: (sessions: Array<{ id: string; hidden?: boolean }>, activeSessionId: string | null, showHidden: boolean) =>
    sessions.filter(session => showHidden || !session.hidden || session.id === activeSessionId),
  findNavIndexBySessionId: vi.fn(() => 0),
}));


vi.mock('../renderer/plans/plan-screen.js', () => ({
  setPlanScreenFitCallback: vi.fn(),
  setPlanScreenCloseCallback: vi.fn(),
  setPlanScreenOpenCallback: vi.fn(),
}));

vi.mock('../renderer/screens/sessions-spawn.js', () => ({
  setTerminalManagerGetter: vi.fn(),
}));

vi.mock('../renderer/screens/sessions.js', () => ({
  updateSessionsFocus: vi.fn(),
  getTabCycleSessionIds: vi.fn(() => []),
}));

vi.mock('../renderer/stores/item-editor-registry.js', () => ({
  initItemEditor: vi.fn(),
}));

vi.mock('../renderer/screens/sessions-plans.js', () => ({
  refreshPlanBadges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../renderer/stores/chip-bar.js', () => ({
  useChipBarStore: () => ({
    refresh: mockRefreshChipBar,
    clear: vi.fn(),
  }),
}));

vi.mock('../renderer/stores/navigation.js', () => ({
  useNavigationStore: () => ({
    activateSession: vi.fn(),
    syncSidebarToSession: vi.fn(),
    onNavListRebuilt: vi.fn(),
    navigateToSession: vi.fn(),
  }),
}));

describe('useAppBootstrap PTY exit cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.sessions = [];
    state.activeSessionId = null;
    state.sessionStates.clear();
    state.sessionActivityLevels.clear();
    state.lastOutputTimes.clear();
    state.planCodingCounts.clear();
    state.planStartableCounts.clear();
    state.workingPlanLabels.clear();
    state.workingPlanTooltips.clear();
    state.pendingSchedules.clear();
    state.snappedOutSessions.clear();

    currentLocalSessions = new Map([
      ['sess-1', { cliType: 'claude-code', name: 'Sess 1', cwd: '/repo', title: 'Sess 1' }],
    ]);
    persistedSessions = [
      { id: 'sess-1', name: 'Sess 1', cliType: 'claude-code', processId: 123, workingDir: '/repo' },
    ];
    ptyExitHandler = null;

    (globalThis as typeof globalThis & { window: any }).window = {
      sessionStore: {
        load: vi.fn(() => Promise.resolve([...persistedSessions])),
      },
      gamepadCli: {
        configGetAll: vi.fn().mockResolvedValue({}),
        configGetCliTypes: vi.fn().mockResolvedValue(['claude-code']),
        configGetWorkingDirs: vi.fn().mockResolvedValue([]),
        configGetSessionGroupPrefs: vi.fn().mockResolvedValue({
          order: [],
          collapsed: [],
          bookmarked: [],
        }),
        configGetSpawnCommand: vi.fn().mockResolvedValue({ command: 'claude', args: [] }),
        configGetEscProtectionEnabled: vi.fn().mockResolvedValue(true),
        draftList: vi.fn().mockResolvedValue([]),
        planStartableForDir: vi.fn().mockResolvedValue([]),
        planDoingForSession: vi.fn().mockResolvedValue([]),
        profileGetActive: vi.fn().mockResolvedValue('default'),
        onPtyActivityChange: vi.fn(),
        onNotificationClick: vi.fn(),
        onSessionSpawned: vi.fn(),
        onPlanChanged: vi.fn(),
        onPatternScheduleCreated: vi.fn(),
        onPatternScheduleFired: vi.fn(),
        onPatternScheduleCancelled: vi.fn(),
        onPtyExit: vi.fn((cb: (sessionId: string, exitCode: number) => void) => {
          ptyExitHandler = cb;
          return vi.fn();
        }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the local terminal and removes the stale sidebar row after PTY exit', async () => {
    const mod = await import('../renderer/composables/useAppBootstrap.js');
    const container = document.createElement('div');

    await mod.bootstrap({
      terminalContainer: container,
      handleButton: vi.fn(),
      handleRelease: vi.fn(),
    });

    expect(state.sessions.map((session) => session.id)).toContain('sess-1');

    persistedSessions = [];
    ptyExitHandler?.('sess-1', 0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockTerminalManager.detachTerminal).toHaveBeenCalledWith('sess-1');
    expect(state.sessions.map((session) => session.id)).not.toContain('sess-1');

    mod.teardown();
  });
});
