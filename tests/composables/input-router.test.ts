/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  state: {
    sessions: [] as Array<{ id: string; cliType: string }>,
  },
  sessionsState: {
    overviewFocusIndex: 0,
  },
  terminalManager: {
    getActiveSessionId: vi.fn(),
  },
  modalStack: {
    isOpen: { value: false },
    topInterceptKeys: { value: new Set<string>() },
    handleInput: vi.fn(),
  },
  escProtection: {
    isProtecting: { value: false },
    dismissProtection: vi.fn(),
  },
  processConfigBinding: vi.fn(),
  processConfigRelease: vi.fn(),
  handlePlanScreenDpad: vi.fn(),
  handlePlanScreenAction: vi.fn(),
  handleSessionsScreenButton: vi.fn(),
  getOverviewSessions: vi.fn(),
  navigateFocus: vi.fn(),
  isAnyBridgeModalVisible: vi.fn(),
}));

vi.mock('../../renderer/state.js', () => ({ state: mocks.state }));
vi.mock('../../renderer/screens/sessions-state.js', () => ({ sessionsState: mocks.sessionsState }));
vi.mock('../../renderer/runtime/terminal-provider.js', () => ({ getTerminalManager: () => mocks.terminalManager }));
vi.mock('../../renderer/utils.js', () => ({
  toDirection: (button: string) => ({
    DPadUp: 'up',
    DPadDown: 'down',
    DPadLeft: 'left',
    DPadRight: 'right',
  } as Record<string, string>)[button] ?? null,
  navigateFocus: mocks.navigateFocus,
}));
vi.mock('../../renderer/bindings.js', () => ({
  processConfigBinding: mocks.processConfigBinding,
  processConfigRelease: mocks.processConfigRelease,
  releaseVoiceTalk: () => false,
}));
vi.mock('../../renderer/screens/group-overview.js', () => ({ getOverviewSessions: mocks.getOverviewSessions }));
vi.mock('../../renderer/plans/plan-screen.js', () => ({
  handlePlanScreenDpad: mocks.handlePlanScreenDpad,
  handlePlanScreenAction: mocks.handlePlanScreenAction,
}));
vi.mock('../../renderer/screens/sessions.js', () => ({ handleSessionsScreenButton: mocks.handleSessionsScreenButton }));
vi.mock('../../renderer/composables/useModalStack.js', () => ({ useModalStack: () => mocks.modalStack }));
vi.mock('../../renderer/composables/useEscProtection.js', () => ({ useEscProtection: () => mocks.escProtection }));
vi.mock('../../renderer/stores/modal-bridge.js', () => ({ isAnyBridgeModalVisible: mocks.isAnyBridgeModalVisible }));

import { useInputRouter } from '../../renderer/composables/useInputRouter.js';

function createRouter(overrides: Partial<Parameters<typeof useInputRouter>[0]> = {}) {
  const navStore = {
    closeSettings: vi.fn(),
    closePlan: vi.fn(),
    closeOverview: vi.fn(),
    navigateToSession: vi.fn(),
  };
  const deps = {
    settingsVisible: ref(false),
    activeView: ref<'terminal' | 'overview' | 'plan'>('terminal'),
    bindingEditorVisible: ref(false),
    draftEditorVisible: ref(false),
    draftEditorRef: ref<{ handleButton?: (button: string) => void } | null>(null),
    settingsPanelRef: ref<{ handleButton?: (button: string) => void } | null>(null),
    settingsTab: ref('tools'),
    overviewCollapsedIds: ref(new Set<string>()),
    buildSettingsTabs: vi.fn(() => [{ id: 'tools' }, { id: 'bindings' }]),
    navStore,
    ...overrides,
  };
  return { router: useInputRouter(deps), deps, navStore };
}

describe('useInputRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.sessions = [{ id: 's1', cliType: 'codex' }];
    mocks.terminalManager.getActiveSessionId.mockReturnValue('s1');
    mocks.modalStack.isOpen.value = false;
    mocks.modalStack.topInterceptKeys.value = new Set();
    mocks.modalStack.handleInput.mockReturnValue(false);
    mocks.escProtection.isProtecting.value = false;
    mocks.getOverviewSessions.mockReturnValue([{ id: 's1' }]);
    mocks.handlePlanScreenAction.mockReturnValue(false);
    mocks.handleSessionsScreenButton.mockReturnValue(false);
    mocks.isAnyBridgeModalVisible.mockReturnValue(false);
  });

  it('routes modal stack input before app-level policy', () => {
    mocks.modalStack.handleInput.mockReturnValue(true);
    const { router, navStore } = createRouter({ activeView: ref('plan') });

    router.handleButton('B');

    expect(mocks.modalStack.handleInput).toHaveBeenCalledWith('B');
    expect(navStore.closePlan).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('routes settings buttons before plan, session, and terminal fallbacks', () => {
    const { router, deps, navStore } = createRouter({
      settingsVisible: ref(true),
      activeView: ref('plan'),
    });

    router.handleButton('B');

    expect(deps.settingsVisible.value).toBe(false);
    expect(navStore.closeSettings).toHaveBeenCalled();
    expect(mocks.handlePlanScreenAction).not.toHaveBeenCalled();
    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('guide and sandwich close settings through the navigation store', () => {
    const { router, deps, navStore } = createRouter({
      settingsVisible: ref(true),
    });

    router.handleButton('Guide');

    expect(deps.settingsVisible.value).toBe(false);
    expect(navStore.closeSettings).toHaveBeenCalled();
    expect(mocks.modalStack.handleInput).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('routes plan buttons before session navigation and terminal bindings', () => {
    const { router, navStore } = createRouter({ activeView: ref('plan') });

    router.handleButton('B');

    expect(navStore.closePlan).toHaveBeenCalled();
    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('routes plan D-pad directly to the plan screen handler', () => {
    const { router } = createRouter({ activeView: ref('plan') });

    router.handleButton('DPadDown');

    expect(mocks.handlePlanScreenDpad).toHaveBeenCalledWith('down');
    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('uses session routing as the only app-level fallback after plan actions decline', () => {
    mocks.handlePlanScreenAction.mockReturnValue(false);
    mocks.handleSessionsScreenButton.mockReturnValue(true);
    const { router } = createRouter({ activeView: ref('plan') });

    router.handleButton('Y');

    expect(mocks.handlePlanScreenAction).toHaveBeenCalledWith('Y');
    expect(mocks.handleSessionsScreenButton).toHaveBeenCalledWith('Y');
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('bridge modals block all lower-priority routing', () => {
    mocks.isAnyBridgeModalVisible.mockReturnValue(true);
    const { router } = createRouter();

    router.handleButton('A');

    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('routes draft editor buttons before sessions and bindings', () => {
    const handleDraftButton = vi.fn();
    const { router } = createRouter({
      draftEditorVisible: ref(true),
      draftEditorRef: ref({ handleButton: handleDraftButton }),
    });

    router.handleButton('DPadUp');

    expect(handleDraftButton).toHaveBeenCalledWith('DPadUp');
    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('overview A navigates to the focused overview session', () => {
    mocks.sessionsState.overviewFocusIndex = 1;
    mocks.getOverviewSessions.mockReturnValue([{ id: 's1' }, { id: 's2' }]);
    const { router, navStore } = createRouter({ activeView: ref('overview') });

    router.handleButton('A');

    expect(navStore.navigateToSession).toHaveBeenCalledWith('s2');
    expect(mocks.handleSessionsScreenButton).not.toHaveBeenCalled();
  });

  it('overview up and down fall through to session navigation', () => {
    mocks.getOverviewSessions.mockReturnValue([{ id: 's1' }]);
    mocks.handleSessionsScreenButton.mockReturnValueOnce(true);
    const { router } = createRouter({ activeView: ref('overview') });

    router.handleButton('DPadDown');

    expect(mocks.handleSessionsScreenButton).toHaveBeenCalledWith('DPadDown');
    expect(mocks.processConfigBinding).not.toHaveBeenCalled();
  });

  it('overview X toggles the focused card collapse state', () => {
    mocks.sessionsState.overviewFocusIndex = 0;
    mocks.getOverviewSessions.mockReturnValue([{ id: 's1' }]);
    const collapsed = ref(new Set<string>());
    const { router } = createRouter({
      activeView: ref('overview'),
      overviewCollapsedIds: collapsed,
    });

    router.handleButton('X');
    expect(collapsed.value.has('s1')).toBe(true);

    router.handleButton('X');
    expect(collapsed.value.has('s1')).toBe(false);
  });

  it('falls through to terminal config bindings when no higher-priority surface handles input', () => {
    const { router } = createRouter();

    router.handleButton('Y');
    router.handleRelease('Y');

    expect(mocks.processConfigBinding).toHaveBeenCalledWith('Y');
    expect(mocks.processConfigRelease).toHaveBeenCalledWith('Y');
  });

  it('keeps a button release on the terminal only while the terminal owns pane focus', () => {
    const focusedPaneId = ref<string | null>('scheduler');
    const { router } = createRouter({ focusedPaneId });

    router.handleRelease('Y');
    expect(mocks.processConfigRelease).not.toHaveBeenCalled();

    focusedPaneId.value = 'terminal';
    router.handleRelease('Y');
    expect(mocks.processConfigRelease).toHaveBeenCalledWith('Y');
  });

  it('keeps modal keyboard bridge keys on the modal stack', () => {
    mocks.modalStack.isOpen.value = true;
    mocks.modalStack.topInterceptKeys.value = new Set(['arrows', 'tab', 'enter', 'space', 'escape']);
    const { router } = createRouter();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });

    // The bridge reports consumption; the keyboard router suppresses the event.
    const consumed = router.handleModalKeyboardBridge(event);

    expect(consumed).toBe(true);
    expect(mocks.modalStack.handleInput).toHaveBeenCalledWith('DPadDown');
  });

  it('dismisses ESC protection on non-Escape modal key without leaking it onward', () => {
    mocks.modalStack.isOpen.value = true;
    mocks.escProtection.isProtecting.value = true;
    const { router } = createRouter();
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true });

    const consumed = router.handleModalKeyboardBridge(event);

    expect(consumed).toBe(true);
    expect(mocks.escProtection.dismissProtection).toHaveBeenCalled();
    expect(mocks.modalStack.handleInput).not.toHaveBeenCalled();
  });
});
