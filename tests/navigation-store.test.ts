// @vitest-environment jsdom

/**
 * Navigation store — unit tests.
 *
 * Tests cover:
 *   - panelView mirrors main-view-manager via onViewChange
 *   - Identity-based focus resolution + navList rebuild survival
 *   - navigateToSession — full UX transition
 *   - activateSession — thin preview
 *   - Overlay lifecycle (overview, plan, settings)
 *   - Overlay chaining (overview → plan, plan → overview)
 *   - Edge cases (missing session, empty navList, double-close)
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';

// ── Mocks ──────────────────────────────────────────────────────────────

// main-view-manager — the DOM transition engine
let viewChangeListeners: Array<(view: string) => void> = [];
let currentMvmView = 'terminal';

vi.mock('../renderer/main-view/main-view-manager.js', () => ({
  showView: vi.fn(async (view: string, _params?: unknown) => {
    currentMvmView = view;
    for (const cb of viewChangeListeners) cb(view);
  }),
  onViewChange: vi.fn((cb: (view: string) => void) => {
    viewChangeListeners.push(cb);
    return () => {
      viewChangeListeners = viewChangeListeners.filter(l => l !== cb);
    };
  }),
  currentView: vi.fn(() => currentMvmView),
}));

// terminal provider
const mockTm = {
  hasTerminal: vi.fn(() => true),
  switchTo: vi.fn(),
  deselect: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  ensureTerminal: vi.fn(),
};

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  getTerminalManager: vi.fn(() => mockTm),
}));

// session-groups — real builders (the nav list is derived from them now); only
// the lookup helper is spied so call counts stay observable.
vi.mock('../renderer/session-groups.js', async (importActual) => ({
  ...(await importActual<typeof import('../renderer/session-groups.js')>()),
  findNavIndexBySessionId: vi.fn((navList: Array<{ type: string; id: string }>, sessionId: string) => {
    return navList.findIndex(item => item.type === 'session-card' && item.id === sessionId);
  }),
}));

// Dynamic imports — draft-editor, editor-popup, chip-bar, group-overview
const {
  mockHideDraftEditor,
  mockHideEditorPopup,
  mockChipBarClear,
  mockChipBarRefresh,
  mockSetSelectedOnExit,
  mockHideOverview,
  mockSessionSetActive,
} = vi.hoisted(() => ({
  mockHideDraftEditor: vi.fn(),
  mockHideEditorPopup: vi.fn(),
  mockChipBarClear: vi.fn(),
  mockChipBarRefresh: vi.fn(),
  mockSetSelectedOnExit: vi.fn(),
  mockHideOverview: vi.fn(),
  mockSessionSetActive: vi.fn(),
}));

vi.mock('../renderer/stores/draft-editor-registry.js', () => ({
  hideDraftEditor: mockHideDraftEditor,
  showDraftEditor: vi.fn(),
  showPlanInEditor: vi.fn(),
}));

vi.mock('../renderer/editor/editor-popup.js', () => ({
  hideEditorPopup: mockHideEditorPopup,
}));

vi.mock('../renderer/stores/chip-bar.js', () => ({
  useChipBarStore: vi.fn(() => ({
    clear: mockChipBarClear,
    refresh: mockChipBarRefresh,
  })),
}));

vi.mock('../renderer/screens/group-overview.js', () => ({
  setSelectedOnExit: mockSetSelectedOnExit,
  hideOverview: mockHideOverview,
}));

vi.mock('../renderer/plans/plan-screen.js', () => ({
  hidePlanScreen: vi.fn(),
  isPlanScreenVisible: vi.fn(() => false),
  handlePlanScreenDpad: vi.fn(),
  handlePlanScreenAction: vi.fn(() => false),
  onPlanAddDependency: vi.fn(),
  onPlanAddNode: vi.fn(),
  onPlanCleanup: vi.fn(),
  onPlanExportDirectory: vi.fn(),
  onPlanNodeApply: vi.fn(),
  onPlanNodeClick: vi.fn(),
  onPlanNodeComplete: vi.fn(),
  onPlanNodeDelete: vi.fn(),
  onPlanNodeEdit: vi.fn(),
  onPlanRemoveDependency: vi.fn(),
  planScreenState: { visible: false },
  getCurrentPlanDirPath: vi.fn(() => null),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { useNavigationStore } from '../renderer/stores/navigation.js';
import { state } from '../renderer/state.js';
import { sessionsState } from '../renderer/screens/sessions-state.js';
import { showView, currentView } from '../renderer/main-view/main-view-manager.js';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Seed real session state so the derived nav list takes the requested shape.
 *
 * Group headers become directories (bookmarked, so empty ones still render);
 * session cards become sessions inside the directory that precedes them. The
 * nav list is a derivation now, so it cannot be assigned directly.
 */
function buildNavList(...items: Array<{ type: string; id: string }>): void {
  const sessions: any[] = [];
  const dirs: string[] = [];
  let dir = '/a';
  for (const item of items) {
    if (item.type === 'group-header') dir = item.id;
    if (!dirs.includes(dir)) dirs.push(dir);
    if (item.type === 'session-card') {
      sessions.push({ id: item.id, name: item.id, cliType: 'claude', processId: 0, workingDir: dir });
    }
  }
  sessionsState.groupPrefs = { order: [...dirs], collapsed: [], overviewHidden: [], bookmarked: [...dirs] };
  state.sessions = sessions;
}

/** Position of a nav item in the derived list. */
function navIndex(type: string, id: string): number {
  return sessionsState.navList.findIndex(item => item.type === type && item.id === id);
}

function resetSingletons(): void {
  state.currentScreen = 'sessions';
  state.activeSessionId = null;
  state.recentSessionId = null;
  state.lastSelectedSessionId = null;
  state.sessions = [];
  state.snappedOutSessions.clear();
  sessionsState.sessionsFocusIndex = 0;
  sessionsState.cardColumn = 0;
  sessionsState.activeFocus = 'sessions';
  sessionsState.groupPrefs = { order: [], collapsed: [], overviewHidden: [], bookmarked: [] };
  sessionsState.overviewGroup = null;
  sessionsState.overviewIsGlobal = false;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('useNavigationStore', () => {
  let store: ReturnType<typeof useNavigationStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    currentMvmView = 'terminal';
    viewChangeListeners = [];
    resetSingletons();
    vi.clearAllMocks();
    mockTm.hasTerminal.mockReturnValue(true);
    (window as any).gamepadCli = {
      sessionSetActive: mockSessionSetActive,
    };
    store = useNavigationStore();
  });

  afterEach(() => {
    store.__dispose();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Initialization + panelView mirroring
  // ──────────────────────────────────────────────────────────────────────

  describe('init', () => {
    it('registers onViewChange listener', () => {
      store.init();
      expect(viewChangeListeners).toHaveLength(1);
    });

    it('is idempotent — second call does nothing', () => {
      store.init();
      store.init();
      expect(viewChangeListeners).toHaveLength(1);
    });

    it('seeds focusedNavItem from current sessionsState', () => {
      buildNavList(
        { type: 'group-header', id: '/projects' },
        { type: 'session-card', id: 'sess-1' },
      );
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-1');
      sessionsState.cardColumn = 2 as any;

      store.init();

      expect(store.focusedNavItem).toEqual({ id: 'sess-1', type: 'session-card' });
      expect(store.focusColumn).toBe(2);
    });

    it('leaves focusedNavItem null when navList is empty', () => {
      store.init();
      expect(store.focusedNavItem).toBeNull();
    });
  });

  describe('panelView', () => {
    it('defaults to terminal', () => {
      expect(store.panelView).toBe('terminal');
    });

    it('updates when onViewChange fires', () => {
      store.init();
      // Simulate main-view-manager changing view
      viewChangeListeners[0]('overview');
      expect(store.panelView).toBe('overview');
    });

    it('does not update after dispose', () => {
      store.init();
      store.__dispose();
      viewChangeListeners = []; // listener was removed by dispose
      expect(store.panelView).toBe('terminal');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Focus resolution
  // ──────────────────────────────────────────────────────────────────────

  describe('resolveFocusIndex', () => {
    it('returns sessionsState index when focusedNavItem is null', () => {
      sessionsState.sessionsFocusIndex = 3;
      expect(store.resolveFocusIndex()).toBe(3);
    });

    it('finds item by identity in navList', () => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      store.focusedNavItem = { id: 'sess-2', type: 'session-card' };
      expect(store.resolveFocusIndex()).toBe(navIndex('session-card', 'sess-2'));
    });

    it('falls back to sessionsState index when item not found', () => {
      buildNavList({ type: 'session-card', id: 'sess-1' });
      sessionsState.sessionsFocusIndex = 0;
      store.focusedNavItem = { id: 'deleted', type: 'session-card' };
      expect(store.resolveFocusIndex()).toBe(0);
    });
  });

  describe('syncFocusIndex', () => {
    it('writes resolved index + column to sessionsState', () => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
      );
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      store.focusColumn = 2 as any;

      store.syncFocusIndex();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-1'));
      expect(sessionsState.cardColumn).toBe(2);
    });
  });

  describe('syncSidebarToSession', () => {
    it('sets identity + column 0 and syncs to sessionsState', () => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );

      store.syncSidebarToSession('sess-2');

      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(store.focusColumn).toBe(0);
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
      expect(sessionsState.cardColumn).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // navigateToSession
  // ──────────────────────────────────────────────────────────────────────

  describe('navigateToSession', () => {
    beforeEach(() => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
    });

    it('switches terminal and sets activeSessionId', async () => {
      await store.navigateToSession('sess-2');

      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-2');
      expect(mockSessionSetActive).toHaveBeenCalledWith('sess-2');
      expect(state.activeSessionId).toBe('sess-2');
    });

    it('syncs sidebar focus to the target session', async () => {
      await store.navigateToSession('sess-2');

      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
    });

    it('cleans up draft editor and chip bar', async () => {
      await store.navigateToSession('sess-1');

      expect(mockHideDraftEditor).toHaveBeenCalled();
      expect(mockHideEditorPopup).toHaveBeenCalled();
      expect(mockChipBarClear).toHaveBeenCalled();
    });

    it('refreshes chip bar for new session', async () => {
      await store.navigateToSession('sess-1');

      expect(mockChipBarRefresh).toHaveBeenCalledWith('sess-1');
    });

    it('focuses a snapped-out session via sessionSetActive instead of local switchTo', async () => {
      state.snappedOutSessions.add('sess-2');

      await store.navigateToSession('sess-2');

      expect(mockSessionSetActive).toHaveBeenCalledWith('sess-2');
      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBe('sess-2');
      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(mockChipBarRefresh).toHaveBeenCalledWith('sess-2');
    });

    it('dismisses overview (with selectedOnExit) when overview is open', async () => {
      currentMvmView = 'overview';

      await store.navigateToSession('sess-1');

      expect(mockSetSelectedOnExit).toHaveBeenCalledWith(true);
      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-1');
    });

    it('dismisses plan when plan is open', async () => {
      currentMvmView = 'plan';

      await store.navigateToSession('sess-1');

      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-1');
    });

    it('clears restore context when dismissing overlay', async () => {
      currentMvmView = 'overview';
      // Simulate that overview was opened (restore context saved)
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      await store.openOverview('/projects');

      // Now navigate away
      await store.navigateToSession('sess-2');

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });

    it('does NOT commit activeSessionId when terminal has no matching pane', async () => {
      mockTm.hasTerminal.mockReturnValue(false);
      state.activeSessionId = 'sess-1';

      const result = await store.navigateToSession('nonexistent');

      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBe('sess-1');
      expect(result.kind).toBe('unavailable');
    });

    it('returns ActivationResult for each branch', async () => {
      // local-terminal
      mockTm.hasTerminal.mockReturnValue(true);
      let result = await store.navigateToSession('sess-1');
      expect(result.kind).toBe('local-terminal');
      expect(result.sessionId).toBe('sess-1');

      // snapped-out
      state.snappedOutSessions.add('sess-2');
      result = await store.navigateToSession('sess-2');
      expect(result.kind).toBe('snapped-out');
      expect(result.sessionId).toBe('sess-2');
      state.snappedOutSessions.delete('sess-2');

      // unavailable
      mockTm.hasTerminal.mockReturnValue(false);
      result = await store.navigateToSession('nonexistent');
      expect(result.kind).toBe('unavailable');
      expect(result.sessionId).toBe('nonexistent');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // activateSession
  // ──────────────────────────────────────────────────────────────────────

  describe('activateSession', () => {
    it('switches terminal and sets activeSessionId', () => {
      store.activateSession('sess-1');

      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-1');
      expect(mockSessionSetActive).toHaveBeenCalledWith('sess-1');
      expect(state.activeSessionId).toBe('sess-1');
    });

    it('refreshes chip bar for the activated session', () => {
      store.activateSession('sess-1');

      expect(mockChipBarRefresh).toHaveBeenCalledWith('sess-1');
    });

    it('does NOT clean up drafts or chip bar', () => {
      store.activateSession('sess-1');

      expect(mockHideDraftEditor).not.toHaveBeenCalled();
      expect(mockHideEditorPopup).not.toHaveBeenCalled();
      expect(mockChipBarClear).not.toHaveBeenCalled();
    });

    it('does NOT sync sidebar focus', () => {
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      sessionsState.sessionsFocusIndex = 0;

      store.activateSession('sess-2');

      // Sidebar index unchanged
      expect(sessionsState.sessionsFocusIndex).toBe(0);
    });

    it('does not call switchTo when terminal has no matching session', () => {
      mockTm.hasTerminal.mockReturnValue(false);

      const result = store.activateSession('nonexistent');

      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBeNull();
      expect(mockChipBarRefresh).not.toHaveBeenCalled();
      expect(result.kind).toBe('unavailable');
      expect(result.sessionId).toBe('nonexistent');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Overview lifecycle
  // ──────────────────────────────────────────────────────────────────────

  describe('openOverview', () => {
    it('saves restore context (previous session + focus)', async () => {
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };

      await store.openOverview('/projects', 'sess-2');

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBe('sess-1');
      expect(ctx.savedFocusItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('delegates to showView with overview params', async () => {
      await store.openOverview('/projects', 'sess-2');

      expect(showView).toHaveBeenCalledWith('overview', {
        groupDirPath: '/projects',
        initialSessionId: 'sess-2',
      });
    });

    it('preserves existing restore context when chaining overlays', async () => {
      state.activeSessionId = 'original-session';
      store.focusedNavItem = { id: 'original-session', type: 'session-card' };

      // First overlay open saves context
      await store.openOverview('/a');
      const ctx1 = store.__getRestoreContext();
      expect(ctx1.previousSessionId).toBe('original-session');

      // Transition to plan (overview → plan) should keep original context
      await store.openPlan('/b');
      const ctx2 = store.__getRestoreContext();
      expect(ctx2.previousSessionId).toBe('original-session');
    });
  });

  describe('closeOverview', () => {
    it('delegates to the main view manager', async () => {
      currentMvmView = 'overview';
      await store.closeOverview();
      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockHideOverview).not.toHaveBeenCalled();
    });

    it('reads back restored focus from sessionsState', async () => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
      );
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-1');

      await store.closeOverview();

      expect(store.focusedNavItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('clears restore context', async () => {
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      await store.openOverview('/a');

      await store.closeOverview();

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Plan lifecycle
  // ──────────────────────────────────────────────────────────────────────

  describe('openPlan', () => {
    it('leaves the active session unchanged and does not save plan restore context', async () => {
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };

      await store.openPlan('/projects');

      const ctx = store.__getRestoreContext();
      expect(state.activeSessionId).toBe('sess-1');
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('delegates to showView with plan params', async () => {
      await store.openPlan('/projects');

      expect(showView).toHaveBeenCalledWith('plan', { dir: '/projects' });
    });

    it('sets selectedOnExit on overview when transitioning overview → plan', async () => {
      currentMvmView = 'overview';

      await store.openPlan('/projects');

      expect(mockSetSelectedOnExit).toHaveBeenCalledWith(true);
    });
  });

  describe('closePlan', () => {
    it('transitions to terminal view', async () => {
      currentMvmView = 'plan';

      await store.closePlan();

      expect(showView).toHaveBeenCalledWith('terminal');
    });

    it('does not switch terminals or rewrite the active session', async () => {
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      await store.openPlan('/projects');

      state.activeSessionId = 'sess-2';
      mockTm.switchTo.mockClear();

      await store.closePlan();

      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBe('sess-2');
    });

    it('restores sidebar focus', async () => {
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      store.focusedNavItem = { id: 'sess-2', type: 'session-card' };
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-2');
      state.activeSessionId = 'sess-2';
      await store.openPlan('/projects');

      await store.closePlan();

      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
    });

    it('refreshes chip bar for restored session', async () => {
      state.activeSessionId = 'sess-1';
      await store.openPlan('/projects');

      await store.closePlan();

      expect(mockChipBarRefresh).toHaveBeenCalledWith('sess-1');
    });

    it('handles missing previous session gracefully', async () => {
      // No previous session
      state.activeSessionId = null;
      await store.openPlan('/projects');

      mockTm.hasTerminal.mockReturnValue(false);
      await store.closePlan();

      expect(mockTm.switchTo).not.toHaveBeenCalled();
    });

    it('clears restore context', async () => {
      state.activeSessionId = 'sess-1';
      await store.openPlan('/a');

      await store.closePlan();

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Settings
  // ──────────────────────────────────────────────────────────────────────

  describe('openSettings / closeSettings', () => {
    it('sets currentScreen to settings', () => {
      store.openSettings();
      expect(state.currentScreen).toBe('settings');
    });

    it('sets currentScreen back to sessions', () => {
      state.currentScreen = 'settings';
      store.closeSettings();
      expect(state.currentScreen).toBe('sessions');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // navList rebuild — identity-based focus survival
  // ──────────────────────────────────────────────────────────────────────

  describe('onNavListRebuilt', () => {
    it('re-derives index when focused item moves position', () => {
      store.focusedNavItem = { id: 'sess-2', type: 'session-card' };
      sessionsState.sessionsFocusIndex = 1;

      // Rebuild navList with sess-2 at a new position
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-NEW' },
        { type: 'session-card', id: 'sess-2' },
      );

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
    });

    it('falls back to active session when focused item is gone', () => {
      store.focusedNavItem = { id: 'deleted-session', type: 'session-card' };
      state.activeSessionId = 'sess-1';

      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
      );

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-1'));
      expect(store.focusedNavItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('clamps index when both focused item and active session are gone', () => {
      store.focusedNavItem = { id: 'deleted', type: 'session-card' };
      state.activeSessionId = 'also-deleted';
      sessionsState.sessionsFocusIndex = 5;

      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-only' },
      );

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-only')); // clamped to max
      expect(store.focusedNavItem).toEqual({ id: 'sess-only', type: 'session-card' });
    });

    it('no-ops when focusedNavItem is null', () => {
      store.focusedNavItem = null;
      sessionsState.sessionsFocusIndex = 42;

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(42); // unchanged
    });

    it('handles empty navList without crashing', () => {
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      sessionsState.sessionsFocusIndex = 5;
      buildNavList();

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(0); // clamped to 0
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Overlay chaining edge cases
  // ──────────────────────────────────────────────────────────────────────

  describe('overlay chaining', () => {
    it('overview → plan preserves original restore context', async () => {
      state.activeSessionId = 'original';
      store.focusedNavItem = { id: 'original', type: 'session-card' };

      await store.openOverview('/a');
      // overview mount deselects terminal
      state.activeSessionId = null;

      await store.openPlan('/b');

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBe('original');
      expect(ctx.savedFocusItem).toEqual({ id: 'original', type: 'session-card' });
    });

    it('closing chained plan does not restore the old session', async () => {
      buildNavList(
        { type: 'session-card', id: 'original' },
        { type: 'session-card', id: 'other' },
      );
      state.activeSessionId = 'original';
      store.focusedNavItem = { id: 'original', type: 'session-card' };

      await store.openOverview('/a');
      state.activeSessionId = null;
      await store.openPlan('/b');
      state.activeSessionId = null;

      await store.closePlan();

      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBeNull();
    });

    it('navigateToSession from overlay clears all restore context', async () => {
      state.activeSessionId = 'original';
      store.focusedNavItem = { id: 'original', type: 'session-card' };
      await store.openOverview('/a');

      buildNavList({ type: 'session-card', id: 'target' });
      currentMvmView = 'overview';
      await store.navigateToSession('target');

      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // __dispose
  // ──────────────────────────────────────────────────────────────────────

  describe('__dispose', () => {
    it('resets all internal state', () => {
      store.init();
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      store.focusColumn = 3 as any;

      store.__dispose();

      expect(store.panelView).toBe('terminal');
      expect(store.focusedNavItem).toBeNull();
      expect(store.focusColumn).toBe(0);
      expect(store.__getRestoreContext()).toEqual({
        previousSessionId: null,
        savedFocusItem: null,
      });
    });

    it('allows re-initialization after dispose', () => {
      store.init();
      store.__dispose();
      store.init();
      expect(viewChangeListeners).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Integration — user journeys
  // ──────────────────────────────────────────────────────────────────────

  describe('integration — user journeys', () => {
    it('overview visible → sidebar click → overview dismissed, terminal shown', async () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };

      await store.openOverview('/projects');
      expect(store.panelView).toBe('overview');

      await store.navigateToSession('sess-2');

      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockSetSelectedOnExit).toHaveBeenCalledWith(true);
      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-2');
      expect(state.activeSessionId).toBe('sess-2');
      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });

    it('session → plan → session leaves session navigation authoritative', async () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-1');

      await store.openPlan('/projects');
      expect(store.panelView).toBe('plan');

      state.activeSessionId = 'sess-2';

      (showView as MockedFunction<typeof showView>).mockClear();
      mockTm.switchTo.mockClear();

      await store.closePlan();

      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBe('sess-2');
      expect(store.focusedNavItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('overview → plan does not make plan close restore a session', async () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-1');

      // Open overview, then chain into plan
      await store.openOverview('/projects');
      await store.openPlan('/projects');
      state.activeSessionId = 'sess-2';

      await store.closePlan();

      expect(mockTm.switchTo).not.toHaveBeenCalled();
      expect(state.activeSessionId).toBe('sess-2');
    });

    it('Ctrl+Tab sidebar sync', () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
        { type: 'session-card', id: 'sess-3' },
      );

      store.activateSession('sess-2');
      store.syncSidebarToSession('sess-2');

      expect(state.activeSessionId).toBe('sess-2');
      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
    });

    it('notification click during overview → overview dismissed + correct session shown', async () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
        { type: 'session-card', id: 'sess-3' },
      );
      state.activeSessionId = 'sess-1';
      store.focusedNavItem = { id: 'sess-1', type: 'session-card' };

      await store.openOverview('/projects');
      expect(store.panelView).toBe('overview');

      await store.navigateToSession('sess-3');

      // Overview dismissed
      expect(showView).toHaveBeenCalledWith('terminal');
      expect(mockSetSelectedOnExit).toHaveBeenCalledWith(true);
      // Terminal switched to sess-3
      expect(mockTm.switchTo).toHaveBeenCalledWith('sess-3');
      expect(state.activeSessionId).toBe('sess-3');
      // Sidebar synced to sess-3
      expect(store.focusedNavItem).toEqual({ id: 'sess-3', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-3'));
      // Restore context cleared
      const ctx = store.__getRestoreContext();
      expect(ctx.previousSessionId).toBeNull();
      expect(ctx.savedFocusItem).toBeNull();
    });

    it('navList rebuild preserves focused identity', () => {
      store.init();
      buildNavList(
        { type: 'group-header', id: '/a' },
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      store.focusedNavItem = { id: 'sess-2', type: 'session-card' };
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-2');

      // Rebuild with different order — sess-2 moves up one slot
      buildNavList(
        { type: 'group-header', id: '/b' },
        { type: 'session-card', id: 'sess-2' },
        { type: 'session-card', id: 'sess-1' },
      );

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
    });

    it('navList rebuild — focused item removed → falls back to active session', () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      store.focusedNavItem = { id: 'sess-2', type: 'session-card' };
      sessionsState.sessionsFocusIndex = navIndex('session-card', 'sess-2');
      state.activeSessionId = 'sess-1';

      // Rebuild WITHOUT sess-2
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-3' },
      );

      store.onNavListRebuilt();

      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-1'));
      expect(store.focusedNavItem).toEqual({ id: 'sess-1', type: 'session-card' });
    });

    it('reconcileTerminalSwitch after destroyTerminal', async () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
      );
      state.activeSessionId = 'sess-1';

      await store.reconcileTerminalSwitch('sess-2');

      expect(state.activeSessionId).toBe('sess-2');
      expect(store.focusedNavItem).toEqual({ id: 'sess-2', type: 'session-card' });
      expect(sessionsState.sessionsFocusIndex).toBe(navIndex('session-card', 'sess-2'));
      expect(mockChipBarRefresh).toHaveBeenCalledWith('sess-2');
    });

    it('double close is safe — closePlan when already on terminal', async () => {
      store.init();
      // currentView is already 'terminal' (default)
      expect(store.panelView).toBe('terminal');

      // Should not throw
      await store.closePlan();

      expect(showView).toHaveBeenCalledWith('terminal');
    });

    it('rapid D-pad switching convergence', () => {
      store.init();
      buildNavList(
        { type: 'session-card', id: 'sess-1' },
        { type: 'session-card', id: 'sess-2' },
        { type: 'session-card', id: 'sess-3' },
      );

      store.activateSession('sess-1');
      store.activateSession('sess-2');
      store.activateSession('sess-3');

      expect(state.activeSessionId).toBe('sess-3');
      expect(mockTm.switchTo).toHaveBeenCalledTimes(3);
    });
  });
});

// ── Dock view routing ─────────────────────────────────────────────────

import { ref } from 'vue';
import { createDockViewRouting } from '../renderer/composables/useDockViewRouting.js';
import { PANE_OVERVIEW, PANE_TERMINAL, type PaneId } from '../renderer/dock-types.js';

/** A fake dock workspace: real bookkeeping, no tree, no DOM. */
function makeFakeDock() {
  const open = new Set<PaneId>([PANE_TERMINAL, PANE_OVERVIEW]);
  const calls: string[] = [];
  return {
    calls,
    isOpen: (id: PaneId) => open.has(id),
    isVisible: () => true,
    restore: (id: PaneId) => { open.add(id); calls.push(`restore:${id}`); },
    reveal: (id: PaneId) => { calls.push(`reveal:${id}`); },
    unreveal: (id: PaneId) => { calls.push(`unreveal:${id}`); },
    activate: (id: PaneId) => { calls.push(`activate:${id}`); },
    focusPane: (id: PaneId) => { calls.push(`focus:${id}`); },
    close: (id: PaneId) => { open.delete(id); calls.push(`close:${id}`); },
  };
}

describe('dock view routing — Team View is a tool pane', () => {
  let store: ReturnType<typeof useNavigationStore>;
  let dock: ReturnType<typeof makeFakeDock>;
  let activeView: ReturnType<typeof ref<'terminal' | 'overview' | 'plan'>>;
  let routing: ReturnType<typeof createDockViewRouting>;

  beforeEach(() => {
    setActivePinia(createPinia());
    currentMvmView = 'terminal';
    viewChangeListeners = [];
    resetSingletons();
    vi.clearAllMocks();
    mockTm.hasTerminal.mockReturnValue(true);
    (window as any).gamepadCli = { sessionSetActive: mockSessionSetActive };
    store = useNavigationStore();
    store.init();
    buildNavList(
      { type: 'group-header', id: '/proj' },
      { type: 'session-card', id: 'sess-1' },
      { type: 'session-card', id: 'sess-2' },
    );
    dock = makeFakeDock();
    activeView = ref<'terminal' | 'overview' | 'plan'>('terminal');
    routing = createDockViewRouting({
      activeView: activeView as any,
      dock,
      navStore: store,
      artifacts: { showPanel: vi.fn(), hidePanel: vi.fn() },
      getActiveSessionDir: () => null,
    });
  });

  afterEach(() => {
    store.__dispose();
  });

  it('focusing the Team View pane while the terminal view is active starts no view transition', async () => {
    await store.navigateToSession('sess-1');
    vi.mocked(showView).mockClear();

    routing.onDockFocusPane(PANE_OVERVIEW, 'desk:sess-2');
    await Promise.resolve();

    expect(showView).not.toHaveBeenCalled();
    expect(currentView()).toBe('terminal');
    expect(dock.calls).toEqual(['focus:overview']);
  });

  it('does not invalidate a navigation that is already in flight', async () => {
    await store.navigateToSession('sess-1');

    // mousedown focuses the pane while the click's navigation is still running.
    const pending = store.navigateToSession('sess-2');
    routing.onDockFocusPane(PANE_OVERVIEW, 'desk:sess-2');

    await expect(pending).resolves.toEqual({ kind: 'local-terminal', sessionId: 'sess-2' });
  });

  it('selects the second desk after the first — the click path stays live', async () => {
    const first = await store.navigateToSession('sess-1');
    expect(first).toEqual({ kind: 'local-terminal', sessionId: 'sess-1' });

    // Click on the second desk: focusin (mousedown) then the select handler.
    routing.onDockFocusPane(PANE_OVERVIEW, 'desk:sess-2');
    const second = await store.navigateToSession('sess-2');

    expect(second).toEqual({ kind: 'local-terminal', sessionId: 'sess-2' });
    expect(mockTm.switchTo).toHaveBeenLastCalledWith('sess-2');
    expect(state.activeSessionId).toBe('sess-2');
  });

  it('closing the Team View pane runs no view lifecycle', async () => {
    await routing.closeDockPane(PANE_OVERVIEW);
    expect(showView).not.toHaveBeenCalled();
    expect(activeView.value).toBe('terminal');
    expect(dock.calls).toEqual(['close:overview']);
  });

  it('still routes the panes that do represent a view', () => {
    expect(routing.viewForPane(PANE_TERMINAL)).toBe('terminal');
    expect(routing.viewForPane(PANE_OVERVIEW)).toBeUndefined();
    expect(routing.paneForView('overview')).toBeUndefined();
  });
});
