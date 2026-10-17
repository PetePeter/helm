/**
 * Sessions plans grid — navigation zone below spawn grid.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE vi.mock() calls so hoisted references resolve
// ---------------------------------------------------------------------------

const mockConfigGetWorkingDirs = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
const mockPlanStartableForDir = vi.fn<(dir: string) => Promise<any[]>>().mockResolvedValue([]);
const mockPlanList = vi.fn<(dir: string) => Promise<any[]>>().mockResolvedValue([]);
let planChangedHandler: ((dirPath: string) => void) | null = null;
const mockShowPlanScreen = vi.fn();
const mockOpenPlan = vi.fn();

const mockLogEvent = vi.fn();
const mockGetCliDisplayName = vi.fn((type: string) => type || 'Unknown');

vi.mock('../renderer/utils.js', () => {
  const dirMap: Record<string, string> = {
    DPadUp: 'up',
    DPadDown: 'down',
    DPadLeft: 'left',
    DPadRight: 'right',
  };
  return {
    logEvent: mockLogEvent,
    getCliDisplayName: mockGetCliDisplayName,
    toDirection: (button: string) => dirMap[button] ?? null,
  };
});

vi.mock('../renderer/modals/close-confirm.js', () => ({
  showCloseConfirm: vi.fn(),
}));

vi.mock('../renderer/plans/plan-screen.js', () => ({
  showPlanScreen: mockShowPlanScreen,
}));

vi.mock('../renderer/stores/navigation.js', () => ({
  useNavigationStore: () => ({
    openPlan: mockOpenPlan,
    onNavListRebuilt: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// State mock for refreshPlanBadges tests
// ---------------------------------------------------------------------------

const mockState = {
  planDirStartableCounts: new Map<string, number>(),
  planDirCodingCounts: new Map<string, number>(),
  planDirBlockedCounts: new Map<string, number>(),
  planDirReviewCounts: new Map<string, number>(),
  planDirPlanningCounts: new Map<string, number>(),
};

vi.mock('../renderer/state.js', () => ({
  state: mockState,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDom(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }

  document.body.innerHTML = `
    <section id="screen-sessions" class="screen screen--active">
      <div class="sessions-list" id="sessionsList"></div>
      <div class="sessions-empty" id="sessionsEmpty" style="display:none">
        No active sessions
      </div>
      <div class="spawn-section">
        <h3 class="section-label">Quick Spawn</h3>
        <div class="spawn-grid" id="spawnGrid"></div>
      </div>
      <div id="plansGridSection" class="spawn-section">
        <div class="section-label">Project Planner</div>
        <div id="plansGrid" class="spawn-grid"></div>
      </div>
    </section>
    <div id="mainArea">
      <div id="terminalContainer"></div>
    </div>
    <div id="panelSplitter"></div>
    <p id="statusTotalSessions">0</p>
    <p id="statusActiveSessions">0</p>
  `;
}

async function getSessionsState() {
  return (await import('../renderer/screens/sessions-state.js')).sessionsState;
}

async function getPlans() {
  return await import('../renderer/screens/sessions-plans.js');
}

async function getSessions() {
  return await import('../renderer/screens/sessions.js');
}

/** Flush the microtask queue so async fire-and-forget calls complete. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Sessions Plans Grid', () => {
  let sessionsState: Awaited<ReturnType<typeof getSessionsState>>;
  let plans: Awaited<ReturnType<typeof getPlans>>;
  let sessions: Awaited<ReturnType<typeof getSessions>>;

  const testDirs = [
    { name: 'project-a', path: '/projects/a' },
    { name: 'project-b', path: '/projects/b' },
    { name: 'project-c', path: '/projects/c' },
    { name: 'project-d', path: '/projects/d' },
  ];

  beforeEach(async () => {
    vi.useFakeTimers();
    buildDom();

    (window as any).sessionStore = {
      load: vi.fn().mockResolvedValue([]),
    };
    (window as any).gamepadCli = {
      sessionSetActive: vi.fn().mockResolvedValue(undefined),
      sessionClose: vi.fn().mockResolvedValue({ success: true }),
      sessionRename: vi.fn().mockResolvedValue({ success: true }),
      configGetCliTypes: vi.fn().mockResolvedValue(['claude-code']),
      configGetWorkingDirs: mockConfigGetWorkingDirs,
      configGetSpawnCommand: vi.fn().mockResolvedValue({ command: 'claude', args: [] }),
      configGetSessionGroupPrefs: vi.fn().mockResolvedValue({ order: [], collapsed: [] }),
      configSetSessionGroupPrefs: vi.fn().mockResolvedValue({ success: true }),
      configGetSortPrefs: vi.fn().mockResolvedValue({ field: 'state', direction: 'asc' }),
      configSetSortPrefs: vi.fn().mockResolvedValue(undefined),
      planStartableForDir: mockPlanStartableForDir,
      planList: mockPlanList,
      onPlanChanged: vi.fn((callback: (dirPath: string) => void) => {
        planChangedHandler = callback;
        return vi.fn();
      }),
    };

    mockConfigGetWorkingDirs.mockResolvedValue(testDirs);
    mockPlanStartableForDir.mockResolvedValue([]);
    mockPlanList.mockResolvedValue([]);
    planChangedHandler = null;

    sessionsState = await getSessionsState();
    plans = await getPlans();
    sessions = await getSessions();

    // Set up terminal manager so loadSessions works
    sessions.setTerminalManagerGetter(() => ({
      getSessionIds: () => [],
      getSession: () => undefined,
      getActiveSessionId: () => null,
      hasTerminal: () => false,
      switchTo: vi.fn(),
      focusActive: vi.fn(),
      fitActive: vi.fn(),
      createTerminal: vi.fn().mockResolvedValue(true),
      destroyTerminal: vi.fn(),
      renameSession: vi.fn(),
    }) as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    sessions.setTerminalManagerGetter(null as any);
    Object.assign(sessionsState, {
      activeFocus: 'sessions',
      sessionsFocusIndex: 0,
      spawnFocusIndex: 0,
      cardColumn: 0,
      cliTypes: [],
      directories: [],
      editingSessionId: null,
      // navList/groups derive from state.sessions — nothing to reset here.
      groupPrefs: { order: [], collapsed: [], bookmarked: [] },
      plansFocusIndex: 0,
    });
    document.body.innerHTML = '';
  });

  // ==========================================================================
  // D-pad navigation
  // ==========================================================================

  describe('handlePlansZone', () => {
    beforeEach(() => {
      sessionsState.directories = testDirs;
      sessionsState.activeFocus = 'plans';
      sessionsState.plansFocusIndex = 0;
    });

    it('D-pad Down from first row moves to second row', () => {
      plans.handlePlansZone('DPadDown', 'down');
      expect(sessionsState.plansFocusIndex).toBe(2);
    });

    it('D-pad Down from last row does not move', () => {
      sessionsState.plansFocusIndex = 2;
      plans.handlePlansZone('DPadDown', 'down');
      // With 4 items, index 2 + 2 = 4 which equals total, no-op
      expect(sessionsState.plansFocusIndex).toBe(2);
    });

    it('D-pad Up from first row switches to spawn zone', () => {
      sessionsState.cliTypes = ['claude-code', 'copilot-cli'];
      sessionsState.plansFocusIndex = 0;
      plans.handlePlansZone('DPadUp', 'up');
      expect(sessionsState.activeFocus).toBe('spawn');
      expect(sessionsState.spawnFocusIndex).toBe(1); // last spawn item
    });

    it('D-pad Up from second row moves to first row', () => {
      sessionsState.plansFocusIndex = 2;
      plans.handlePlansZone('DPadUp', 'up');
      expect(sessionsState.plansFocusIndex).toBe(0);
    });

    it('D-pad Left navigates columns', () => {
      sessionsState.plansFocusIndex = 1;
      plans.handlePlansZone('DPadLeft', 'left');
      expect(sessionsState.plansFocusIndex).toBe(0);
    });

    it('D-pad Left at column 0 does not move', () => {
      sessionsState.plansFocusIndex = 0;
      plans.handlePlansZone('DPadLeft', 'left');
      expect(sessionsState.plansFocusIndex).toBe(0);
    });

    it('D-pad Right navigates columns', () => {
      sessionsState.plansFocusIndex = 0;
      plans.handlePlansZone('DPadRight', 'right');
      expect(sessionsState.plansFocusIndex).toBe(1);
    });

    it('D-pad Right at last column does not move', () => {
      sessionsState.plansFocusIndex = 1;
      plans.handlePlansZone('DPadRight', 'right');
      expect(sessionsState.plansFocusIndex).toBe(1);
    });

    it('navigates the project-collapsed planner list', () => {
      sessionsState.directories = [
        { name: 'repo', path: '/repo', projectId: 'p1', projectName: 'Repo', isCanonical: true },
        { name: 'repo app', path: '/repo/app', projectId: 'p1', projectName: 'Repo' },
        { name: 'other', path: '/other', projectId: 'p2', projectName: 'Other', isCanonical: true },
      ];
      sessionsState.plansFocusIndex = 0;

      plans.handlePlansZone('DPadRight', 'right');
      expect(sessionsState.plansFocusIndex).toBe(1);
      plans.handlePlansZone('DPadDown', 'down');
      expect(sessionsState.plansFocusIndex).toBe(1);
    });
  });

  // ==========================================================================
  // Button actions
  // ==========================================================================

  describe('handlePlansZoneButton', () => {
    beforeEach(() => {
      sessionsState.directories = testDirs;
      sessionsState.activeFocus = 'plans';
      sessionsState.plansFocusIndex = 0;
    });

    it('A button opens plan screen for focused folder', async () => {
      const consumed = plans.handlePlansZoneButton('A');
      expect(consumed).toBe(true);
      // Wait for dynamic import to resolve
      await flush();
      expect(mockOpenPlan).toHaveBeenCalledWith('/projects/a');
    });

    it('A button opens the canonical folder for a project group', async () => {
      sessionsState.directories = [
        { name: 'repo app', path: '/repo/app', projectId: 'p1', projectName: 'Repo' },
        { name: 'repo', path: '/repo', projectId: 'p1', projectName: 'Repo', isCanonical: true },
      ];

      const consumed = plans.handlePlansZoneButton('A');
      expect(consumed).toBe(true);
      await flush();
      expect(mockOpenPlan).toHaveBeenCalledWith('/repo');
    });

    it('B button returns to sessions zone', () => {
      const consumed = plans.handlePlansZoneButton('B');
      expect(consumed).toBe(true);
      expect(sessionsState.activeFocus).toBe('sessions');
    });

    it('other buttons are not consumed', () => {
      const consumed = plans.handlePlansZoneButton('X');
      expect(consumed).toBe(false);
    });
  });

  // ==========================================================================
  // Focus update
  // ==========================================================================

  describe('updatePlansFocus', () => {
    beforeEach(() => {
      sessionsState.directories = testDirs;
      // Vue owns the DOM, so tests create the buttons that PlansGrid.vue would
      // render to allow updatePlansFocus() to toggle .focused classes.
      const grid = document.getElementById('plansGrid')!;
      grid.innerHTML = '';
      testDirs.forEach((dir, i) => {
        const btn = document.createElement('button');
        btn.className = 'spawn-btn plans-grid-btn';
        btn.dataset.dir = dir.path;
        grid.appendChild(btn);
      });
    });

    it('highlights correct button when plans zone is active', () => {
      sessionsState.activeFocus = 'plans';
      sessionsState.plansFocusIndex = 1;
      plans.updatePlansFocus();

      const grid = document.getElementById('plansGrid')!;
      const btns = grid.querySelectorAll('.plans-grid-btn');
      expect(btns[0].classList.contains('focused')).toBe(false);
      expect(btns[1].classList.contains('focused')).toBe(true);
      expect(btns[2].classList.contains('focused')).toBe(false);
    });

    it('removes highlight when plans zone is not active', () => {
      sessionsState.activeFocus = 'sessions';
      sessionsState.plansFocusIndex = 0;
      plans.updatePlansFocus();

      const grid = document.getElementById('plansGrid')!;
      const btns = grid.querySelectorAll('.plans-grid-btn');
      for (const btn of btns) {
        expect(btn.classList.contains('focused')).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Integration: spawn zone D-pad Down → plans zone
  // ==========================================================================

  describe('spawn-to-plans zone transition', () => {
    it('D-pad Down past spawn grid transitions to plans zone', async () => {
      // Load sessions to populate spawn grid
      await sessions.loadSessions();
      await flush();

      sessionsState.activeFocus = 'spawn';
      sessionsState.spawnFocusIndex = 0;
      sessionsState.cliTypes = ['claude-code'];

      // D-pad Down should transition to plans since only 1 spawn button
      sessions.handleSessionsScreenButton('DPadDown');
      expect(sessionsState.activeFocus).toBe('plans');
      expect(sessionsState.plansFocusIndex).toBe(0);
    });
  });

  // ==========================================================================
  // refreshPlanBadges — reactive state updates
  // ==========================================================================

  describe('refreshPlanBadges', () => {
    beforeEach(() => {
      mockState.planDirStartableCounts.clear();
      mockState.planDirCodingCounts.clear();
      mockState.planDirBlockedCounts.clear();
      mockState.planDirReviewCounts.clear();
      mockState.planDirPlanningCounts.clear();
    });

    it('populates all 4 counts from planList and planStartableForDir', async () => {
      sessionsState.directories = [{ name: 'proj', path: '/proj' }];
      mockPlanStartableForDir.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      mockPlanList.mockResolvedValue([
        { status: 'coding' },
        { status: 'coding' },
        { status: 'blocked' },
        { status: 'blocked' },
        { status: 'planning' },
        { status: 'planning' },
        { status: 'review' },
      ]);

      await plans.refreshPlanBadges();

      expect(mockState.planDirStartableCounts.get('/proj')).toBe(2);
      expect(mockState.planDirCodingCounts.get('/proj')).toBe(2);
      expect(mockState.planDirBlockedCounts.get('/proj')).toBe(2);
      expect(mockState.planDirReviewCounts.get('/proj')).toBe(1);
      expect(mockState.planDirPlanningCounts.get('/proj')).toBe(2);
    });

    it('sets all counts to 0 when planList returns empty', async () => {
      sessionsState.directories = [{ name: 'proj', path: '/proj' }];
      mockPlanStartableForDir.mockResolvedValue([]);
      mockPlanList.mockResolvedValue([]);

      await plans.refreshPlanBadges();

      expect(mockState.planDirStartableCounts.get('/proj')).toBe(0);
      expect(mockState.planDirCodingCounts.get('/proj')).toBe(0);
      expect(mockState.planDirBlockedCounts.get('/proj')).toBe(0);
      expect(mockState.planDirReviewCounts.get('/proj')).toBe(0);
      expect(mockState.planDirPlanningCounts.get('/proj')).toBe(0);
    });

    it('populates counts for each directory independently', async () => {
      sessionsState.directories = [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b' },
      ];
      mockPlanStartableForDir.mockImplementation(async (dir: string) =>
        dir === '/a' ? [{ id: '1' }] : []
      );
      mockPlanList.mockImplementation(async (dir: string) =>
        dir === '/a' ? [{ status: 'coding' }] : [{ status: 'blocked' }, { status: 'blocked' }]
      );

      await plans.refreshPlanBadges();

      expect(mockState.planDirStartableCounts.get('/a')).toBe(1);
      expect(mockState.planDirCodingCounts.get('/a')).toBe(1);
      expect(mockState.planDirStartableCounts.get('/b')).toBe(0);
      expect(mockState.planDirBlockedCounts.get('/b')).toBe(2);
    });

    it('skips silently when gamepadCli is unavailable', async () => {
      sessionsState.directories = [{ name: 'proj', path: '/proj' }];
      const saved = (window as any).gamepadCli;
      (window as any).gamepadCli = undefined;

      await expect(plans.refreshPlanBadges()).resolves.toBeUndefined();
      expect(mockState.planDirStartableCounts.size).toBe(0);

      (window as any).gamepadCli = saved;
    });
  });
});
