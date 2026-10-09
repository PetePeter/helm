/**
 * Pinia store tests — verify stores work with the reactive state singletons.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAppStore, resetActiveSessionPinForTests } from '../../renderer/stores/app.js';
import { useSessionsScreenStore } from '../../renderer/stores/sessions-screen.js';
import { useConfigStore } from '../../renderer/stores/config.js';
import { useDraftsStore } from '../../renderer/stores/drafts.js';
import { usePlansStore } from '../../renderer/stores/plans.js';
import { useLlmNotificationsStore } from '../../renderer/stores/llmNotifications.js';
import { state } from '../../renderer/state.js';
import { sessionsState } from '../../renderer/screens/sessions-state.js';

const memoryStorage = (() => {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
    clear: () => { backing.clear(); },
  };
})();

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage);
  localStorage.clear();
  setActivePinia(createPinia());

  // Reset state between tests
  state.sessions = [];
  state.activeSessionId = null;
  state.currentScreen = 'sessions';
  state.gamepadCount = 0;
  state.eventLog = [];
  state.cliTypes = [];
  state.availableSpawnTypes = [];
  state.cliBindingsCache = {};
  state.cliToolsCache = {};
  state.settingsTab = 'profiles';
  state.activeProfile = 'default';

  resetActiveSessionPinForTests();

  sessionsState.activeFocus = 'sessions';
  sessionsState.sessionsFocusIndex = 0;
  sessionsState.overviewGroup = null;
  sessionsState.overviewIsGlobal = false;
});

// ---------------------------------------------------------------------------
// useAppStore
// ---------------------------------------------------------------------------

describe('useAppStore', () => {
  it('reads from the reactive state singleton', () => {
    const store = useAppStore();
    state.currentScreen = 'settings';
    expect(store.state.currentScreen).toBe('settings');
  });

  it('activeSession returns the matching session', () => {
    const store = useAppStore();
    state.sessions = [
      { id: 's1', name: 'A', cliType: 'claude-code', processId: 1 },
      { id: 's2', name: 'B', cliType: 'copilot-cli', processId: 2 },
    ];
    state.activeSessionId = 's2';
    expect(store.activeSession?.name).toBe('B');
  });

  it('activeSession is undefined when no session is active', () => {
    const store = useAppStore();
    state.activeSessionId = null;
    expect(store.activeSession).toBeUndefined();
  });

  it('setActiveSessionId moves the active session while unpinned', () => {
    const store = useAppStore();
    store.setActiveSessionId('s1');
    expect(state.activeSessionId).toBe('s1');
    store.setActiveSessionId('s2');
    expect(state.activeSessionId).toBe('s2');
    expect(store.isActiveSessionPinned()).toBe(false);
  });

  it('pinActiveSession locks the window to one session', () => {
    const store = useAppStore();
    store.pinActiveSession('popout-session');
    expect(state.activeSessionId).toBe('popout-session');
    expect(store.isActiveSessionPinned()).toBe(true);

    // A stray navigation is refused rather than thrown: it must not take the
    // pop-out window down with it.
    expect(() => store.setActiveSessionId('other-session')).not.toThrow();
    expect(state.activeSessionId).toBe('popout-session');
    store.setActiveSessionId(null);
    expect(state.activeSessionId).toBe('popout-session');
  });

  it('addSession pushes to state.sessions', () => {
    const store = useAppStore();
    store.addSession({ id: 's1', name: 'Test', cliType: 'test', processId: 1 });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].name).toBe('Test');
  });

  it('removeSession splices from state.sessions', () => {
    const store = useAppStore();
    state.sessions = [{ id: 's1', name: 'A', cliType: 'test', processId: 1 }];
    store.removeSession('s1');
    expect(state.sessions).toHaveLength(0);
  });

  it('updateSession merges updates into existing session', () => {
    const store = useAppStore();
    state.sessions = [{ id: 's1', name: 'Old', cliType: 'test', processId: 1 }];
    store.updateSession('s1', { name: 'New' });
    expect(state.sessions[0].name).toBe('New');
  });

  it('sessionCount excludes attached remote views', () => {
    const store = useAppStore();
    expect(store.sessionCount).toBe(0);
    state.sessions = [
      { id: 's1', name: 'A', cliType: 'test', processId: 1 },
      { id: 'r1', name: 'Remote', cliType: 'test', processId: 2, remote: { peerId: 'peer', sessionId: 'remote' } },
    ];
    expect(store.sessionCount).toBe(1);
  });

  it('logEvent caps at 100 entries', () => {
    const store = useAppStore();
    for (let i = 0; i < 105; i++) {
      store.logEvent({ time: `${i}`, event: `e${i}` });
    }
    expect(state.eventLog).toHaveLength(100);
    expect(state.eventLog[0].event).toBe('e5');
  });
});

// ---------------------------------------------------------------------------
// useSessionsScreenStore
// ---------------------------------------------------------------------------

describe('useSessionsScreenStore', () => {
  it('reads from the reactive sessionsState singleton', () => {
    const store = useSessionsScreenStore();
    sessionsState.activeFocus = 'spawn';
    expect(store.sessionsState.activeFocus).toBe('spawn');
  });

  it('isOverviewOpen reflects overviewGroup', () => {
    const store = useSessionsScreenStore();
    expect(store.isOverviewOpen).toBe(false);
    sessionsState.overviewGroup = '/some/dir';
    expect(store.isOverviewOpen).toBe(true);
  });

  it('openOverview sets group and resets index', () => {
    const store = useSessionsScreenStore();
    sessionsState.overviewFocusIndex = 5;
    store.openOverview('/dir', true);
    expect(sessionsState.overviewGroup).toBe('/dir');
    expect(sessionsState.overviewIsGlobal).toBe(true);
    expect(sessionsState.overviewFocusIndex).toBe(0);
  });

  it('closeOverview clears overview state', () => {
    const store = useSessionsScreenStore();
    sessionsState.overviewGroup = '/dir';
    sessionsState.overviewIsGlobal = true;
    store.closeOverview();
    expect(sessionsState.overviewGroup).toBeNull();
    expect(sessionsState.overviewIsGlobal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useConfigStore
// ---------------------------------------------------------------------------

describe('useConfigStore', () => {
  it('getBindings returns empty object for unknown CLI type', () => {
    const store = useConfigStore();
    expect(store.getBindings('unknown')).toEqual({});
  });

  it('getBindings returns cached bindings', () => {
    const store = useConfigStore();
    state.cliBindingsCache = { 'claude-code': { A: { action: 'keyboard' } } };
    expect(store.getBindings('claude-code')).toEqual({ A: { action: 'keyboard' } });
  });

  it('setCliTypes updates state', () => {
    const store = useConfigStore();
    store.setCliTypes(['a', 'b']);
    expect(state.cliTypes).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// useDraftsStore
// ---------------------------------------------------------------------------

describe('useDraftsStore', () => {
  it('tracks draft counts per session', () => {
    const store = useDraftsStore();
    store.setDraftCount('s1', 3);
    expect(store.getDraftCount('s1')).toBe(3);
    expect(store.getDraftCount('s2')).toBe(0);
  });

  it('removes entry when count is 0', () => {
    const store = useDraftsStore();
    store.setDraftCount('s1', 3);
    store.setDraftCount('s1', 0);
    expect(store.draftCounts.size).toBe(0);
  });

  it('clearCounts empties the map', () => {
    const store = useDraftsStore();
    store.setDraftCount('s1', 1);
    store.setDraftCount('s2', 2);
    store.clearCounts();
    expect(store.draftCounts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// usePlansStore
// ---------------------------------------------------------------------------

describe('usePlansStore', () => {
  it('tracks doing and startable counts', () => {
    const store = usePlansStore();
    store.setDoingCount('s1', 2);
    store.setStartableCount('s1', 5);
    expect(store.getDoingCount('s1')).toBe(2);
    expect(store.getStartableCount('s1')).toBe(5);
  });

  it('clearCounts resets both maps', () => {
    const store = usePlansStore();
    store.setDoingCount('s1', 1);
    store.setStartableCount('s1', 1);
    store.clearCounts();
    expect(store.getDoingCount('s1')).toBe(0);
    expect(store.getStartableCount('s1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// useLlmNotificationsStore
// ---------------------------------------------------------------------------

describe('useLlmNotificationsStore', () => {
  it('adds notifications and groups them by sessionId', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'Title 1', content: 'Content 1' });
    expect(store.notifications).toHaveLength(1);
    expect(store.bySession.get('s1')).toHaveLength(1);
    const notif = store.bySession.get('s1')?.[0];
    expect(notif?.title).toBe('Title 1');
    expect(notif?.content).toBe('Content 1');
  });

  it('prepends newer notifications instead of overwriting older ones', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'T1', content: 'C1' });
    store.add({ sessionId: 's1', title: 'T2', content: 'C2' });
    const notifications = store.bySession.get('s1') ?? [];
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.title).toBe('T2');
    expect(notifications[1]?.title).toBe('T1');
  });

  it('dismisses notifications by notification id', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'Title', content: 'Content' });
    const notificationId = store.notifications[0]?.id;
    expect(notificationId).toBeTruthy();
    store.dismiss(notificationId!);
    expect(store.notifications).toHaveLength(0);
  });

  it('dismisses all notifications for one session', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'T1', content: 'C1' });
    store.add({ sessionId: 's1', title: 'T2', content: 'C2' });
    store.add({ sessionId: 's2', title: 'T3', content: 'C3' });
    store.dismissSession('s1');
    expect(store.bySession.has('s1')).toBe(false);
    expect(store.bySession.get('s2')).toHaveLength(1);
  });

  it('clears all notifications', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'T1', content: 'C1' });
    store.add({ sessionId: 's2', title: 'T2', content: 'C2' });
    store.clear();
    expect(store.notifications).toHaveLength(0);
  });

  it('persists notifications into localStorage', () => {
    const store = useLlmNotificationsStore();
    store.add({ sessionId: 's1', title: 'Title', content: 'Content' });
    expect(store.bySession.has('s1')).toBe(true);
    const raw = localStorage.getItem('helm.llmNotifications.v1');
    expect(raw).toContain('"sessionId":"s1"');
  });
});
