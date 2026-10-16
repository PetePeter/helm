// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../renderer/state.js';

const mockSetTerminalManager = vi.fn();
const mockCreateTerminal = vi.fn();
const mockRenameTerminal = vi.fn();
const mockHydrateFromStore = vi.fn();
const mockRefreshChipBar = vi.fn().mockResolvedValue(undefined);

let currentLocalSessions = new Map<string, { cliType: string; name: string; cwd?: string; title?: string }>();

const mockTerminalManager = {
  getOutputBuffer: vi.fn(() => ({ clear: vi.fn(), append: vi.fn() })),
  setOnEmpty: vi.fn(),
  setOnSwitch: vi.fn(),
  setVisibleOrderProvider: vi.fn(),
  setOnTitleChange: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  getSessionIds: vi.fn(() => Array.from(currentLocalSessions.keys())),
  getManagedSessions: vi.fn(() => []),
  hydrateFromStore: mockHydrateFromStore,
  getSession: vi.fn((id: string) => {
    const session = currentLocalSessions.get(id);
    return session ? { sessionId: id, ...session } : undefined;
  }),
  createTerminal: mockCreateTerminal,
  renameSession: mockRenameTerminal,
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
  findNavIndexBySessionId: vi.fn(() => 0),
}));

vi.mock('../renderer/screens/group-overview.js', () => ({
  setOutputBuffer: vi.fn(),
  setSessionStateGetter: vi.fn(),
  setActivityLevelGetter: vi.fn(),
  setTerminalManagerGetter: vi.fn(),
  setSelectCardCallback: vi.fn(),
  setOverviewDismissCallback: vi.fn(),
}));

vi.mock('../renderer/plans/plan-screen.js', () => ({
  setPlanScreenFitCallback: vi.fn(),
  setPlanScreenCloseCallback: vi.fn(),
  setPlanScreenOpenCallback: vi.fn(),
  refreshCanvasIfVisible: vi.fn(),
}));

vi.mock('../renderer/screens/sessions-spawn.js', () => ({
  setTerminalManagerGetter: vi.fn(),
}));

vi.mock('../renderer/screens/sessions.js', () => ({
  updateSessionsFocus: vi.fn(),
  getTabCycleSessionIds: vi.fn(() => []),
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
    navigateToSession: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('useAppBootstrap autoResumeSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    currentLocalSessions = new Map();
    state.sessions = [];
    state.snappedOutSessions.clear();
    state.sessionStates.clear();
    state.sessionActivityLevels.clear();
    state.lastOutputTimes.clear();
    state.planCodingCounts.clear();
    state.planStartableCounts.clear();
    state.workingPlanLabels.clear();
    state.workingPlanTooltips.clear();
    state.pendingSchedules.clear();

    mockCreateTerminal.mockImplementation(async (sessionId: string, cliType: string, _command: string, _args: string[], cwd?: string) => {
      currentLocalSessions.set(sessionId, {
        cliType,
        name: cliType,
        cwd,
        title: `${cliType} title`,
      });
      return true;
    });
    mockRenameTerminal.mockImplementation((sessionId: string, newName: string) => {
      const existing = currentLocalSessions.get(sessionId);
      if (existing) {
        currentLocalSessions.set(sessionId, { ...existing, name: newName });
      }
    });
    mockHydrateFromStore.mockImplementation(async () => {
      return await (globalThis as typeof globalThis & { window: any }).window.sessionStore.load();
    });

    (globalThis as typeof globalThis & { window: any }).window = {
      sessionStore: {
        load: vi.fn().mockResolvedValue([
          {
            id: 'sess-restore',
            name: 'Recovered Session',
            cliType: 'claude-code',
            cliSessionName: 'resume-123',
            processId: 42,
            workingDir: 'X:\\coding\\gamepad-cli-hub',
          },
        ]),
      },
      gamepadCli: {
        configGetAll: vi.fn().mockResolvedValue({}),
        configGetCliTypes: vi.fn().mockResolvedValue(['claude-code']),
        configGetWorkingDirs: vi.fn().mockResolvedValue([]),
        configGetSessionGroupPrefs: vi.fn().mockResolvedValue({
          order: [],
          collapsed: [],
          bookmarked: [],
          overviewHidden: [],
        }),
        configGetSpawnCommand: vi.fn().mockResolvedValue({ command: 'claude', args: [] }),
        configGetEscProtectionEnabled: vi.fn().mockResolvedValue(true),
        sessionRename: vi.fn().mockResolvedValue({ success: true }),
        sessionRemove: vi.fn().mockResolvedValue({ success: true }),
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
        onPtyExit: vi.fn(() => vi.fn()),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes persisted sessions in place without deleting them from persistence', async () => {
    const mod = await import('../renderer/composables/useAppBootstrap.js');
    const container = document.createElement('div');

    await mod.bootstrap({
      terminalContainer: container,
      handleButton: vi.fn(),
      handleRelease: vi.fn(),
    });

    expect(mockCreateTerminal).toHaveBeenCalledWith(
      'sess-restore',
      'claude-code',
      expect.any(String),
      expect.any(Array),
      'X:\\coding\\gamepad-cli-hub',
      undefined,
      'resume-123',
    );
    expect(window.gamepadCli.sessionRename).toHaveBeenCalledWith('sess-restore', 'Recovered Session');
    expect(window.gamepadCli.sessionRemove).not.toHaveBeenCalled();
    expect(state.sessions.map((session) => session.id)).toContain('sess-restore');

    mod.teardown();
  });
});
