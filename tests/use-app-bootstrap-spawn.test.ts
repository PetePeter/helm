// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockActivateSession = vi.fn();
const mockSyncSidebarToSession = vi.fn();
const mockNavigateToSession = vi.fn().mockResolvedValue(undefined);
const mockChipBarRefresh = vi.fn().mockResolvedValue(undefined);
const mockCreateTerminal = vi.fn().mockResolvedValue(true);
const mockGetSession = vi.fn();
const mockGetSessionIds = vi.fn();
const mockHydrateFromStore = vi.fn().mockResolvedValue([]);

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
    createTerminal: mockCreateTerminal,
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
    refresh: mockChipBarRefresh,
  }),
}));

vi.mock('../renderer/stores/navigation.js', () => ({
  useNavigationStore: () => ({
    activateSession: mockActivateSession,
    syncSidebarToSession: mockSyncSidebarToSession,
    onNavListRebuilt: vi.fn(),
    navigateToSession: mockNavigateToSession,
  }),
}));

describe('useAppBootstrap doSpawn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T17:20:00Z'));
    vi.clearAllMocks();

    mockGetSessionIds.mockReturnValue(['pty-claude-code-1776705600000']);
    mockGetSession.mockReturnValue({
      cliType: 'claude-code',
      name: 'claude-code',
      cwd: '/repo',
      title: 'Claude',
    });
    mockHydrateFromStore.mockResolvedValue([]);

    (globalThis as typeof globalThis & { window: any }).window = {
      sessionStore: {
        load: vi.fn().mockResolvedValue([]),
      },
      gamepadCli: {
        configGetSpawnCommand: vi.fn().mockResolvedValue({ command: 'claude', args: [] }),
        configGetCliTypes: vi.fn().mockResolvedValue(['claude-code']),
        configGetWorkingDirs: vi.fn().mockResolvedValue([{ name: 'repo', path: '/repo' }]),
        configGetSessionGroupPrefs: vi.fn().mockResolvedValue({
          order: [],
          collapsed: [],
          bookmarked: [],
        }),
        draftList: vi.fn().mockResolvedValue([]),
        planStartableForDir: vi.fn().mockResolvedValue([]),
        planDoingForSession: vi.fn().mockResolvedValue([]),
      },
    };
  });

  it('refreshes the chip bar again after the delayed post-spawn session refresh', async () => {
    const mod = await import('../renderer/composables/useAppBootstrap.js');
    const { state } = await import('../renderer/state.js');
    state.lastOutputTimes.clear();

    await mod.doSpawn('claude-code', '/repo');

    expect(mockNavigateToSession).toHaveBeenCalledWith('pty-claude-code-1776705600000');
    expect(mockActivateSession).not.toHaveBeenCalled();
    expect(state.lastOutputTimes.get('pty-claude-code-1776705600000')).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(300);

    expect(mockSyncSidebarToSession).toHaveBeenCalledWith('pty-claude-code-1776705600000');
    expect(mockChipBarRefresh).toHaveBeenCalledWith('pty-claude-code-1776705600000');
  });

  it('doSpawn reuses provided sessionId instead of generating new one', async () => {
    const mod = await import('../renderer/composables/useAppBootstrap.js');
    const { state } = await import('../renderer/state.js');
    state.lastOutputTimes.clear();

    await mod.doSpawn('claude-code', '/repo', undefined, undefined, 'my-custom-session-id');

    expect(mockCreateTerminal).toHaveBeenCalledWith(
      'my-custom-session-id',
      'claude-code',
      expect.any(String),
      expect.any(Array),
      '/repo',
      undefined,
      undefined,
    );
  });

  it('doSpawn generates sessionId when not provided', async () => {
    const mod = await import('../renderer/composables/useAppBootstrap.js');
    const { state } = await import('../renderer/state.js');
    state.lastOutputTimes.clear();

    await mod.doSpawn('claude-code', '/repo');

    expect(mockCreateTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/^pty-claude-code-\d+$/),
      'claude-code',
      expect.any(String),
      expect.any(Array),
      '/repo',
      undefined,
      undefined,
    );
  });
});
