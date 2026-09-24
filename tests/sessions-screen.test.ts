/**
 * Sessions screen — vertical session list + quick spawn grid.
 *
 * Two navigation zones: session cards (top) and spawn buttons (bottom).
 * Replaces the old 3-panel launcher layout tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE vi.mock() calls so hoisted references resolve
// ---------------------------------------------------------------------------

const mockSessionGetAll = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
const mockSessionSetActive = vi.fn().mockResolvedValue(undefined);
const mockSessionClose = vi.fn().mockResolvedValue({ success: true });
const mockSessionSetState = vi.fn().mockResolvedValue(undefined);
const mockConfigGetCliTypes = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
const mockConfigGetWorkingDirs = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
const mockConfigGetSpawnCommand = vi.fn().mockResolvedValue({ command: 'claude', args: [] });
const mockConfigGetSessionGroupPrefs = vi.fn().mockResolvedValue({ order: [], collapsed: [] });
const mockConfigSetSessionGroupPrefs = vi.fn().mockResolvedValue({ success: true });
const mockConfigGetSortPrefs = vi.fn().mockResolvedValue({ field: 'state', direction: 'asc' });
const mockConfigSetSortPrefs = vi.fn().mockResolvedValue(undefined);
const mockCreateTerminal = vi.fn().mockResolvedValue(true);
const mockPlanDoingForSession = vi.fn<(sessionId: string) => Promise<any[]>>().mockResolvedValue([]);
const mockDraftList = vi.fn<(sessionId: string) => Promise<any[]>>().mockResolvedValue([]);
const mockPlanCreate = vi.fn();

const mockDestroyTerminal = vi.fn();

const mockLogEvent = vi.fn();
const mockGetCliDisplayName = vi.fn((type: string) => type || 'Unknown');
const mockRenderFooterBindings = vi.fn();
const mockSwitchTo = vi.fn();
const mockSetCloseConfirmCallback = vi.fn();
const mockCloseConfirm = { visible: false, sessionId: '', sessionName: '', draftCount: 0 };
const mockHidePlanScreen = vi.fn();
const mockShowPlanScreen = vi.fn();
let mockPlanScreenVisible = false;
let mockCurrentPlanDirPath: string | null = null;

const mockHideOverview = vi.fn();

const mockActivateSession = vi.fn();
const mockOpenOverview = vi.fn();
const mockOpenPlan = vi.fn();
const mockNavigateToSession = vi.fn();
const mockCloseOverview = vi.fn();

vi.mock('../renderer/stores/navigation.js', () => ({
  useNavigationStore: () => ({
    activateSession: mockActivateSession,
    openOverview: mockOpenOverview,
    openPlan: mockOpenPlan,
    navigateToSession: mockNavigateToSession,
    closeOverview: mockCloseOverview,
    syncSidebarToSession: vi.fn(),
    onNavListRebuilt: vi.fn(),
  }),
}));

vi.mock('../renderer/utils.js', () => {
  const dirMap: Record<string, string> = {
    DPadUp: 'up',
    DPadDown: 'down',
    DPadLeft: 'left',
    DPadRight: 'right',
    // Left/right sticks excluded — only used for CLI bindings, not UI navigation
  };
  return {
    logEvent: mockLogEvent,
    getCliDisplayName: mockGetCliDisplayName,
    renderFooterBindings: mockRenderFooterBindings,
    toDirection: (button: string) => dirMap[button] ?? null,
  };
});

vi.mock('../renderer/stores/modal-bridge.js', () => ({
  closeConfirm: mockCloseConfirm,
  setCloseConfirmCallback: mockSetCloseConfirmCallback,
}));

vi.mock('../renderer/plans/plan-screen.js', () => ({
  showPlanScreen: (...args: unknown[]) => {
    mockPlanScreenVisible = true;
    return mockShowPlanScreen(...args);
  },
  hidePlanScreen: (...args: unknown[]) => {
    mockPlanScreenVisible = false;
    return mockHidePlanScreen(...args);
  },
  isPlanScreenVisible: () => mockPlanScreenVisible,
  getCurrentPlanDirPath: () => mockCurrentPlanDirPath,
}));

vi.mock('../renderer/screens/group-overview.js', () => ({
  getOverviewSessions: vi.fn(() => []),
  handleOverviewInput: vi.fn(() => false),
  hideOverview: mockHideOverview,
  isOverviewVisible: vi.fn(() => false),
  refreshOverview: vi.fn(),
}));

let mockCurrentView = 'terminal';
vi.mock('../renderer/main-view/main-view-manager.js', () => ({
  currentView: vi.fn(() => mockCurrentView),
  showView: vi.fn(),
  registerView: vi.fn(),
  onViewChange: vi.fn(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSidebarDom(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }

  document.body.innerHTML = `
    <section id="screen-sessions" class="screen screen--active sessions-screen-section">
      <div class="sessions-list-shell">
        <div class="sessions-list" id="sessionsList"></div>
        <div class="sessions-empty" id="sessionsEmpty" style="display:none">
          No active sessions
        </div>
      </div>
    </section>
    <div class="spawn-section" id="schedulerSection">
      <h3 class="section-label">Scheduler</h3>
    </div>
    <div class="spawn-section" id="quickSpawnSection">
      <h3 class="section-label">Quick Spawn</h3>
      <div class="spawn-grid" id="spawnGrid"></div>
    </div>
    <div class="spawn-section" id="plannerSection">
      <h3 class="section-label">Project Planner</h3>
      <div class="plans-grid" id="plansGrid"></div>
    </div>
    <div id="mainArea">
      <div id="terminalContainer"></div>
    </div>
    <div id="panelSplitter"></div>
    <p id="statusTotalSessions">0</p>
    <p id="statusActiveSessions">0</p>
  `;
}

async function getState() {
  return (await import('../renderer/state.js')).state;
}

async function getSessionsState() {
  return (await import('../renderer/screens/sessions-state.js')).sessionsState;
}

async function getSessions() {
  return await import('../renderer/screens/sessions.js');
}

/** Flush the microtask queue so async fire-and-forget calls complete. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

/** Load sessions data and wait for rendering to complete. */
async function loadAndFlush(
  mod: Awaited<ReturnType<typeof getSessions>>,
): Promise<void> {
  await mod.loadSessions();
  await flush();
}

function makeSessions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s-${i}`,
    name: `Session ${i}`,
    cliType: 'claude-code',
    processId: 1000 + i,

  }));
}

/** Mock TerminalManager that returns configured sessions. */
function createMockTerminalManager(sessionData: Array<{ id: string; cliType: string; name?: string; title?: string }>) {
  const sessionsMap = new Map(sessionData.map(s => [s.id, { sessionId: s.id, cliType: s.cliType, name: s.name || s.cliType, title: s.title }]));
  return {
    getSessionIds: () => Array.from(sessionsMap.keys()),
    getSession: (id: string) => sessionsMap.get(id),
    getManagedSessions: () => Array.from(sessionsMap.values()).map((session) => ({
      id: session.sessionId,
      name: session.name,
      cliType: session.cliType,
      processId: 0,
      title: session.title,
    })),
    hydrateFromStore: async () => {
      const stored = await (window as any).sessionStore.load();
      const merged = new Map(stored.map((session: any) => [session.id, session]));
      for (const session of sessionsMap.values()) {
        merged.set(session.sessionId, {
          ...(merged.get(session.sessionId) ?? {}),
          id: session.sessionId,
          name: session.name,
          cliType: session.cliType,
          processId: 0,
          title: session.title,
        });
      }
      return Array.from(merged.values());
    },
    getActiveSessionId: () => null,
    hasTerminal: (id: string) => sessionsMap.has(id),
    switchTo: mockSwitchTo,
    focusActive: vi.fn(),
    fitActive: vi.fn(),
    createTerminal: mockCreateTerminal,
    destroyTerminal: mockDestroyTerminal,
    renameSession: vi.fn((id: string, newName: string) => {
      const s = sessionsMap.get(id);
      if (s) s.name = newName;
    }),
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Sessions Screen', () => {
  let state: Awaited<ReturnType<typeof getState>>;
  let sessions: Awaited<ReturnType<typeof getSessions>>;
  let sessionsState: Awaited<ReturnType<typeof getSessionsState>>;
  const keyHandlerCleanups: Array<() => void> = [];
  let uninstallKeyRouter: (() => void) | null = null;
  /** Stands in for the modal systems the shell reads via isKeyboardModalOpen(). */
  let modalOpenForTest = false;
  let focusedPaneForTest = 'sessions';

  /** Set terminal manager sessions for loadAndFlush. */
  function setMockTerminalSessions(sessionsData: ReturnType<typeof makeSessions>): void {
    sessions.setTerminalManagerGetter(() => createMockTerminalManager(
      sessionsData.map(s => ({ id: s.id, cliType: s.cliType, title: (s as any).title }))
    ));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    buildSidebarDom();

    (window as any).gamepadCli = {
      sessionSetActive: mockSessionSetActive,
      sessionClose: mockSessionClose,
      sessionSetState: mockSessionSetState,
      sessionRename: vi.fn().mockResolvedValue({ success: true }),
      configGetCliTypes: mockConfigGetCliTypes,
      configGetWorkingDirs: mockConfigGetWorkingDirs,
      configGetSpawnCommand: mockConfigGetSpawnCommand,
      configGetSessionGroupPrefs: mockConfigGetSessionGroupPrefs,
      configSetSessionGroupPrefs: mockConfigSetSessionGroupPrefs,
      configGetSortPrefs: mockConfigGetSortPrefs,
      configSetSortPrefs: mockConfigSetSortPrefs,
      draftList: mockDraftList,
      planCreate: mockPlanCreate,
      planStartableForDir: vi.fn().mockResolvedValue([]),
      planDoingForSession: mockPlanDoingForSession,
      onPlanChanged: vi.fn(() => vi.fn()),
    };
    (window as any).sessionStore = {
      load: mockSessionGetAll,
    };

    state = await getState();
    sessionsState = await getSessionsState();
    sessions = await getSessions();

    // Sensible defaults — individual tests override as needed
    sessions.setTerminalManagerGetter(() => createMockTerminalManager([]));
    mockConfigGetCliTypes.mockResolvedValue(['claude-code', 'copilot-cli']);
    mockConfigGetSpawnCommand.mockResolvedValue({ command: 'claude', args: [] });
    mockCreateTerminal.mockResolvedValue(true);
    mockDraftList.mockResolvedValue([]);
    mockPlanCreate.mockReset();
    mockPlanCreate.mockResolvedValue({ id: 'plan-1' });
    mockConfigGetWorkingDirs.mockResolvedValue([
      { name: 'project-a', path: '/projects/a' },
      { name: 'project-b', path: '/projects/b' },
    ]);
    mockPlanDoingForSession.mockResolvedValue([]);
    mockPlanScreenVisible = false;
    mockCurrentPlanDirPath = null;
    mockHidePlanScreen.mockReset();
    mockShowPlanScreen.mockReset();
    mockOpenPlan.mockReset();
    mockCloseOverview.mockReset();
    mockNavigateToSession.mockReset();
    mockActivateSession.mockReset();
    mockActivateSession.mockImplementation((sessionId: string) => {
      state.activeSessionId = sessionId;
      return { kind: 'local-terminal', sessionId };
    });
    mockSwitchTo.mockReset();
    mockCurrentView = 'terminal';
    state.recentSessionId = null;
    state.lastSelectedSessionId = null;
    modalOpenForTest = false;
    focusedPaneForTest = 'sessions';

    // Navigation keys and Ctrl+Shift+W are workspace/pane handlers on the shared
    // keyboard router now, not a listener owned by sessions.ts. Register the
    // same wiring the shell uses so these tests still exercise the real path.
    const { installKeyRouter, registerKeyHandler } = await import('../renderer/keyboard/router.js');
    const { createWorkspaceKeyHandlers } = await import('../renderer/keyboard/handlers/workspace-keys.js');

    for (const handler of createWorkspaceKeyHandlers({
      activatePane: () => {},
      cycleSession: () => {},
      jumpToSession: () => false,
      fireChipAction: () => false,
      spawnSession: () => {},
      closeActiveSession: () => {
        if (state.activeSessionId) sessions.confirmCloseSessionById(state.activeSessionId);
      },
    })) {
      keyHandlerCleanups.push(registerKeyHandler(handler));
    }

    keyHandlerCleanups.push(registerKeyHandler({
      id: 'pane-navigation',
      scope: 'pane',
      claims: (ctx) => !ctx.isFocused('terminal') && ctx.scope !== 'terminal',
      handle: (ctx) => {
        if (ctx.event.ctrlKey || ctx.event.altKey || ctx.event.metaKey) return false;
        const button = sessions.NAVIGATION_KEY_BUTTONS[ctx.key];
        if (!button) return false;
        sessions.handleSessionsScreenButton(button);
        return true;
      },
    }));

    uninstallKeyRouter = installKeyRouter({
      getActiveSessionId: () => state.activeSessionId ?? null,
      getFocusedPane: () => focusedPaneForTest,
      isPaneVisible: () => true,
      isModalOpen: () => modalOpenForTest,
    });
  });

  afterEach(() => {
    for (const cleanup of keyHandlerCleanups.splice(0)) cleanup();
    uninstallKeyRouter?.();
    uninstallKeyRouter = null;
    vi.useRealTimers();
    vi.clearAllMocks();
    // Reset module-level bridges so tests don't leak state
    sessions.setDirPickerBridge(null as any);
    sessions.setTerminalManagerGetter(null as any);
    Object.assign(sessionsState, {
      activeFocus: 'sessions',
      sessionsFocusIndex: 0,
      spawnFocusIndex: 0,
      plansFocusIndex: 0,
      cardColumn: 0,
      cliTypes: [],
      directories: [],
      editingSessionId: null,
      // navList/groups are derived from state.sessions — reset below.
      groupPrefs: { order: [], collapsed: [], overviewHidden: [], bookmarked: [] },
      overviewGroup: null,
      overviewIsGlobal: false,
      overviewFocusIndex: 0,
    });
    Object.assign(state, {
      sessions: [],
      activeSessionId: null,
      currentScreen: 'sessions',
    });
    document.getElementById('overviewGrid')?.remove();
    const terminalContainer = document.getElementById('terminalContainer');
    if (terminalContainer) terminalContainer.style.display = '';
    document.body.innerHTML = '';
  });

  // ==========================================================================
  // loadSessions — data loading and initialization
  // ==========================================================================

  describe('loadSessions', () => {
    it('loads sessions, CLI types, and directories from IPC', async () => {
      setMockTerminalSessions(makeSessions(2));
      mockConfigGetCliTypes.mockResolvedValue(['claude-code']);
      mockConfigGetWorkingDirs.mockResolvedValue([{ name: 'a', path: '/a' }]);

      await loadAndFlush(sessions);

      expect(mockConfigGetCliTypes).toHaveBeenCalled();
      expect(mockConfigGetWorkingDirs).toHaveBeenCalled();
      expect(state.sessions).toHaveLength(2);
      expect(sessionsState.cliTypes).toEqual(['claude-code']);
      expect(sessionsState.directories).toEqual([{ name: 'a', path: '/a' }]);
    });

    it('clamps sessionsFocusIndex after load when out of bounds', async () => {
      sessionsState.sessionsFocusIndex = 5;

      setMockTerminalSessions(makeSessions(2));
      mockConfigGetCliTypes.mockResolvedValue(['claude-code']);
      mockConfigGetWorkingDirs.mockResolvedValue([{ name: 'a', path: '/a' }]);

      await loadAndFlush(sessions);

      expect(sessionsState.sessionsFocusIndex).toBeLessThanOrEqual(3);
    });

    it('clamps spawnFocusIndex after load when out of bounds', async () => {
      sessionsState.spawnFocusIndex = 10;

      mockConfigGetCliTypes.mockResolvedValue(['claude-code']);
      mockConfigGetWorkingDirs.mockResolvedValue([]);

      await loadAndFlush(sessions);

      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('does nothing when window.gamepadCli is not set', async () => {
      delete (window as any).gamepadCli;
      await loadAndFlush(sessions);
      expect(state.sessions).toEqual([]);
    });

    it('keeps quick spawn and planner sections outside the scrollable sessions list shell', () => {
      const shell = document.querySelector('.sessions-list-shell');
      const list = document.getElementById('sessionsList');
      const scheduler = document.getElementById('schedulerSection');
      const quickSpawn = document.getElementById('quickSpawnSection');
      const planner = document.getElementById('plannerSection');

      expect(shell?.contains(list)).toBe(true);
      expect(shell?.contains(scheduler)).toBe(false);
      expect(shell?.contains(quickSpawn)).toBe(false);
      expect(shell?.contains(planner)).toBe(false);
      expect(quickSpawn?.previousElementSibling?.id).toBe('schedulerSection');
    });
  });

  describe('keyboard shortcuts', () => {
    it('leaves workspace pane shortcuts to the docking shell', async () => {
      for (const key of ['P', 'O', 'M', 'S', 'A', 'T']) {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
      }
      await flush();

      expect(mockOpenPlan).not.toHaveBeenCalled();
      expect(mockOpenOverview).not.toHaveBeenCalled();
      expect(mockNavigateToSession).not.toHaveBeenCalled();
    });

    it('Ctrl+Shift+W opens close confirm for the active terminal session', async () => {
      mockCurrentView = 'terminal';
      state.activeSessionId = 's-1';
      state.recentSessionId = 's-1';
      state.sessions = [{
        id: 's-1',
        name: 'Session 1',
        cliType: 'claude-code',
        processId: 1,
        workingDir: '/projects/a',
      }];

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'W',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await flush();

      expect(mockCloseConfirm.sessionId).toBe('s-1');
      expect(mockCloseConfirm.sessionName).toBe('Session 1');
      expect(mockSetCloseConfirmCallback).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ==========================================================================
  // Navigation — sessions zone
  // ==========================================================================

  describe('Sessions zone navigation', () => {
    beforeEach(async () => {
      setMockTerminalSessions(makeSessions(3));
      await loadAndFlush(sessions);
    });

    it('DPadDown moves sessionsFocusIndex forward', () => {
      expect(sessionsState.sessionsFocusIndex).toBe(0);
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.sessionsFocusIndex).toBe(1);
    });

    it('DPadDown on session card advances to next card', () => {
      sessionsState.sessionsFocusIndex = 1; // first session card
      sessions.handleSessionsScreenButton('DPadDown');
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.sessionsFocusIndex).toBe(3);
    });

    it('DPadDown from overview routes session auto-select through activateSession', () => {
      mockCurrentView = 'overview';
      sessionsState.sessionsFocusIndex = 1; // first session card

      sessions.handleSessionsScreenButton('DPadDown');

      expect(sessionsState.sessionsFocusIndex).toBe(2);
      expect(mockActivateSession).toHaveBeenCalledWith('s-1');
      expect(mockNavigateToSession).not.toHaveBeenCalled();
      expect(mockSwitchTo).not.toHaveBeenCalled();
    });

    it('DPadUp moves sessionsFocusIndex backward', () => {
      sessionsState.sessionsFocusIndex = 1;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('DPadUp on session card navigates up, stops at the group header (no wrap)', () => {
      sessionsState.sessionsFocusIndex = 1; // first session card
      sessions.handleSessionsScreenButton('DPadUp'); // → group header (index 0)
      expect(sessionsState.sessionsFocusIndex).toBe(0);
      expect(sessionsState.activeFocus).toBe('sessions');
      // From the group header (index 0), DPadUp is a no-op
      sessionsState.sessionsFocusIndex = 0;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('DPadDown past last session switches to spawn zone', () => {
      sessionsState.sessionsFocusIndex = 3;
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.activeFocus).toBe('spawn');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('DPadDown with no sessions switches to spawn zone immediately', async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([]));
      await loadAndFlush(sessions);

      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.activeFocus).toBe('spawn');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('DPadUp with no sessions does nothing', async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([]));
      await loadAndFlush(sessions);

      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.activeFocus).toBe('sessions');
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('A in sessions zone is not consumed at col=0 on session card (returns false)', () => {
      sessionsState.sessionsFocusIndex = 1; // first session card
      expect(sessions.handleSessionsScreenButton('A')).toBe(false);
    });

    it('D-pad down auto-selects the focused session', () => {
      sessionsState.sessionsFocusIndex = 1; // first session card
      sessions.handleSessionsScreenButton('DPadDown');

      expect(mockActivateSession).toHaveBeenCalledWith('s-1');
      expect(mockNavigateToSession).not.toHaveBeenCalled();
    });

    it('X falls through to config bindings (not consumed)', () => {
      expect(sessions.handleSessionsScreenButton('X')).toBe(false);
      expect(mockSessionClose).not.toHaveBeenCalled();
    });

    it('Y falls through to config bindings (not consumed)', () => {
      expect(sessions.handleSessionsScreenButton('Y')).toBe(false);
      expect(mockLogEvent).not.toHaveBeenCalledWith('Sessions refreshed');
    });

    it('directional buttons return true, non-navigation buttons return false for unhandled', () => {
      expect(sessions.handleSessionsScreenButton('DPadDown')).toBe(true);
      expect(sessions.handleSessionsScreenButton('X')).toBe(false);
      expect(sessions.handleSessionsScreenButton('Y')).toBe(false);
      // A on session card at col=0 falls through to config bindings
      sessionsState.sessionsFocusIndex = 1; // session card, not group header
      expect(sessions.handleSessionsScreenButton('A')).toBe(false);
      // Unknown buttons are not consumed — fall through to config bindings
      expect(sessions.handleSessionsScreenButton('UnknownButton')).toBe(false);
    });

    it('LeftStickDown does NOT navigate session list (no toDirection mapping)', () => {
      const before = sessionsState.sessionsFocusIndex;
      // LeftStick is not in dirMap, so toDirection returns null and it's not consumed
      expect(sessions.handleSessionsScreenButton('LeftStickDown')).toBe(false);
      expect(sessionsState.sessionsFocusIndex).toBe(before);
    });

    it('RightStick does NOT navigate the session list', () => {
      const before = sessionsState.sessionsFocusIndex;
      expect(sessions.handleSessionsScreenButton('RightStickDown')).toBe(false);
      expect(sessions.handleSessionsScreenButton('RightStickUp')).toBe(false);
      expect(sessionsState.sessionsFocusIndex).toBe(before);
    });

    it('DPadUp on group-header navigates to previous nav item (no reorder)', () => {
      // nav list: [group-header(0), session(1), session(2), session(3)]
      sessionsState.sessionsFocusIndex = 0; // group-header
      sessionsState.cardColumn = 0;
      sessions.handleSessionsScreenButton('DPadUp');
      // Should stay at index 0 — NOT trigger group reorder
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('DPadDown on group-header navigates to next nav item (no reorder)', () => {
      // nav list: [group-header(0), session(1), session(2), session(3)]
      sessionsState.sessionsFocusIndex = 0; // group-header
      sessionsState.cardColumn = 0;
      sessions.handleSessionsScreenButton('DPadDown');
      // Should navigate down to index 1 — NOT trigger group reorder
      expect(sessionsState.sessionsFocusIndex).toBe(1);
    });
  });

  // ==========================================================================
  // Navigation — spawn zone
  // ==========================================================================

  describe('Spawn zone navigation', () => {
    beforeEach(async () => {
      setMockTerminalSessions(makeSessions(2));
      mockConfigGetCliTypes.mockResolvedValue(['claude-code', 'copilot-cli', 'generic-terminal', 'powershell']);
      await loadAndFlush(sessions);

      // Navigate to spawn zone
      sessionsState.activeFocus = 'spawn';
      sessionsState.spawnFocusIndex = 0;
    });

    it('DPadDown moves spawnFocusIndex by 2 (columns)', () => {
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.spawnFocusIndex).toBe(2);
    });

    it('DPadDown does not go past last row', () => {
      sessionsState.spawnFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadDown');
      // 2 + 2 = 4, which is valid (4 items: 0,1,2,3) — no, 4 >= 4, so stays
      expect(sessionsState.spawnFocusIndex).toBe(2);
    });

    it('DPadUp moves spawnFocusIndex by -2', () => {
      sessionsState.spawnFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('DPadUp past top row switches to sessions zone', () => {
      sessionsState.spawnFocusIndex = 0;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.activeFocus).toBe('sessions');
      expect(sessionsState.sessionsFocusIndex).toBe(2);
    });

    it('DPadUp past top row from column 1 also switches to sessions zone', () => {
      sessionsState.spawnFocusIndex = 1;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.activeFocus).toBe('sessions');
      expect(sessionsState.sessionsFocusIndex).toBe(2);
    });

    it('DPadRight moves within row', () => {
      sessionsState.spawnFocusIndex = 0;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.spawnFocusIndex).toBe(1);
    });

    it('DPadRight does not go past column boundary', () => {
      sessionsState.spawnFocusIndex = 1;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.spawnFocusIndex).toBe(1);
    });

    it('DPadLeft moves within row', () => {
      sessionsState.spawnFocusIndex = 1;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('DPadLeft does not go past column 0', () => {
      sessionsState.spawnFocusIndex = 0;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('DPadLeft on second row col 0 stays put', () => {
      sessionsState.spawnFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.spawnFocusIndex).toBe(2);
    });

    it('DPadRight on second row moves within row', () => {
      sessionsState.spawnFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.spawnFocusIndex).toBe(3);
    });

    it('A on focused spawn button calls spawnNewSession', async () => {
      sessionsState.spawnFocusIndex = 0;
      sessions.handleSessionsScreenButton('A');
      await flush();

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.stringContaining('pty-claude-code-'),
        'claude-code',
        'claude',
        [],
        undefined,
        undefined,
        undefined,
      );
    });

    it('B returns to sessions zone', () => {
      sessions.handleSessionsScreenButton('B');
      expect(sessionsState.activeFocus).toBe('sessions');
    });

    it('Y falls through to config bindings from spawn zone', () => {
      expect(sessions.handleSessionsScreenButton('Y')).toBe(false);
    });

  });

  // ==========================================================================
  // Spawn zone — odd item count (2-col navigation edge case)
  // ==========================================================================

  describe('Spawn zone — odd item count', () => {
    beforeEach(async () => {
      mockConfigGetCliTypes.mockResolvedValue(['claude-code', 'copilot-cli', 'generic-terminal']);
      await loadAndFlush(sessions);

      sessionsState.activeFocus = 'spawn';
      sessionsState.spawnFocusIndex = 0;
    });

    it('DPadDown from row 0 col 0 → row 1 col 0 (index 2)', () => {
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.spawnFocusIndex).toBe(2);
    });

    it('DPadDown from row 0 col 1 stays put (no index 3)', () => {
      sessionsState.spawnFocusIndex = 1;
      sessions.handleSessionsScreenButton('DPadDown');
      // 1 + 2 = 3, which >= 3 items, so no move
      expect(sessionsState.spawnFocusIndex).toBe(1);
    });

    it('DPadRight from last item in second row (index 2) stays put (no index 3)', () => {
      sessionsState.spawnFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadRight');
      // 2 % 2 = 0, which < 1, BUT 2 + 1 = 3 >= count (3) → no move
      expect(sessionsState.spawnFocusIndex).toBe(2);
    });
  });

  // ==========================================================================
  // Actions — doSpawn
  // ==========================================================================

  describe('doSpawn', () => {
    it('creates embedded terminal via configGetSpawnCommand', async () => {
      mockConfigGetSpawnCommand.mockResolvedValue({ command: 'claude', args: [] });
      await sessions.doSpawn('claude-code');
      await flush();

      expect(mockConfigGetSpawnCommand).toHaveBeenCalledWith('claude-code');
      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.stringContaining('pty-claude-code-'),
        'claude-code',
        'claude',
        [],
        undefined,
        undefined,
        undefined,
      );
    });

    it('passes working directory to createTerminal', async () => {
      mockConfigGetSpawnCommand.mockResolvedValue({ command: 'claude', args: ['--flag'] });
      await sessions.doSpawn('claude-code', '/projects/a');
      await flush();

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.stringContaining('pty-claude-code-'),
        'claude-code',
        'claude',
        ['--flag'],
        '/projects/a',
        undefined,
        undefined,
      );
    });







    it('passes resumeSessionName to createTerminal', async () => {
      mockConfigGetSpawnCommand.mockResolvedValue({ command: 'claude', args: ['--resume'] });
      await sessions.doSpawn('claude-code', '/work', undefined, 'hub-my-session');
      await flush();

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.stringContaining('pty-claude-code-'),
        'claude-code',
        'claude',
        ['--resume'],
        '/work',
        undefined,
        'hub-my-session',
      );
    });

    it('passes undefined resumeSessionName when not provided', async () => {
      mockConfigGetSpawnCommand.mockResolvedValue({ command: 'claude', args: [] });
      await sessions.doSpawn('claude-code');
      await flush();

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.stringContaining('pty-claude-code-'),
        'claude-code',
        'claude',
        [],
        undefined,
        undefined,
        undefined,
      );
    });
  });

  // ==========================================================================
  // Actions — spawnNewSession
  // ==========================================================================

  describe('spawnNewSession', () => {
    it('calls doSpawn directly when no dirs and no bridge', async () => {
      mockConfigGetWorkingDirs.mockResolvedValue([]);

      await sessions.spawnNewSession('claude-code');
      await flush();

      expect(mockConfigGetSpawnCommand).toHaveBeenCalledWith('claude-code');
      expect(mockCreateTerminal).toHaveBeenCalled();
    });

    it('calls bridge when dirs exist and bridge is set', async () => {
      const mockBridge = vi.fn();
      sessions.setDirPickerBridge(mockBridge);

      mockConfigGetWorkingDirs.mockResolvedValue([
        { name: 'proj', path: '/proj' },
      ]);

      await sessions.spawnNewSession('claude-code');
      await flush();

      expect(mockBridge).toHaveBeenCalledWith('claude-code', [{ name: 'proj', path: '/proj' }], undefined);
      expect(mockCreateTerminal).not.toHaveBeenCalled();
    });

    it('calls doSpawn when dirs exist but no bridge', async () => {
      // Explicitly clear any bridge set by prior tests
      sessions.setDirPickerBridge(null as any);
      mockConfigGetWorkingDirs.mockResolvedValue([
        { name: 'proj', path: '/proj' },
      ]);

      await sessions.spawnNewSession('claude-code');
      await flush();

      expect(mockCreateTerminal).toHaveBeenCalled();
    });

    it('uses availableSpawnTypes[0] when no cliType provided', async () => {
      state.availableSpawnTypes = ['copilot-cli', 'claude-code'];
      mockConfigGetWorkingDirs.mockResolvedValue([]);
      mockConfigGetSpawnCommand.mockResolvedValue({ command: 'copilot', args: [] });

      await sessions.spawnNewSession();
      await flush();

      expect(mockConfigGetSpawnCommand).toHaveBeenCalledWith('copilot-cli');
    });

    it('falls back to generic-terminal when no cliType and no availableSpawnTypes', async () => {
      state.availableSpawnTypes = [];
      mockConfigGetWorkingDirs.mockResolvedValue([]);

      await sessions.spawnNewSession();
      await flush();

      expect(mockConfigGetSpawnCommand).toHaveBeenCalledWith('generic-terminal');
    });

  });

  // ==========================================================================
  // Actions — X button falls through to config bindings
  // ==========================================================================

  describe('X button (sessions zone)', () => {
    beforeEach(async () => {
      setMockTerminalSessions(makeSessions(3));
      await loadAndFlush(sessions);
    });

    it('X is not consumed — falls through to config bindings', () => {
      expect(sessions.handleSessionsScreenButton('X')).toBe(false);
      expect(mockSessionClose).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Keyboard fallback
  // ==========================================================================

  describe('Keyboard fallback', () => {
    beforeEach(async () => {
      setMockTerminalSessions(makeSessions(3));
      await loadAndFlush(sessions);
    });

    function pressKey(key: string): void {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    }

    it('ArrowDown maps to DPadDown', () => {
      pressKey('ArrowDown');
      expect(sessionsState.sessionsFocusIndex).toBe(1);
    });

    it('ArrowUp maps to DPadUp (stops at 0)', () => {
      pressKey('ArrowUp');
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('Enter maps to A (not consumed in sessions zone)', () => {
      pressKey('Enter');
      // A is no longer consumed in sessions zone — auto-select happens on D-pad
      expect(mockSwitchTo).not.toHaveBeenCalled();
    });

    it('stands down while a modal owns the keyboard', () => {
      modalOpenForTest = true;

      pressKey('ArrowDown');

      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('Escape maps to B (no-op on sessions zone)', () => {
      pressKey('Escape');
      expect(sessionsState.activeFocus).toBe('sessions');
    });

    it('Delete maps to X (falls through to config bindings)', () => {
      pressKey('Delete');
      // X no longer calls sessionClose directly — handled by config bindings
      expect(mockSessionClose).not.toHaveBeenCalled();
    });

    it('F5 maps to Y (falls through to config bindings)', () => {
      pressKey('F5');
      // Y no longer calls refreshSessions directly — handled by config bindings
      expect(mockLogEvent).not.toHaveBeenCalledWith('Sessions refreshed');
    });

    it('unmapped keys are ignored', () => {
      const before = sessionsState.sessionsFocusIndex;
      pressKey('Tab');
      expect(sessionsState.sessionsFocusIndex).toBe(before);
    });

    it('keyboard is ignored when the terminal pane holds focus', () => {
      focusedPaneForTest = 'terminal';
      const indexBefore = sessionsState.sessionsFocusIndex;

      pressKey('ArrowDown');

      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
    });

    it('ArrowDown past last session switches to spawn zone via keyboard', () => {
      sessionsState.sessionsFocusIndex = 4;
      pressKey('ArrowDown');
      expect(sessionsState.activeFocus).toBe('spawn');
    });

    it('ArrowLeft in spawn zone moves focus left', async () => {
      // Get into spawn zone
      sessionsState.activeFocus = 'spawn';
      sessionsState.spawnFocusIndex = 1;

      pressKey('ArrowLeft');
      expect(sessionsState.spawnFocusIndex).toBe(0);
    });

    it('ArrowRight in spawn zone moves focus right', async () => {
      sessionsState.activeFocus = 'spawn';
      sessionsState.spawnFocusIndex = 0;

      pressKey('ArrowRight');
      expect(sessionsState.spawnFocusIndex).toBe(1);
    });

    it('Escape in spawn zone returns to sessions zone', () => {
      sessionsState.activeFocus = 'spawn';
      pressKey('Escape');
      expect(sessionsState.activeFocus).toBe('sessions');
    });

    it('keyboard fallback is skipped when xterm has DOM focus', () => {
      // Simulate xterm.js having focus (user is typing in terminal)
      const xtermEl = document.createElement('div');
      xtermEl.className = 'xterm';
      const textarea = document.createElement('textarea');
      xtermEl.appendChild(textarea);
      document.body.appendChild(xtermEl);
      textarea.focus();

      const indexBefore = sessionsState.sessionsFocusIndex;
      pressKey('ArrowDown');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);

      // Cleanup
      document.body.removeChild(xtermEl);
    });

    it('keyboard fallback is skipped when an input element has DOM focus', () => {
      const input = document.createElement('input');
      input.className = 'session-rename-input';
      document.body.appendChild(input);
      input.focus();

      const indexBefore = sessionsState.sessionsFocusIndex;
      pressKey('Enter');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      pressKey('Escape');
      expect(sessionsState.activeFocus).toBe('sessions');

      document.body.removeChild(input);
    });

    it('keyboard fallback is skipped when a textarea has DOM focus', () => {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      const indexBefore = sessionsState.sessionsFocusIndex;
      pressKey('ArrowDown');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);

      document.body.removeChild(textarea);
    });
  });

  // ==========================================================================
  // Pre-focus active session on load
  // ==========================================================================

  describe('Pre-focus active session', () => {
    it('focuses the active session index on load', async () => {
      setMockTerminalSessions(makeSessions(3));
      state.activeSessionId = 's-2';

      await loadAndFlush(sessions);

      expect(sessionsState.sessionsFocusIndex).toBe(3);
    });

    it('defaults to 0 when no active session', async () => {
      setMockTerminalSessions(makeSessions(3));
      state.activeSessionId = null;

      await loadAndFlush(sessions);

      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('defaults to 0 when active session not found in list', async () => {
      setMockTerminalSessions(makeSessions(3));
      state.activeSessionId = 'nonexistent';

      await loadAndFlush(sessions);

      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });
  });

  // ==========================================================================
  // Focus clamping on reload
  // ==========================================================================

  describe('Focus clamping on reload', () => {
    it('clamps sessionsFocusIndex when sessions shrink', async () => {
      setMockTerminalSessions(makeSessions(5));
      await loadAndFlush(sessions);
      sessionsState.sessionsFocusIndex = 4;

      setMockTerminalSessions(makeSessions(2));
      await loadAndFlush(sessions);

      expect(sessionsState.sessionsFocusIndex).toBeLessThanOrEqual(3);
    });

    it('clamps spawnFocusIndex when CLI types shrink', async () => {
      mockConfigGetCliTypes.mockResolvedValue(['a', 'b', 'c', 'd']);
      await loadAndFlush(sessions);
      sessionsState.spawnFocusIndex = 3;

      mockConfigGetCliTypes.mockResolvedValue(['a']);
      await loadAndFlush(sessions);

      expect(sessionsState.spawnFocusIndex).toBe(0);
    });
  });

  // ==========================================================================
  // syncSessionHighlight
  // ==========================================================================

  describe('syncSessionHighlight', () => {
    it('updates session focus index to match session id', async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([
        { id: 'pty-claude-1', cliType: 'claude-code' },
        { id: 'pty-copilot-1', cliType: 'copilot-cli' },
      ]));
      await loadAndFlush(sessions);

      sessions.syncSessionHighlight('pty-copilot-1');

      expect(sessionsState.sessionsFocusIndex).toBe(2);
      expect(state.activeSessionId).toBe('pty-copilot-1');
    });

    it('does nothing for unknown session id', async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([
        { id: 'pty-claude-1', cliType: 'claude-code' },
      ]));
      await loadAndFlush(sessions);
      sessionsState.sessionsFocusIndex = 0;

      sessions.syncSessionHighlight('nonexistent');

      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('sets focus to first session when matching first id', async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([
        { id: 'pty-a', cliType: 'claude-code' },
        { id: 'pty-b', cliType: 'copilot-cli' },
        { id: 'pty-c', cliType: 'claude-code' },
      ]));
      await loadAndFlush(sessions);

      // Start at a different index
      sessionsState.sessionsFocusIndex = 2;
      sessions.syncSessionHighlight('pty-a');

      expect(sessionsState.sessionsFocusIndex).toBe(1);
      expect(state.activeSessionId).toBe('pty-a');
    });
  });

  // ==========================================================================
  // setDirPickerBridge
  // ==========================================================================

  describe('setDirPickerBridge', () => {
    it('sets the bridge function for spawnNewSession to use', async () => {
      const bridge = vi.fn();
      sessions.setDirPickerBridge(bridge);

      mockConfigGetWorkingDirs.mockResolvedValue([{ name: 'x', path: '/x' }]);
      await sessions.spawnNewSession('claude-code');
      await flush();

      expect(bridge).toHaveBeenCalledWith('claude-code', [{ name: 'x', path: '/x' }], undefined);
    });

    it('can be overwritten with a new bridge', async () => {
      const bridge1 = vi.fn();
      const bridge2 = vi.fn();
      sessions.setDirPickerBridge(bridge1);
      sessions.setDirPickerBridge(bridge2);

      mockConfigGetWorkingDirs.mockResolvedValue([{ name: 'x', path: '/x' }]);
      await sessions.spawnNewSession('claude-code');
      await flush();

      expect(bridge1).not.toHaveBeenCalled();
      expect(bridge2).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Session state management
  // ==========================================================================

  describe('session state management', () => {
    it('setSessionState changes the state returned by getSessionState', async () => {
      expect(sessions.getSessionState('s-0')).toBe('idle');
      sessions.setSessionState('s-0', 'implementing');
      await flush();
      expect(sessions.getSessionState('s-0')).toBe('implementing');
    });

    it('removeSessionState resets to idle', async () => {
      sessions.setSessionState('s-0', 'planning');
      await flush();
      expect(sessions.getSessionState('s-0')).toBe('planning');

      sessions.removeSessionState('s-0');
      expect(sessions.getSessionState('s-0')).toBe('idle');
    });

    it('setSessionState with same value does not trigger loadSessions', async () => {
      sessions.setSessionState('s-0', 'implementing');
      await flush();
      expect(sessions.getSessionState('s-0')).toBe('implementing');

      // Clear call counts after initial set
      mockSessionGetAll.mockClear();

      // Same state again — should be a no-op
      sessions.setSessionState('s-0', 'implementing');
      await flush();

      // sessionStore.load is called by loadSessionsData inside loadSessions;
      // if setSessionState was a no-op, sessionStore.load should not be called.
      expect(mockSessionGetAll).not.toHaveBeenCalled();

      sessions.removeSessionState('s-0');
    });

    it('setSessionState with different value does trigger loadSessions', async () => {
      sessions.setSessionState('s-0', 'implementing');
      await flush();

      mockSessionGetAll.mockClear();

      sessions.setSessionState('s-0', 'planning');
      await flush();

      expect(mockSessionGetAll).toHaveBeenCalled();
      expect(sessions.getSessionState('s-0')).toBe('planning');

      sessions.removeSessionState('s-0');
    });
  });

  // ==========================================================================
  // Horizontal card sub-navigation
  // ==========================================================================

  describe('horizontal card sub-navigation', () => {
    beforeEach(async () => {
      const data = makeSessions(3);
      mockSessionGetAll.mockResolvedValue(data);
      state.sessions = data;
      setMockTerminalSessions(data);
      await loadAndFlush(sessions);
      sessionsState.activeFocus = 'sessions';
      sessionsState.sessionsFocusIndex = 1;
      sessionsState.cardColumn = 0;
    });

    it('RIGHT moves cardColumn from 0 to 1', () => {
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.cardColumn).toBe(1);
    });

    it('RIGHT moves cardColumn from 1 to 2', () => {
      sessionsState.cardColumn = 1;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.cardColumn).toBe(2);
    });

    it('RIGHT reaches the lock toggle at column 5', () => {
      sessionsState.cardColumn = 4;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.cardColumn).toBe(5);
    });

    it('RIGHT does not exceed 5', () => {
      sessionsState.cardColumn = 5;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.cardColumn).toBe(5);
    });

    it('LEFT moves cardColumn from 2 to 1', () => {
      sessionsState.cardColumn = 2;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.cardColumn).toBe(1);
    });

    it('LEFT moves cardColumn from 1 to 0', () => {
      sessionsState.cardColumn = 1;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.cardColumn).toBe(0);
    });

    it('LEFT does not go below 0', () => {
      sessionsState.cardColumn = 0;
      sessions.handleSessionsScreenButton('DPadLeft');
      expect(sessionsState.cardColumn).toBe(0);
    });

    it('UP/DOWN at col=1 is no-op', () => {
      sessionsState.cardColumn = 1;
      const indexBefore = sessionsState.sessionsFocusIndex;
      const stateBefore = sessions.getSessionState('s-0');
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      expect(sessionsState.cardColumn).toBe(1);
      expect(sessions.getSessionState('s-0')).toBe(stateBefore);
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      expect(sessionsState.cardColumn).toBe(1);
      expect(sessions.getSessionState('s-0')).toBe(stateBefore);
    });

    it('B at cardColumn > 0 goes back one column', () => {
      sessionsState.cardColumn = 2;
      const consumed = sessions.handleSessionsScreenButton('B');
      expect(consumed).toBe(true);
      expect(sessionsState.cardColumn).toBe(1);
    });

    it('B at cardColumn 0 falls through', () => {
      sessionsState.cardColumn = 0;
      const consumed = sessions.handleSessionsScreenButton('B');
      expect(consumed).toBe(false);
    });

    it('cardColumn resets to 0 on vertical card switch (DOWN)', () => {
      sessionsState.cardColumn = 0;
      sessionsState.sessionsFocusIndex = 2;
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.cardColumn).toBe(0);
      expect(sessionsState.sessionsFocusIndex).toBe(3);
    });

    it('cardColumn resets to 0 on zone switch to spawn', () => {
      sessionsState.cardColumn = 0;
      sessionsState.sessionsFocusIndex = 3; // last navList item
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.activeFocus).toBe('spawn');
      expect(sessionsState.cardColumn).toBe(0);
    });

    it('A at col=4 triggers close confirm modal', async () => {
      sessionsState.cardColumn = 4;
      sessions.handleSessionsScreenButton('A');
      await flush();
      expect(mockCloseConfirm.sessionId).toBe('s-0');
      expect(mockSetCloseConfirmCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('A at col=4 close confirm callback closes the session via IPC', async () => {
      sessionsState.cardColumn = 4;
      sessions.handleSessionsScreenButton('A');
      await flush();
      // Extract the onConfirm callback and invoke it
      const onConfirm = mockSetCloseConfirmCallback.mock.calls[0][0];
      await onConfirm('s-0');
      await flush();
      expect(mockSessionClose).toHaveBeenCalledWith('s-0');
      expect(mockDestroyTerminal).not.toHaveBeenCalledWith('s-0');
    });

    it('A at col=2 triggers rename for focused session', () => {
      sessionsState.cardColumn = 2;
      const result = sessions.handleSessionsScreenButton('A');
      expect(result).toBe(true);
      expect(sessionsState.editingSessionId).toBe('s-0');
    });

    it('A at col=1 dispatches open-state-dropdown on the focused session card', () => {
      const card = document.createElement('div');
      card.className = 'session-card';
      card.dataset.sessionId = 's-0';
      document.body.appendChild(card);

      let eventDispatched = false;
      card.addEventListener('open-state-dropdown', () => { eventDispatched = true; });

      sessionsState.cardColumn = 1;
      const result = sessions.handleSessionsScreenButton('A');

      expect(result).toBe(true);
      expect(eventDispatched).toBe(true);
      card.remove();
    });

    it('A in the state dropdown selects the focused option', async () => {
      const dropdown = document.createElement('div');
      dropdown.className = 'session-state-dropdown';
      const idle = document.createElement('button');
      idle.className = 'session-state-option active';
      idle.textContent = 'Idle';
      const planning = document.createElement('button');
      planning.className = 'session-state-option dropdown-focused';
      planning.textContent = 'Planning';
      const onPlanningClick = vi.fn();
      planning.addEventListener('click', onPlanningClick);
      dropdown.append(idle, planning);
      document.body.appendChild(dropdown);

      const result = sessions.handleSessionsScreenButton('A');

      expect(result).toBe(true);
      await flush();
      expect(onPlanningClick).toHaveBeenCalled();
      dropdown.remove();
    });

    it('A on the eye toggle persists overviewHidden changes', async () => {
      mockSessionGetAll.mockResolvedValueOnce([{ ...makeSessions(1)[0], cliSessionName: 'cli-0' }]);
      sessionsState.sessionsFocusIndex = 1;
      sessionsState.cardColumn = 3;
      await loadAndFlush(sessions);

      const result = sessions.handleSessionsScreenButton('A');

      expect(result).toBe(true);
      expect(mockConfigSetSessionGroupPrefs).toHaveBeenCalled();
      expect(mockConfigSetSessionGroupPrefs.mock.calls.at(-1)?.[0]).toMatchObject({
        overviewHidden: ['cli-0'],
      });
    });

    it('setSessionPreviewMode persists the preview mode with the group prefs', async () => {
      await sessions.setSessionPreviewMode('selected-only');

      expect(sessionsState.groupPrefs.sessionPreviewMode).toBe('selected-only');
      expect(mockConfigSetSessionGroupPrefs.mock.calls.at(-1)?.[0]).toMatchObject({
        sessionPreviewMode: 'selected-only',
      });
    });

    it('getTabCycleSessionIds excludes overview-hidden sessions from Ctrl+Tab order', async () => {
      const data = [
        { ...makeSessions(1)[0], id: 's-0', cliSessionName: 'cli-0' },
        { ...makeSessions(1)[0], id: 's-1', name: 'Session 1', cliSessionName: 'cli-1' },
      ];
      mockSessionGetAll.mockResolvedValue(data);
      setMockTerminalSessions(data as any);
      sessionsState.groupPrefs.overviewHidden = ['cli-0'];

      await loadAndFlush(sessions);

      expect(sessions.getTabCycleSessionIds()).toEqual(['s-1']);
    });

    it('UP/DOWN at col=2 is no-op', () => {
      sessionsState.cardColumn = 2;
      const indexBefore = sessionsState.sessionsFocusIndex;
      sessions.handleSessionsScreenButton('DPadUp');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      expect(sessionsState.cardColumn).toBe(2);
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      expect(sessionsState.cardColumn).toBe(2);
    });

    it('no horizontal nav when session list is empty', async () => {
      state.sessions = [];
      mockSessionGetAll.mockResolvedValue([]);
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([]));
      await loadAndFlush(sessions);
      sessionsState.cardColumn = 0;
      sessions.handleSessionsScreenButton('DPadRight');
      expect(sessionsState.cardColumn).toBe(0);
    });
  });

  // ==========================================================================
  // Gamepad rename mode (A=commit, B=cancel, D-pad=caret)
  // ==========================================================================

  describe('gamepad rename mode', () => {
    beforeEach(async () => {
      sessions.setTerminalManagerGetter(() => createMockTerminalManager([
        { id: 's-0', cliType: 'claude-code', name: 'Alpha' },
        { id: 's-1', cliType: 'copilot-cli', name: 'Bravo' },
      ]));
      await loadAndFlush(sessions);
      sessionsState.activeFocus = 'sessions';
      sessionsState.sessionsFocusIndex = 1; // first session card
    });

    function enterRenameMode(renderInsideCard = false): HTMLInputElement {
      sessionsState.editingSessionId = 's-0';
      // Create the input manually since Vue owns the row rendering in these tests.
      const input = document.createElement('input');
      input.className = 'session-rename-input';
      input.type = 'text';
      input.value = 'Alpha';
      if (renderInsideCard) {
        const card = document.createElement('div');
        card.className = 'session-card';
        card.dataset.sessionId = 's-0';
        card.appendChild(input);
        document.body.appendChild(card);
      } else {
        document.body.appendChild(input);
      }
      return input;
    }

    it('A button commits rename when editing', async () => {
      const input = enterRenameMode();
      input.value = 'NewName';
      const result = sessions.handleSessionsScreenButton('A');
      expect(result).toBe(true);
      await flush();
      expect((window as any).gamepadCli.sessionRename).toHaveBeenCalledWith('s-0', 'NewName');
      input.remove();
    });

    it('A button commits rename from the inline editing row', async () => {
      const input = enterRenameMode(true);
      input.value = 'InlineName';
      const result = sessions.handleSessionsScreenButton('A');
      expect(result).toBe(true);
      await flush();
      expect((window as any).gamepadCli.sessionRename).toHaveBeenCalledWith('s-0', 'InlineName');
      input.closest('.session-card')?.remove();
    });

    it('B button cancels rename when editing', () => {
      const input = enterRenameMode();
      const result = sessions.handleSessionsScreenButton('B');
      expect(result).toBe(true);
      expect(sessionsState.editingSessionId).toBeNull();
      expect((window as any).gamepadCli.sessionRename).not.toHaveBeenCalled();
      input.remove();
    });

    it('D-pad Left moves caret left', () => {
      const input = enterRenameMode();
      input.setSelectionRange(3, 3);
      const result = sessions.handleSessionsScreenButton('DPadLeft');
      expect(result).toBe(true);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(2);
      input.remove();
    });

    it('D-pad Right moves caret right', () => {
      const input = enterRenameMode();
      input.setSelectionRange(2, 2);
      const result = sessions.handleSessionsScreenButton('DPadRight');
      expect(result).toBe(true);
      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(3);
      input.remove();
    });

    it('D-pad Up/Down consumed during rename', () => {
      const input = enterRenameMode();
      const indexBefore = sessionsState.sessionsFocusIndex;
      expect(sessions.handleSessionsScreenButton('DPadUp')).toBe(true);
      expect(sessions.handleSessionsScreenButton('DPadDown')).toBe(true);
      expect(sessionsState.sessionsFocusIndex).toBe(indexBefore);
      input.remove();
    });

    it('other buttons consumed during rename', () => {
      const input = enterRenameMode();
      expect(sessions.handleSessionsScreenButton('X')).toBe(true);
      expect(sessions.handleSessionsScreenButton('Y')).toBe(true);
      expect(sessions.handleSessionsScreenButton('LeftBumper')).toBe(true);
      input.remove();
    });

  });

  describe('updateSessionsFocus', () => {
    it('scrolls the focused rendered session item into view without mutating focus classes', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      const list = document.getElementById('sessionsList')!;
      list.innerHTML = `
        <div class="group-header" data-nav-index="1"></div>
        <div class="session-card" data-nav-index="2">
          <button class="session-state-btn"></button>
          <button class="session-rename"></button>
          <button class="session-overview-toggle"></button>
          <button class="session-close"></button>
        </div>
      `;

      sessionsState.activeFocus = 'sessions';
      sessionsState.sessionsFocusIndex = 2;
      sessionsState.cardColumn = 4;

      sessions.updateSessionsFocus();

      const card = list.querySelector('.session-card') as HTMLElement;
      const closeBtn = list.querySelector('.session-close') as HTMLElement;
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(card.classList.contains('focused')).toBe(false);
      expect(closeBtn.classList.contains('card-col-focused')).toBe(false);
    });

    it('does not scroll when sessions are not the active focus zone', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      const list = document.getElementById('sessionsList')!;
      list.innerHTML = `<div class="session-card" data-nav-index="2"></div>`;

      sessionsState.activeFocus = 'spawn';
      sessionsState.sessionsFocusIndex = 2;

      sessions.updateSessionsFocus();

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

});
