/** @vitest-environment jsdom */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';
import { state } from '../../../renderer/state.js';
import { useNavigationStore } from '../../../renderer/stores/navigation.js';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import { sessionsState } from '../../../renderer/stores/sessions-screen.js';
import { setTerminalManager } from '../../../renderer/runtime/terminal-provider.js';
import type { TerminalManager } from '../../../renderer/terminal/terminal-manager.js';
import { resetActiveSessionPinForTests } from '../../../renderer/stores/app.js';
import { createWheelStepAccumulator } from '../../../renderer/components/sidebar/wheel-step-accumulator.js';

const groupStub = {
  props: ['navIndex'],
  template: '<div :data-nav-index="navIndex"><slot /></div>',
};
const cardStub = {
  props: ['navIndex', 'session'],
  template: '<div class="card" :data-id="session.id" :data-nav-index="navIndex" />',
};

const wrappers: VueWrapper[] = [];
let sessionSwitches: string[];

function setSessions(ids: string[], hiddenIds: string[] = []): void {
  state.sessions = ids.map(id => ({
    id,
    name: id.toUpperCase(),
    cliType: 'claude',
    processId: 1,
    workingDir: '/repo',
    hidden: hiddenIds.includes(id),
  }));
  state.activeSessionId = ids[0] ?? null;
  sessionsState.showHiddenSessions = false;
  sessionsState.groupPrefs = { order: [], collapsed: [], bookmarked: [] };
  sessionsState.activeFocus = 'sessions';
  sessionsState.cardColumn = 0;
  sessionsState.sessionsFocusIndex = sessionsState.navList.findIndex(item => item.id === ids[0]);
}

function mountList(source: 'local' | 'peer' = 'local'): VueWrapper {
  const visibleSessions = sessionsState.visibleSessions;
  const navIndexMap = new Map(sessionsState.navList.map((item, index) => [item.id, index]));
  const wrapper = mount(SessionList, {
    attachTo: document.body,
    props: {
      hasSessions: visibleSessions.length > 0,
      groups: visibleSessions.length > 0 ? [{
        dirPath: '/repo',
        displayName: '/repo',
        collapsed: false,
        sessions: visibleSessions,
      }] : [],
      directories: [],
      navIndexMap,
      activeFocus: 'sessions',
      focusedNavItem: null,
      focusColumn: 0,
      activeSessionId: state.activeSessionId,
      editingSessionId: null,
      sessionStates: new Map(),
      sessionActivityLevels: new Map(),
      artifactCounts: new Map(),
      workingPlanLabels: new Map(),
      workingPlanTooltips: new Map(),
      pendingSchedules: new Map(),
      snappedOutSessions: new Set(),
      llmNotifications: new Map(),
      getCliDisplayName: (cliType: string) => cliType,
      resolveGroupDisplayName: (dirPath: string) => dirPath,
      sessionElapsedText: () => '',
      sessionShortcutMap: new Map(),
      source,
    },
    global: { plugins: [pinia], stubs: { SessionGroup: groupStub, SessionCard: cardStub } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  sessionSwitches = [];
  state.sessions = [];
  state.activeSessionId = null;
  state.snappedOutSessions.clear();
  sessionsState.showHiddenSessions = false;
  sessionsState.activeFocus = 'sessions';
  sessionsState.sessionsFocusIndex = 0;
  sessionsState.cardColumn = 0;
  useModalStack().clear();
  setTerminalManager({
    hasTerminal: () => true,
    switchTo: (sessionId: string) => { sessionSwitches.push(sessionId); },
    getOutputBuffer: () => null,
  } as unknown as TerminalManager);
  (window as unknown as { helm: unknown }).helm = {
    events: { onTodosChanged: () => () => {}, onScheduledTaskChanged: () => () => {} },
    sessions: { todoList: async () => [], sessionSetActive: async () => {} },
    scheduler: { scheduledTaskList: async () => [] },
    plans: { planGetAllDoingForDir: async () => [], planStartableForDir: async () => [] },
    config: { configGetChipbarActions: async () => ({ actions: [], inboxDir: '' }) },
  };
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  delete (window as unknown as { helm?: unknown }).helm;
  setTerminalManager(null);
  resetActiveSessionPinForTests();
  useModalStack().clear();
  state.sessions = [];
  state.activeSessionId = null;
  state.snappedOutSessions.clear();
  sessionsState.showHiddenSessions = false;
  sessionsState.activeFocus = 'sessions';
  sessionsState.sessionsFocusIndex = 0;
  sessionsState.cardColumn = 0;
  vi.restoreAllMocks();
});

describe('wheel step accumulator', () => {
  it('combines partial deltas and emits one step per completed notch', () => {
    const wheel = createWheelStepAccumulator(100);
    expect(wheel.push(40)).toBe(0);
    expect(wheel.push(60)).toBe(1);
    expect(wheel.push(250)).toBe(2);
    expect(wheel.push(50)).toBe(1);
  });

  it('keeps reversal and zero deltas from creating phantom steps', () => {
    const wheel = createWheelStepAccumulator(100);
    expect(wheel.push(60)).toBe(0);
    expect(wheel.push(-60)).toBe(0);
    expect(wheel.push(0)).toBe(0);
    expect(wheel.push(-100)).toBe(-1);
  });
});

describe('SessionList wheel navigation', () => {
  it('uses D-pad navigation to focus, auto-select, and keep the row visible', async () => {
    setSessions(['a', 'b', 'c']);
    const navigation = useNavigationStore(pinia);
    navigation.init();
    mountList();

    const list = document.querySelector<HTMLElement>('.sessions-list')!;
    // jsdom has no layout: every row reports 40px below the list's visible box.
    list.getBoundingClientRect = () => ({ top: 0, bottom: 200 } as DOMRect);
    const rowRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 200, bottom: 240 } as DOMRect);
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    list.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(sessionsState.sessionsFocusIndex).toBe(sessionsState.navList.findIndex(item => item.id === 'b'));
    expect(navigation.focusedNavItem).toEqual({ id: 'b', type: 'session-card' });
    expect(state.activeSessionId).toBe('b');
    expect(sessionSwitches).toEqual(['b']);
    await nextTick();
    expect(list.scrollTop).toBe(40);
    rowRect.mockRestore();

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    await nextTick();
    expect(sessionsState.sessionsFocusIndex).toBe(sessionsState.navList.findIndex(item => item.id === 'a'));
    expect(state.activeSessionId).toBe('a');
    expect(sessionSwitches).toEqual(['b', 'a']);
  });

  it('skips hidden sessions through the shared visible navigation list', () => {
    setSessions(['a', 'hidden', 'c'], ['hidden']);
    const navigation = useNavigationStore(pinia);
    navigation.init();
    mountList();

    document.querySelector('.sessions-list')!.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
    );

    expect(sessionsState.navList.some(item => item.id === 'hidden')).toBe(false);
    expect(navigation.focusedNavItem).toEqual({ id: 'c', type: 'session-card' });
    expect(state.activeSessionId).toBe('c');
  });

  it('skips headers and hidden rows even when hidden sessions are shown', () => {
    setSessions(['a', 'hidden', 'c'], ['hidden']);
    state.sessions[2]!.workingDir = '/other';
    sessionsState.groupPrefs = { order: ['/repo', '/other'], collapsed: [], bookmarked: [] };
    sessionsState.showHiddenSessions = true;
    useNavigationStore(pinia).init();
    mountList();
    const list = document.querySelector('.sessions-list')!;

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(state.activeSessionId).toBe('c');
    expect(sessionsState.navList[sessionsState.sessionsFocusIndex]).toMatchObject({ type: 'session-card', id: 'c' });

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(state.activeSessionId).toBe('a');
    expect(sessionsState.navList[sessionsState.sessionsFocusIndex]).toMatchObject({ type: 'session-card', id: 'a' });

    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(state.activeSessionId).toBe('a');
    expect(sessionsState.navList[sessionsState.sessionsFocusIndex]).toMatchObject({ type: 'session-card', id: 'a' });
  });

  it('moves off a hidden active row and stays on the last available session', () => {
    setSessions(['a', 'hidden', 'c'], ['hidden']);
    state.activeSessionId = 'hidden';
    sessionsState.sessionsFocusIndex = sessionsState.navList.findIndex(item => item.id === 'hidden');
    useNavigationStore(pinia).init();
    mountList();

    document.querySelector('.sessions-list')!.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }),
    );

    expect(state.activeSessionId).toBe('c');
    expect(sessionsState.navList[sessionsState.sessionsFocusIndex]).toMatchObject({ type: 'session-card', id: 'c' });
    expect(sessionSwitches).toEqual(['c']);
  });

  it('does not navigate while a modal owns input', () => {
    setSessions(['a', 'b']);
    useNavigationStore(pinia).init();
    mountList();
    useModalStack().push({ id: 'test-modal', handler: () => true, interceptKeys: new Set() });
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });

    document.querySelector('.sessions-list')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(state.activeSessionId).toBe('a');
    expect(sessionsState.sessionsFocusIndex).toBe(sessionsState.navList.findIndex(item => item.id === 'a'));
  });

  it('leaves peer SessionList wheel input to native scrolling', () => {
    setSessions(['a', 'b']);
    mountList('peer');
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });

    document.querySelector('.sessions-list')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(sessionsState.sessionsFocusIndex).toBe(sessionsState.navList.findIndex(item => item.id === 'a'));
    expect(sessionSwitches).toEqual([]);
  });
});
