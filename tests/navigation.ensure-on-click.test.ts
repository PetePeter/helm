// @vitest-environment jsdom

/**
 * Tests that navigateToSession materialises a terminal view on-demand
 * (via ensureTerminal) for remote-spawned sessions the renderer hasn't adopted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// ── Mocks ──────────────────────────────────────────────────────────────

let viewChangeListeners: Array<(view: string) => void> = [];
let currentMvmView = 'terminal';

vi.mock('../renderer/main-view/main-view-manager.js', () => ({
  showView: vi.fn(async (view: string) => {
    currentMvmView = view;
    for (const cb of viewChangeListeners) cb(view);
  }),
  onViewChange: vi.fn((cb: (view: string) => void) => {
    viewChangeListeners.push(cb);
    return () => { viewChangeListeners = viewChangeListeners.filter(l => l !== cb); };
  }),
  currentView: vi.fn(() => currentMvmView),
}));

// Terminal manager mock — starts with no terminals; ensureTerminal populates the set.
const adoptedSessions = new Set<string>();
const mockTm = {
  hasTerminal: vi.fn((id: string) => adoptedSessions.has(id)),
  switchTo: vi.fn(),
  deselect: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  ensureTerminal: vi.fn((id: string) => {
    // Simulate: ensureTerminal adopts the session if it's "known" (truthy id starting with 'known-')
    if (id.startsWith('known-')) adoptedSessions.add(id);
  }),
};

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  getTerminalManager: vi.fn(() => mockTm),
}));

// Real builders — the nav list derives from them; only the lookup is spied.
vi.mock('../renderer/session-groups.js', async (importActual) => ({
  ...(await importActual<typeof import('../renderer/session-groups.js')>()),
  findNavIndexBySessionId: vi.fn((navList: Array<{ type: string; id: string }>, id: string) =>
    navList.findIndex(item => item.type === 'session-card' && item.id === id),
  ),
}));

const {
  mockHideDraftEditor,
  mockHideEditorPopup,
  mockChipBarClear,
  mockChipBarRefresh,
  mockSessionSetActive,
} = vi.hoisted(() => ({
  mockHideDraftEditor: vi.fn(),
  mockHideEditorPopup: vi.fn(),
  mockChipBarClear: vi.fn(),
  mockChipBarRefresh: vi.fn(),
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
  setSelectedOnExit: vi.fn(),
  hideOverview: vi.fn(),
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

// ── Imports (after mocks) ───────────────────────────────────────────────

import { useNavigationStore } from '../renderer/stores/navigation.js';
import { state } from '../renderer/state.js';
import { sessionsState } from '../renderer/screens/sessions-state.js';

// ── Helpers ────────────────────────────────────────────────────────────

function resetSingletons() {
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

describe('navigateToSession — ensureTerminal on-demand', () => {
  let store: ReturnType<typeof useNavigationStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    currentMvmView = 'terminal';
    viewChangeListeners = [];
    adoptedSessions.clear();
    resetSingletons();
    vi.clearAllMocks();
    (window as any).gamepadCli = { sessionSetActive: mockSessionSetActive };
    store = useNavigationStore();
  });

  afterEach(() => {
    store.__dispose();
  });

  it('calls ensureTerminal before hasTerminal for any session', async () => {
    // known- prefix → ensureTerminal will adopt it
    const result = await store.navigateToSession('known-remote-1');

    expect(mockTm.ensureTerminal).toHaveBeenCalledWith('known-remote-1');
    expect(mockTm.hasTerminal).toHaveBeenCalledWith('known-remote-1');
  });

  it('returns local-terminal and switches for a remote session materialised by ensureTerminal', async () => {
    const result = await store.navigateToSession('known-remote-2');

    expect(result.kind).toBe('local-terminal');
    expect(result.sessionId).toBe('known-remote-2');
    expect(mockTm.switchTo).toHaveBeenCalledWith('known-remote-2');
    expect(state.activeSessionId).toBe('known-remote-2');
  });

  it('returns unavailable when ensureTerminal cannot materialise the session', async () => {
    // id doesn't start with 'known-' → ensureTerminal is a no-op
    const result = await store.navigateToSession('ghost-session');

    expect(result.kind).toBe('unavailable');
    expect(mockTm.switchTo).not.toHaveBeenCalled();
  });

  it('regression — already-adopted session still works (no duplicate adoption)', async () => {
    adoptedSessions.add('existing-1');

    const result = await store.navigateToSession('existing-1');

    expect(result.kind).toBe('local-terminal');
    expect(mockTm.switchTo).toHaveBeenCalledWith('existing-1');
    // ensureTerminal is still called but is a no-op for already-adopted sessions
    expect(mockTm.ensureTerminal).toHaveBeenCalledWith('existing-1');
    expect(mockTm.ensureTerminal).toHaveBeenCalledTimes(1);
  });

  it('sets activeSessionId on successful materialisation', async () => {
    await store.navigateToSession('known-remote-3');

    expect(state.activeSessionId).toBe('known-remote-3');
  });
});
