/**
 * SessionList focus tests — regression guard for the highlight/terminal desync.
 *
 * Root cause of the historical bug: the sidebar highlight was rendered from a
 * stored numeric index into the (reorderable) navList. When navList was
 * reordered/rebuilt (activity re-sort, spawn, close) the index silently pointed
 * at a different card than the active terminal — realigning only after cycling
 * all the way around. The fix renders the highlight from the identity-based
 * focusedNavItem instead, which cannot drift on reorder.
 *
 * These tests lock in identity-based highlighting.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';
import { isNavItemFocused } from '../../../renderer/session-groups.js';
import { state } from '../../../renderer/state.js';
import { sessionsState } from '../../../renderer/stores/sessions-screen.js';

describe('isNavItemFocused (pure highlight decision)', () => {
  it('matches by identity {type,id}, independent of any list ordering', () => {
    const focused = { id: 'sB', type: 'session-card' };
    expect(isNavItemFocused('sessions', focused, 'session-card', 'sB')).toBe(true);
    expect(isNavItemFocused('sessions', focused, 'session-card', 'sA')).toBe(false);
  });

  it('does not match a different nav item type with the same id', () => {
    const focused = { id: 'x', type: 'group-header' };
    expect(isNavItemFocused('sessions', focused, 'session-card', 'x')).toBe(false);
    expect(isNavItemFocused('sessions', focused, 'group-header', 'x')).toBe(true);
  });

  it('is suppressed when the sessions zone is not the active focus', () => {
    const focused = { id: 'sB', type: 'session-card' };
    expect(isNavItemFocused('spawn', focused, 'session-card', 'sB')).toBe(false);
    expect(isNavItemFocused('plans', focused, 'session-card', 'sB')).toBe(false);
  });

  it('is false when there is no focused item', () => {
    expect(isNavItemFocused('sessions', null, 'session-card', 'sB')).toBe(false);
    expect(isNavItemFocused('sessions', undefined, 'session-card', 'sB')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const CardStub = {
  props: ['isFocused', 'isActive', 'session'],
  template: '<div class="card" :data-id="session.id" :class="{ focused: isFocused, active: isActive }"></div>',
};

function mountList(overrides: Record<string, unknown> = {}) {
  const props = {
    hasSessions: true,
    groups: [
      {
        dirPath: '/repo',
        collapsed: false,
        sessions: [
          { id: 'sA', name: 'A', cliType: 'claude' },
          { id: 'sB', name: 'B', cliType: 'claude' },
        ],
      },
    ],
    directories: [],
    navIndexMap: new Map<string, number>([['/repo', 1], ['sA', 2], ['sB', 3]]),
    activeFocus: 'sessions',
    focusedNavItem: { id: 'sB', type: 'session-card' } as { id: string; type: string } | null,
    focusColumn: 0 as 0 | 1 | 2 | 3 | 4,
    activeSessionId: 'sB' as string | null,
    editingSessionId: null as string | null,
    sessionStates: new Map<string, string>(),
    sessionActivityLevels: new Map<string, string>(),
    artifactCounts: new Map<string, number>(),
    workingPlanLabels: new Map<string, string>(),
    workingPlanTooltips: new Map<string, string>(),
    pendingSchedules: new Map<string, string>(),
    snappedOutSessions: new Set<string>(),
    llmNotifications: new Map(),
    getCliDisplayName: (t: string) => t,
    resolveGroupDisplayName: (p: string) => p,
    sessionElapsedText: () => '',
    sessionShortcutMap: new Map<string, number>(),
    ...overrides,
  };
  return mount(SessionList, {
    props,
    global: { stubs: { SessionGroup: { template: '<div><slot /></div>' }, SessionCard: CardStub } },
  });
}

describe('SessionList highlight rendering', () => {
  afterEach(() => {
    state.sessions = [];
    state.activeSessionId = null;
    sessionsState.showHiddenSessions = false;
  });

  it('shows the hidden toggle only when there are hidden rows to reveal', async () => {
    state.sessions = [{ id: 'hidden', name: 'Hidden', cliType: 'claude', processId: 1, hidden: true }];
    state.activeSessionId = null;
    const w = mountList();

    expect(w.findAll('.runtime-list-actions .runtime-action').map(button => button.text()))
      .toContain('Show hidden (1)');
    const showHidden = w.findAll('.runtime-list-actions .runtime-action')
      .find(button => button.text() === 'Show hidden (1)')!;
    await showHidden.trigger('click');
    expect(sessionsState.showHiddenSessions).toBe(true);

    state.activeSessionId = 'hidden';
    await nextTick();
    expect(sessionsState.showHiddenSessions).toBe(false);
    expect(w.findAll('.runtime-list-actions .runtime-action').map(button => button.text()))
      .not.toContain('Show hidden (1)');
  });

  it('highlights the card matching focusedNavItem', () => {
    const w = mountList();
    expect(w.get('[data-id="sB"]').classes()).toContain('focused');
    expect(w.get('[data-id="sA"]').classes()).not.toContain('focused');
  });

  it('highlight follows the session identity across a navList reorder (regression)', async () => {
    const w = mountList();
    expect(w.get('[data-id="sB"]').classes()).toContain('focused');

    // Reorder the group's sessions — the historical index-based highlight would
    // now point at the wrong card; identity-based highlight must still track sB.
    await w.setProps({
      groups: [
        {
          dirPath: '/repo',
          collapsed: false,
          sessions: [
            { id: 'sB', name: 'B', cliType: 'claude' },
            { id: 'sA', name: 'A', cliType: 'claude' },
          ],
        },
      ],
    });
    await nextTick();

    expect(w.get('[data-id="sB"]').classes()).toContain('focused');
    expect(w.get('[data-id="sA"]').classes()).not.toContain('focused');
  });
});
