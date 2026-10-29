// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../renderer/state.js';

const mockAdoptTerminal = vi.fn();
const mockSwitchTo = vi.fn();
const mockHas = vi.fn();
const mockGetSessionIds = vi.fn();
const mockGetSession = vi.fn();
const mockHydrateFromStore = vi.fn();

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
  TerminalManager: vi.fn(),
}));

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  setTerminalManager: vi.fn(),
  getTerminalManager: vi.fn(() => ({
    adoptTerminal: mockAdoptTerminal,
    switchTo: mockSwitchTo,
    has: mockHas,
    getSessionIds: mockGetSessionIds,
    getManagedSessions: vi.fn(() => []),
    hydrateFromStore: mockHydrateFromStore,
    getSession: mockGetSession,
  })),
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
    refresh: vi.fn().mockResolvedValue(undefined),
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

describe('useAppBootstrap restoreSnappedBackSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = [];
    state.snappedOutSessions.clear();

    mockHas.mockReturnValue(false);
    mockGetSessionIds.mockReturnValue([]);
    mockGetSession.mockReturnValue(undefined);
    mockHydrateFromStore.mockImplementation(async () => {
      return await (globalThis as typeof globalThis & { window: any }).window.sessionStore.load();
    });

    (globalThis as typeof globalThis & { window: any }).window = {
      sessionStore: {
        load: vi.fn().mockResolvedValue([
          {
            id: 'sess-1',
            name: 'Recovered Session',
            cliType: 'claude-code',
            processId: 123,
            workingDir: 'X:\\coding\\gamepad-cli-hub',
          },
        ]),
      },
      gamepadCli: {
        configGetSessionGroupPrefs: vi.fn().mockResolvedValue({
          order: [],
          collapsed: [],
          bookmarked: [],
        }),
        configGetCliTypes: vi.fn().mockResolvedValue(['claude-code']),
        configGetWorkingDirs: vi.fn().mockResolvedValue([]),
        draftList: vi.fn().mockResolvedValue([]),
        planStartableForDir: vi.fn().mockResolvedValue([]),
        planDoingForSession: vi.fn().mockResolvedValue([]),
        terminalAttach: vi.fn().mockResolvedValue({ success: true, replay: 'raw replay' }),
      },
    };
  });

  it('refreshes sessions and re-adopts a snapped-back terminal from the main-process replay', async () => {
    state.snappedOutSessions.add('sess-1');

    const mod = await import('../renderer/composables/useAppBootstrap.js');
    await mod.restoreSnappedBackSession('sess-1');

    expect(state.sessions.map(s => s.id)).toContain('sess-1');
    expect(state.snappedOutSessions.has('sess-1')).toBe(false);
    expect(mockAdoptTerminal).toHaveBeenCalledWith(
      'sess-1',
      'claude-code',
      'X:\\coding\\gamepad-cli-hub',
      'Recovered Session',
      'raw replay',
    );
    expect(mockSwitchTo).toHaveBeenCalledWith('sess-1');
  });

  it('does not duplicate the terminal when it is already present locally', async () => {
    mockHas.mockReturnValue(true);

    const mod = await import('../renderer/composables/useAppBootstrap.js');
    await mod.restoreSnappedBackSession('sess-1');

    expect(mockAdoptTerminal).not.toHaveBeenCalled();
    expect(mockSwitchTo).toHaveBeenCalledWith('sess-1');
  });

  it('keeps snapped-out persisted sessions in the sidebar refresh even without a local terminal', async () => {
    (globalThis as typeof globalThis & { window: any }).window.sessionStore.load.mockResolvedValue([
      {
        id: 'snap-1',
        name: 'Snapped Session',
        cliType: 'claude-code',
        processId: 321,
        workingDir: 'X:\\coding\\gamepad-cli-hub',
        windowId: 777,
      },
    ]);

    const mod = await import('../renderer/composables/useAppBootstrap.js');
    await mod.refreshSessions();

    expect(state.sessions.map((s) => s.id)).toEqual(['snap-1']);
    expect(state.snappedOutSessions.has('snap-1')).toBe(true);
  });
});
