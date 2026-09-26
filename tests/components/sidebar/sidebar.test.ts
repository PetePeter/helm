/**
 * Sidebar component tests — Phase 4 Vue SFC sidebar components.
 *
 * Tests all 11 sidebar components using @vue/test-utils mount().
 * Each component is tested for rendering, props reactivity, events, and interactions.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

// ============================================================================
// SessionCard
// ============================================================================

import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';

function makeCardProps(overrides: Record<string, any> = {}) {
  return {
    session: { id: 's1', name: 'test-session', cliType: 'claude-code', title: '' },
    navIndex: 2,
    sessionState: 'idle',
    activityLevel: 'active',
    displayName: 'Claude',
    draftCount: 0,
    artifactCount: 0,
    elapsedText: '',
    workingPlanLabel: '',
    workingPlanTooltip: '',
    isActive: false,
    isFocused: false,
    focusColumn: 0,
    isEditing: false,
    isHiddenFromOverview: false,
    ...overrides,
  };
}

describe('SessionCard', () => {
  it('renders session name and state label', () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    expect(w.find('.session-name').text()).toBe('Claude');
    expect(w.find('.session-state-btn').text()).toContain('Idle');
  });

  it('shows activity dot with correct color', () => {
    const w = mount(SessionCard, { props: makeCardProps({ activityLevel: 'active' }) });
    const dot = w.find('.session-activity-dot');
    expect(dot.attributes('style')).toContain('rgb(68, 204, 68)');
  });

  it('shows inactive color', () => {
    const w = mount(SessionCard, { props: makeCardProps({ activityLevel: 'inactive' }) });
    const dot = w.find('.session-activity-dot');
    expect(dot.attributes('style')).toContain('rgb(68, 136, 255)');
  });

  it('shows idle (grey) color', () => {
    const w = mount(SessionCard, { props: makeCardProps({ activityLevel: 'idle' }) });
    const dot = w.find('.session-activity-dot');
    expect(dot.attributes('style')).toContain('rgb(85, 85, 85)');
  });

  it('adds active class when isActive', () => {
    const w = mount(SessionCard, { props: makeCardProps({ isActive: true }) });
    expect(w.find('.session-card').classes()).toContain('active');
  });

  it('adds focused class when isFocused', () => {
    const w = mount(SessionCard, { props: makeCardProps({ isFocused: true }) });
    expect(w.find('.session-card').classes()).toContain('focused');
  });

  it('shows draft badge when draftCount > 0', () => {
    const w = mount(SessionCard, { props: makeCardProps({ draftCount: 3 }) });
    expect(w.find('.draft-badge').text()).toContain('3');
  });

  it('hides draft badge when draftCount is 0', () => {
    const w = mount(SessionCard, { props: makeCardProps({ draftCount: 0 }) });
    expect(w.find('.draft-badge').exists()).toBe(false);
  });

  it('shows elapsed text', () => {
    const w = mount(SessionCard, { props: makeCardProps({ elapsedText: '2m ago' }) });
    expect(w.find('.session-timer').text()).toBe('2m ago');
  });

  it('shows meta line when title differs from displayName', () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        session: { id: 's1', name: 'test', cliType: 'claude-code', title: 'Refactoring auth module' },
        displayName: 'Claude',
      }),
    });
    expect(w.find('.session-meta').text()).toBe('Refactoring auth module');
  });

  it('hides meta line when title matches displayName', () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        session: { id: 's1', name: 'Claude', cliType: 'claude-code', title: 'Claude' },
        displayName: 'Claude',
      }),
    });
    expect(w.find('.session-meta').exists()).toBe(false);
  });

  it('keeps terminal title beside the name and puts the working plan on the next row', () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        session: { id: 's1', name: 'test', cliType: 'claude-code', title: 'Terminal title' },
        displayName: 'Session name',
        workingPlanLabel: '🗺️ Working plan',
        workingPlanTooltip: 'Working plan details',
      }),
    });
    const identityRow = w.find('.session-name-line');
    const plan = w.find('.session-working-plan');

    expect(identityRow.find('.session-name').text()).toBe('Session name');
    expect(identityRow.find('.session-meta').text()).toBe('Terminal title');
    expect(plan.text()).toBe('🗺️ Working plan');
    expect(identityRow.element.contains(w.find('.session-meta').element)).toBe(true);
    expect(identityRow.element.compareDocumentPosition(plan.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('keeps the terminal title on its own row while renaming', () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        session: { id: 's1', name: 'test', cliType: 'claude-code', title: 'Terminal title' },
        displayName: 'Session name',
        isEditing: true,
      }),
    });

    expect(w.find('.session-name-line .session-meta').exists()).toBe(false);
    expect(w.find('.session-meta').text()).toBe('Terminal title');
    expect(w.find('.session-rename-input').exists()).toBe(true);
  });

  it('shows rename input when isEditing', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    await nextTick();
    expect(w.find('.session-rename-input').exists()).toBe(true);
    expect(w.find('.session-rename-save').exists()).toBe(true);
    expect(w.find('.session-rename-cancel').exists()).toBe(true);
  });

  it('hides rename button when isEditing', () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    expect(w.find('.session-rename').exists()).toBe(false);
  });

  it('emits click on card click', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-card').trigger('click');
    expect(w.emitted('click')).toEqual([['s1']]);
  });

  it('emits rename on rename button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-rename').trigger('click');
    expect(w.emitted('rename')).toEqual([['s1']]);
  });

  it('clicking the session name selects the row instead of opening rename', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-name').trigger('click');
    expect(w.emitted('click')).toEqual([['s1']]);
    expect(w.emitted('rename')).toBeUndefined();
  });

  it('emits close on close button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-close').trigger('click');
    expect(w.emitted('close')).toEqual([['s1', 'Claude']]);
  });

  it('emits toggleOverview on eye button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-overview-toggle').trigger('click');
    expect(w.emitted('toggleOverview')).toEqual([['s1']]);
  });

  it('shows eye icon based on overview visibility', () => {
    const hidden = mount(SessionCard, { props: makeCardProps({ isHiddenFromOverview: true }) });
    expect(hidden.find('.session-overview-toggle').text()).toBe('👁‍🗨');

    const visible = mount(SessionCard, { props: makeCardProps({ isHiddenFromOverview: false }) });
    expect(visible.find('.session-overview-toggle').text()).toBe('👁');
  });

  it('emits commitRename on save button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    await nextTick();
    const input = w.find('.session-rename-input');
    await input.setValue('new-name');
    await w.find('.session-rename-save').trigger('click');
    expect(w.emitted('commitRename')).toEqual([['s1', 'new-name']]);
  });

  it('emits cancelRename on cancel button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    await nextTick();
    await w.find('.session-rename-cancel').trigger('click');
    expect(w.emitted('cancelRename')).toBeTruthy();
  });

  it('emits commitRename on Enter key in input', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    await nextTick();
    const input = w.find('.session-rename-input');
    await input.setValue('enter-name');
    await input.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('commitRename')).toEqual([['s1', 'enter-name']]);
  });

  it('emits cancelRename on Escape key in input', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ isEditing: true }) });
    await nextTick();
    await w.find('.session-rename-input').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('cancelRename')).toBeTruthy();
  });

  it('shows state dropdown on state button click', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-state-btn').trigger('click');
    expect(w.find('.session-state-dropdown').exists()).toBe(true);
    const options = w.findAll('.session-state-option');
    expect(options.length).toBe(5);
  });

  it('emits stateChange when selecting from dropdown', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-state-btn').trigger('click');
    const options = w.findAll('.session-state-option');
    await options[0].trigger('click'); // implementing
    expect(w.emitted('stateChange')).toEqual([['s1', 'implementing']]);
  });

  it('shows state labels correctly', () => {
    const implementing = mount(SessionCard, { props: makeCardProps({ sessionState: 'implementing' }) });
    expect(implementing.find('.session-state-btn').text()).toContain('Implementing');

    const waiting = mount(SessionCard, { props: makeCardProps({ sessionState: 'waiting' }) });
    expect(waiting.find('.session-state-btn').text()).toContain('Waiting');
  });

  it('applies card-col-focused to correct column button', () => {
    const w = mount(SessionCard, { props: makeCardProps({ isFocused: true, focusColumn: 4 }) });
    expect(w.find('.session-close').classes()).toContain('card-col-focused');
    expect(w.find('.session-state-btn').classes()).not.toContain('card-col-focused');
  });

  it('shows working plan label', () => {
    const w = mount(SessionCard, {
      props: makeCardProps({ workingPlanLabel: '🗺️ Auth refactor', workingPlanTooltip: 'Auth refactor\nIn progress' }),
    });
    expect(w.find('.session-working-plan').text()).toBe('🗺️ Auth refactor');
  });

  it('closes state dropdown when close-state-dropdown event is dispatched', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-state-btn').trigger('click');
    expect(w.find('.session-state-dropdown').exists()).toBe(true);
    w.element.dispatchEvent(new CustomEvent('close-state-dropdown'));
    await nextTick();
    expect(w.find('.session-state-dropdown').exists()).toBe(false);
  });

  it('opens state dropdown when open-state-dropdown event is dispatched', async () => {
    const w = mount(SessionCard, { props: makeCardProps() });
    expect(w.find('.session-state-dropdown').exists()).toBe(false);
    w.element.dispatchEvent(new CustomEvent('open-state-dropdown'));
    await nextTick();
    expect(w.find('.session-state-dropdown').exists()).toBe(true);
  });

  it('renders explicit nav index hook on the row root', () => {
    const w = mount(SessionCard, { props: makeCardProps({ navIndex: 7 }) });
    expect(w.find('.session-card').attributes('data-nav-index')).toBe('7');
  });

  it('emits cancelSchedule when pending schedule cancel is clicked', async () => {
    const w = mount(SessionCard, { props: makeCardProps({ scheduledAt: 'tomorrow 10:00' }) });
    await w.find('.session-schedule-cancel').trigger('click');
    expect(w.emitted('cancelSchedule')).toEqual([['s1']]);
  });

  it('shows snapped-out state on the row root', () => {
    const w = mount(SessionCard, { props: makeCardProps({ isSnappedOut: true }) });
    expect(w.find('.session-card').classes()).toContain('snapped-out');
    expect(w.find('.snap-indicator').exists()).toBe(true);
  });

  it('keeps notification carousel when the row is selected', async () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        llmNotifications: [{ id: 'n1', title: 'Need input', content: 'Pick a plan' }],
      }),
    });

    await w.find('.session-card').trigger('click');

    expect(w.emitted('click')).toEqual([['s1']]);
    expect(w.emitted('dismissNotification')).toBeUndefined();
    expect(w.find('.notification-carousel').exists()).toBe(true);
  });

  it('dismisses notification only from the carousel dismiss button', async () => {
    const w = mount(SessionCard, {
      props: makeCardProps({
        llmNotifications: [{ id: 'n1', title: 'Need input', content: 'Pick a plan' }],
      }),
    });

    await w.find('.dismiss-btn').trigger('click');

    expect(w.emitted('dismissNotification')).toEqual([['n1']]);
    expect(w.emitted('click')).toBeUndefined();
  });

  it('copies session ref to clipboard on copy-id button click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const w = mount(SessionCard, { props: makeCardProps() });
    const btn = w.find('.session-copy-id');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe('🔗');

    await btn.trigger('click');
    await nextTick();

    expect(writeText).toHaveBeenCalledWith(
      'helm session: "test-session" (claude-code) id=s1',
    );

    vi.restoreAllMocks();
  });

  it('does not emit card click when copy-id button is clicked', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

    const w = mount(SessionCard, { props: makeCardProps() });
    await w.find('.session-copy-id').trigger('click');

    expect(w.emitted('click')).toBeUndefined();

    vi.restoreAllMocks();
  });
});

// ============================================================================
// SessionGroup
// ============================================================================

import SessionGroup from '../../../renderer/components/sidebar/SessionGroup.vue';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';

function makeGroupProps(overrides: Record<string, any> = {}) {
  return {
    group: {
      dirPath: '/home/user/project',
      displayName: 'project',
      collapsed: false,
      sessionCount: 3,
    },
    navIndex: 1,
    isFocused: false,
    ...overrides,
  };
}

describe('SessionGroup', () => {
  it('renders group name with session count', () => {
    const w = mount(SessionGroup, { props: makeGroupProps() });
    expect(w.find('.group-name').text()).toBe('project (3)');
  });

  it('renders one right-aligned activity dot per member in order', () => {
    const w = mount(SessionGroup, {
      props: makeGroupProps({
        group: {
          dirPath: '/home/user/project',
          displayName: 'project',
          collapsed: false,
          sessionCount: 3,
          sessions: [
            { id: 's1', name: 'active', activityLevel: 'active' },
            { id: 's2', name: 'recent', activityLevel: 'inactive' },
            { id: 's3', name: 'idle', activityLevel: 'idle' },
          ],
        },
      }),
    });

    const dots = w.findAll('.group-activity-dot');
    expect(dots).toHaveLength(3);
    expect(dots[0].attributes('style')).toContain('rgb(68, 204, 68)');
    expect(dots[1].attributes('style')).toContain('rgb(68, 136, 255)');
    expect(dots[2].attributes('style')).toContain('rgb(85, 85, 85)');
    expect(dots[0].attributes('title')).toBe('active: active');
    expect(w.find('.group-activity-dots').attributes('aria-label')).toContain('recent inactive');
    expect(w.find('.group-header-trailing').exists()).toBe(true);
  });

  it('keeps activity dots visible for a collapsed group', () => {
    const w = mount(SessionGroup, {
      props: makeGroupProps({
        group: {
          dirPath: '/home/user/project',
          displayName: 'project',
          collapsed: true,
          sessionCount: 1,
          sessions: [{ id: 's1', name: 'active', activityLevel: 'active' }],
        },
      }),
    });

    expect(w.findAll('.group-activity-dot')).toHaveLength(1);
  });

  it('does not render an activity dot cluster for an empty group', () => {
    const w = mount(SessionGroup, {
      props: makeGroupProps({
        group: {
          dirPath: '/home/user/project',
          displayName: 'project',
          collapsed: false,
          sessionCount: 0,
          sessions: [],
        },
      }),
    });

    expect(w.find('.group-activity-dots').exists()).toBe(false);
  });

  it('shows expanded chevron when not collapsed', () => {
    const w = mount(SessionGroup, { props: makeGroupProps() });
    expect(w.find('.group-chevron').text()).toBe('▼');
  });

  it('shows collapsed chevron when collapsed', () => {
    const w = mount(SessionGroup, {
      props: makeGroupProps({ group: { dirPath: '/a', displayName: 'a', collapsed: true, sessionCount: 1 } }),
    });
    expect(w.find('.group-chevron').text()).toBe('▲');
  });

  it('emits toggleCollapse on header click', async () => {
    const w = mount(SessionGroup, { props: makeGroupProps() });
    await w.find('.group-header').trigger('click');
    expect(w.emitted('toggleCollapse')).toEqual([['/home/user/project']]);
  });

  it('does not render move buttons', () => {
    const w = mount(SessionGroup, { props: makeGroupProps() });
    expect(w.find('.group-move-up').exists()).toBe(false);
    expect(w.find('.group-move-down').exists()).toBe(false);
  });

  it('emits showOverview on group name click', async () => {
    const w = mount(SessionGroup, { props: makeGroupProps() });
    await w.find('.group-name').trigger('click');
    expect(w.emitted('showOverview')).toEqual([['/home/user/project']]);
  });

  it('applies focused class when isFocused', () => {
    const w = mount(SessionGroup, { props: makeGroupProps({ isFocused: true }) });
    expect(w.find('.group-header').classes()).toContain('focused');
  });

  it('renders explicit nav index hook on the group root', () => {
    const w = mount(SessionGroup, { props: makeGroupProps({ navIndex: 5 }) });
    expect(w.find('.group-header').attributes('data-nav-index')).toBe('5');
  });
});

// ============================================================================
// SessionList
// ============================================================================

function makeSessionListProps(overrides: Record<string, any> = {}) {
  return {
    hasSessions: true,
    groups: [
      {
        dirPath: '/workspace/a',
        collapsed: false,
        sessions: [
          { id: 's1', name: 'alpha', cliType: 'claude-code', title: 'Auth work' },
        ],
      },
      {
        dirPath: '/workspace/empty',
        collapsed: false,
        sessions: [],
      },
    ],
    directories: [
      { name: 'a', path: '/workspace/a' },
      { name: 'empty', path: '/workspace/empty' },
    ],
    navIndexMap: new Map([
      ['/workspace/a', 0],
      ['s1', 1],
    ]),
    activeFocus: 'sessions',
    focusedNavItem: { id: '/workspace/a', type: 'group-header' } as { id: string; type: string } | null,
    focusColumn: 0,
    activeSessionId: null,
    editingSessionId: null,
    sessionStates: new Map([['s1', 'idle']]),
    sessionActivityLevels: new Map([['s1', 'active']]),
    draftCounts: new Map([['s1', 2]]),
    artifactCounts: new Map<string, number>(),
    workingPlanLabels: new Map([['s1', 'Plan A']]),
    workingPlanTooltips: new Map([['s1', 'Plan A tooltip']]),
    pendingSchedules: new Map([['s1', 'tomorrow']]),
    snappedOutSessions: new Set<string>(),
    llmNotifications: new Map(),
    getCliDisplayName: vi.fn((cliType: string) => cliType === 'claude-code' ? 'Claude' : cliType),
    resolveGroupDisplayName: vi.fn((dirPath: string) => dirPath.split('/').pop() || dirPath),
    isSessionHiddenFromOverview: vi.fn(() => false),
    sessionElapsedText: vi.fn(() => '2m ago'),
    sessionShortcutMap: new Map<string, number>([['s1', 1]]),
    ...overrides,
  };
}

describe('SessionList', () => {
  it('owns the scrollable sessionsList container and New Group action', () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    expect(w.find('#sessionsList').exists()).toBe(true);
    const action = w.find('.runtime-list-actions .runtime-action');
    expect(action.exists()).toBe(true);
    expect(action.text()).toContain('New Group');
  });

  it('renders grouped sessions through SessionGroup and SessionCard', () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    expect(w.findAll('.group-header')).toHaveLength(1);
    expect(w.findAll('.session-card')).toHaveLength(1);
    expect(w.find('.group-header').attributes('data-nav-index')).toBe('0');
    expect(w.find('.session-card').attributes('data-nav-index')).toBe('1');
  });

  it('passes each member activity level to its group header dot', () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    const dot = w.find('.group-activity-dot');

    expect(dot.exists()).toBe(true);
    expect(dot.attributes('style')).toContain('rgb(68, 204, 68)');
  });

  it('emits newGroup on New Group segment click', async () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    await w.find('.runtime-list-actions .runtime-action').trigger('click');
    expect(w.emitted('newGroup')).toEqual([[]]);
  });

  it('forwards session and group events', async () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    await w.find('.group-name').trigger('click');
    expect(w.emitted('showOverview')).toEqual([['/workspace/a']]);

    await w.find('.session-card').trigger('click');
    expect(w.emitted('sessionClick')).toEqual([['s1']]);
  });

  it('forwards notification dismiss without treating it as a session click', async () => {
    const w = mount(SessionList, {
      props: makeSessionListProps({
        llmNotifications: new Map([
          ['s1', [{ id: 'n1', title: 'Need input', content: 'Pick a plan' }]],
        ]),
      }),
    });

    await w.find('.dismiss-btn').trigger('click');

    expect(w.emitted('dismissNotification')).toEqual([['n1']]);
    expect(w.emitted('sessionClick')).toBeUndefined();
  });

  it('forwards row-owned action events', async () => {
    const w = mount(SessionList, { props: makeSessionListProps() });
    await w.find('.session-overview-toggle').trigger('click');
    expect(w.emitted('toggleOverview')).toEqual([['s1']]);

    await w.find('.session-schedule-cancel').trigger('click');
    expect(w.emitted('cancelSchedule')).toEqual([['s1']]);
  });

  it('shows empty state when there are no sessions', () => {
    const w = mount(SessionList, {
      props: makeSessionListProps({
        hasSessions: false,
        groups: [],
        navList: [],
      }),
    });
    expect(w.find('.overview-nav-button').exists()).toBe(false);
    expect(w.find('.sessions-empty').text()).toContain('No active sessions');
  });

  it('does not render cards for collapsed groups', () => {
    const w = mount(SessionList, {
      props: makeSessionListProps({
        groups: [{
          dirPath: '/workspace/a',
          collapsed: true,
          sessions: [{ id: 's1', name: 'alpha', cliType: 'claude-code', title: 'Auth work' }],
        }],
      }),
    });
    expect(w.findAll('.group-header')).toHaveLength(1);
    expect(w.findAll('.session-card')).toHaveLength(0);
  });

  it('renders long grouped lists inside the shared scroll region without dropping row actions', () => {
    const manySessions = Array.from({ length: 24 }, (_, index) => ({
      id: `s${index + 1}`,
      name: `session-${index + 1}`,
      cliType: 'claude-code',
      title: `Task ${index + 1}`,
    }));
    const navIndexMap = new Map<string, number>([['/workspace/a', 1]]);
    manySessions.forEach((session, index) => {
      navIndexMap.set(session.id, index + 2);
    });

    const w = mount(SessionList, {
      props: makeSessionListProps({
        groups: [{ dirPath: '/workspace/a', collapsed: false, sessions: manySessions }],
        navIndexMap,
        focusedNavItem: { id: 's24', type: 'session-card' },
        focusColumn: 4,
      }),
    });

    const list = w.get('#sessionsList');
    const cards = list.findAll('.session-card');
    expect(cards).toHaveLength(24);
    expect(list.findAll('.group-header')).toHaveLength(1);
    expect(cards.at(-1)?.attributes('data-nav-index')).toBe('25');
    expect(cards.at(-1)?.classes()).toContain('focused');
    expect(cards.at(-1)?.find('.session-close').classes()).toContain('card-col-focused');
    expect(cards.at(-1)?.find('.session-state-btn').exists()).toBe(true);
    expect(cards.at(-1)?.find('.session-rename').exists()).toBe(true);
    expect(cards.at(-1)?.find('.session-overview-toggle').exists()).toBe(true);
  });
});

// ============================================================================
// SpawnGrid
// ============================================================================

import SpawnGrid from '../../../renderer/components/sidebar/SpawnGrid.vue';

describe('SpawnGrid', () => {
  const items = [
    { cliType: 'claude-code', displayName: 'Claude' },
    { cliType: 'copilot-cli', displayName: 'Copilot' },
  ];

  it('renders spawn buttons for each item', () => {
    const w = mount(SpawnGrid, { props: { items, focusIndex: 0, isActive: false } });
    const buttons = w.findAll('.spawn-btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0].find('.spawn-label').text()).toBe('Claude');
    expect(buttons[1].find('.spawn-label').text()).toBe('Copilot');
  });

  it('applies focused class to active item', () => {
    const w = mount(SpawnGrid, { props: { items, focusIndex: 1, isActive: true } });
    const buttons = w.findAll('.spawn-btn');
    expect(buttons[0].classes()).not.toContain('focused');
    expect(buttons[1].classes()).toContain('focused');
  });

  it('does not apply focused when not active zone', () => {
    const w = mount(SpawnGrid, { props: { items, focusIndex: 0, isActive: false } });
    expect(w.findAll('.spawn-btn')[0].classes()).not.toContain('focused');
  });

  it('emits spawn on button click', async () => {
    const w = mount(SpawnGrid, { props: { items, focusIndex: 0, isActive: false } });
    await w.findAll('.spawn-btn')[1].trigger('click');
    expect(w.emitted('spawn')).toEqual([['copilot-cli']]);
  });

  it('renders empty grid when no items', () => {
    const w = mount(SpawnGrid, { props: { items: [], focusIndex: 0, isActive: false } });
    expect(w.findAll('.spawn-btn').length).toBe(0);
  });
});

// ============================================================================
// SortBar
// ============================================================================

import SortBar from '../../../renderer/components/sidebar/SortBar.vue';

describe('SortBar', () => {
  const options = [
    { value: 'state', label: 'State' },
    { value: 'name', label: 'Name' },
    { value: 'activity', label: 'Activity' },
  ];

  it('displays current field label', () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    expect(w.find('.sort-field-btn').text()).toContain('State');
  });

  it('displays ascending arrow', () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    expect(w.find('.sort-direction-btn').text()).toBe('↑');
  });

  it('displays descending arrow', () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'desc' } });
    expect(w.find('.sort-direction-btn').text()).toBe('↓');
  });

  it('opens dropdown on field button click', async () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    expect(w.find('.sort-dropdown').exists()).toBe(false);
    await w.find('.sort-field-btn').trigger('click');
    expect(w.find('.sort-dropdown').exists()).toBe(true);
    expect(w.findAll('.sort-dropdown-option').length).toBe(3);
  });

  it('marks current field as active in dropdown', async () => {
    const w = mount(SortBar, { props: { options, field: 'name', direction: 'asc' } });
    await w.find('.sort-field-btn').trigger('click');
    const opts = w.findAll('.sort-dropdown-option');
    expect(opts[0].classes()).not.toContain('active');
    expect(opts[1].classes()).toContain('active'); // name
  });

  it('emits change with new field on dropdown selection', async () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    await w.find('.sort-field-btn').trigger('click');
    await w.findAll('.sort-dropdown-option')[2].trigger('click'); // activity
    expect(w.emitted('change')).toEqual([['activity', 'asc']]);
  });

  it('emits change with toggled direction', async () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    await w.find('.sort-direction-btn').trigger('click');
    expect(w.emitted('change')).toEqual([['state', 'desc']]);
  });

  it('closes dropdown after selection', async () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    await w.find('.sort-field-btn').trigger('click');
    expect(w.find('.sort-dropdown').exists()).toBe(true);
    await w.findAll('.sort-dropdown-option')[0].trigger('click');
    expect(w.find('.sort-dropdown').exists()).toBe(false);
  });

  it('toggles dropdown on repeated field button click', async () => {
    const w = mount(SortBar, { props: { options, field: 'state', direction: 'asc' } });
    await w.find('.sort-field-btn').trigger('click');
    expect(w.find('.sort-dropdown').exists()).toBe(true);
    await w.find('.sort-field-btn').trigger('click');
    expect(w.find('.sort-dropdown').exists()).toBe(false);
  });
});

// ============================================================================
// PlansGrid
// ============================================================================

import PlansGrid from '../../../renderer/components/sidebar/PlansGrid.vue';

describe('PlansGrid', () => {
  const dirs = [
    { name: 'project-a', path: '/a', startableCount: 2, codingCount: 1, blockedCount: 0, reviewCount: 0, planningCount: 0 },
    { name: 'project-b', path: '/b', startableCount: 0, codingCount: 0, blockedCount: 0, reviewCount: 0, planningCount: 0 },
  ];

  it('renders buttons for each directory', () => {
    const w = mount(PlansGrid, { props: { directories: dirs, focusIndex: 0, isActive: false } });
    const btns = w.findAll('.plans-grid-btn');
    expect(btns.length).toBe(2);
    expect(btns[0].find('.spawn-label').text()).toBe('project-a');
    expect(btns[1].find('.spawn-label').text()).toBe('project-b');
  });

  it('shows startable dot when count > 0', () => {
    const w = mount(PlansGrid, { props: { directories: dirs, focusIndex: 0, isActive: false } });
    const dots = w.findAll('.plan-dot--ready');
    expect(dots.length).toBe(1);
    expect(dots[0].text()).toContain('2');
  });

  it('shows coding dot when count > 0', () => {
    const w = mount(PlansGrid, { props: { directories: dirs, focusIndex: 0, isActive: false } });
    const dots = w.findAll('.plan-dot--coding');
    expect(dots.length).toBe(1);
    expect(dots[0].text()).toContain('1');
  });

  it('hides dots when all counts are 0', () => {
    const w = mount(PlansGrid, {
      props: { directories: [{ name: 'x', path: '/x', startableCount: 0, codingCount: 0, blockedCount: 0, reviewCount: 0, planningCount: 0 }], focusIndex: 0, isActive: false },
    });
    expect(w.find('.plans-btn-dots').exists()).toBe(false);
  });

  it('shows status dots for all states', () => {
    const dir = { name: 'p', path: '/p', planningCount: 1, startableCount: 2, codingCount: 3, reviewCount: 4, blockedCount: 5 };
    const w = mount(PlansGrid, { props: { directories: [dir], focusIndex: 0, isActive: false } });
    expect(w.find('.plan-dot--planning').text()).toContain('1');
    expect(w.find('.plan-dot--ready').text()).toContain('2');
    expect(w.find('.plan-dot--coding').text()).toContain('3');
    expect(w.find('.plan-dot--review').text()).toContain('4');
    expect(w.find('.plan-dot--blocked').text()).toContain('5');
  });

  it('emits showPlans on button click', async () => {
    const w = mount(PlansGrid, { props: { directories: dirs, focusIndex: 0, isActive: false } });
    await w.findAll('.plans-grid-btn')[0].trigger('click');
    expect(w.emitted('showPlans')).toEqual([['/a']]);
  });

  it('applies focused class to active item', () => {
    const w = mount(PlansGrid, { props: { directories: dirs, focusIndex: 1, isActive: true } });
    const btns = w.findAll('.plans-grid-btn');
    expect(btns[0].classes()).not.toContain('focused');
    expect(btns[1].classes()).toContain('focused');
  });

  it('renders empty grid for no directories', () => {
    const w = mount(PlansGrid, { props: { directories: [], focusIndex: 0, isActive: false } });
    expect(w.findAll('.plans-grid-btn').length).toBe(0);
  });
});

// ============================================================================
// StatusStrip
// ============================================================================

import StatusStrip from '../../../renderer/components/sidebar/StatusStrip.vue';

describe('StatusStrip', () => {
  it('shows green dot when gamepad connected', () => {
    const w = mount(StatusStrip, { props: { gamepadCount: 1, totalSessions: 3, activeSessions: 1 } });
    expect(w.find('.gamepad-dot').attributes('style')).toContain('rgb(68, 204, 68)');
  });

  it('shows grey dot when no gamepad', () => {
    const w = mount(StatusStrip, { props: { gamepadCount: 0, totalSessions: 0, activeSessions: 0 } });
    expect(w.find('.gamepad-dot').attributes('style')).toContain('rgb(85, 85, 85)');
  });

  it('shows gamepad count', () => {
    const w = mount(StatusStrip, { props: { gamepadCount: 2, totalSessions: 0, activeSessions: 0 } });
    expect(w.find('.gamepad-count').text()).toContain('2');
  });

  it('shows session counts', () => {
    const w = mount(StatusStrip, { props: { gamepadCount: 0, totalSessions: 5, activeSessions: 2 } });
    expect(w.find('.status-counts').text()).toContain('5 sessions');
    expect(w.find('.status-counts').text()).toContain('2 active');
  });

  it('pluralizes sessions correctly', () => {
    const w = mount(StatusStrip, { props: { gamepadCount: 0, totalSessions: 1, activeSessions: 0 } });
    expect(w.find('.status-counts').text()).toContain('1 session');
    expect(w.find('.status-counts').text()).not.toContain('sessions');
  });
});

// ============================================================================
// SettingsPanel
// ============================================================================

import SettingsPanel from '../../../renderer/components/sidebar/SettingsPanel.vue';

describe('SettingsPanel', () => {
  const tabs = [
    { id: 'profiles', label: 'Profiles' },
    { id: 'bindings', label: 'Bindings' },
    { id: 'tools', label: 'Tools' },
    { id: 'telegram', label: 'Telegram' },
  ];

  it('renders when visible', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'profiles' } });
    expect(w.find('.settings-panel').exists()).toBe(true);
  });

  it('does not render when hidden', () => {
    const w = mount(SettingsPanel, { props: { visible: false, tabs, activeTab: 'profiles' } });
    expect(w.find('.settings-panel').exists()).toBe(false);
  });

  it('renders all tabs', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'profiles' } });
    const tabBtns = w.findAll('.settings-tab');
    expect(tabBtns.length).toBe(4);
  });

  it('marks active tab', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'bindings' } });
    const tabBtns = w.findAll('.settings-tab');
    expect(tabBtns[1].classes()).toContain('settings-tab--active');
    expect(tabBtns[0].classes()).not.toContain('settings-tab--active');
  });

  it('emits update:activeTab on tab click', async () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'profiles' } });
    await w.findAll('.settings-tab')[2].trigger('click');
    expect(w.emitted('update:activeTab')).toEqual([['tools']]);
  });

  it('handleButton navigates left', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'bindings' } });
    const result = (w.vm as any).handleButton('DPadLeft');
    expect(result).toBe(true);
    expect(w.emitted('update:activeTab')).toEqual([['profiles']]);
  });

  it('handleButton navigates right', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'bindings' } });
    const result = (w.vm as any).handleButton('DPadRight');
    expect(result).toBe(true);
    expect(w.emitted('update:activeTab')).toEqual([['tools']]);
  });

  it('handleButton emits close on B', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'profiles' } });
    const result = (w.vm as any).handleButton('B');
    expect(result).toBe(true);
    expect(w.emitted('close')).toBeTruthy();
  });

  it('handleButton does not navigate past bounds', () => {
    const w = mount(SettingsPanel, { props: { visible: true, tabs, activeTab: 'profiles' } });
    (w.vm as any).handleButton('DPadLeft');
    expect(w.emitted('update:activeTab')).toEqual([['telegram']]);
  });
});

// ============================================================================
// BindingsTab
// ============================================================================

import BindingsTab from '../../../renderer/components/sidebar/BindingsTab.vue';

describe('BindingsTab', () => {
  const bindings = [
    { button: 'A', action: 'keyboard', label: 'A Button', detail: '{Enter}' },
    { button: 'B', action: 'voice', label: 'B Button', detail: 'F1 tap' },
  ];
  const profiles = [{ id: 'p1', name: 'Default' }, { id: 'p2', name: 'Codex' }];

  function mountTab(props: Record<string, unknown> = {}) {
    return mount(BindingsTab, {
      props: { bindings, profiles, profileId: 'p1', addableButtons: ['X', 'Y'], sortField: 'button', sortDirection: 'asc' as const, ...props },
    });
  }

  it('renders binding cards with button and action', () => {
    const w = mountTab();
    expect(w.findAll('.binding-card').length).toBe(2);
    expect(w.find('.binding-card__button').text()).toBe('A');
    expect(w.find('.binding-card__action-badge').text()).toBe('keyboard');
  });

  it('shows an empty-profile message when the profile has no bindings', () => {
    const w = mountTab({ bindings: [] });
    expect(w.find('.settings-empty').text()).toContain('No bindings in this profile');
  });

  it('with no profiles, hides binding controls and prompts to create one', () => {
    const w = mountTab({ bindings: [], profiles: [], profileId: '' });
    expect(w.find('.settings-empty').text()).toContain('No binding profiles yet');
    expect(w.find('.bindings-add-select').exists()).toBe(false);
    expect(w.find('.bindings-profile-delete').exists()).toBe(false);
  });

  it('emits selectProfile from the profile picker', async () => {
    const w = mountTab();
    await w.find('.bindings-profile-select').setValue('p2');
    expect(w.emitted('selectProfile')).toEqual([['p2']]);
  });

  it('emits createProfile (blank vs duplicate) and renameProfile', async () => {
    const w = mountTab();
    await w.find('.bindings-profile-new').trigger('click');
    await w.find('.bindings-profile-duplicate').trigger('click');
    await w.find('.bindings-profile-rename').trigger('click');
    expect(w.emitted('createProfile')).toEqual([[false], [true]]);
    expect(w.emitted('renameProfile')).toHaveLength(1);
  });

  it('deleteProfile needs a confirming second click', async () => {
    const w = mountTab();
    const del = w.find('.bindings-profile-delete');
    await del.trigger('click');
    expect(w.emitted('deleteProfile')).toBeUndefined();
    await del.trigger('click');
    expect(w.emitted('deleteProfile')).toHaveLength(1);
  });

  it('emits editBinding on card click', async () => {
    const w = mountTab();
    await w.findAll('.binding-card')[0].trigger('click');
    expect(w.emitted('editBinding')).toEqual([['A']]);
  });

  it('emits deleteBinding on delete button double-click (confirm pattern)', async () => {
    const w = mountTab();
    const deleteBtn = w.findAll('.binding-card')[0].find('.binding-card__delete');
    await deleteBtn.trigger('click');
    await deleteBtn.trigger('click');
    expect(w.emitted('deleteBinding')).toEqual([['A']]);
  });

  it('emits addBinding from the add selector', async () => {
    const w = mountTab();
    await w.find('.bindings-add-select').setValue('Y');
    expect(w.emitted('addBinding')).toEqual([['Y']]);
  });

  it('emits sortChange when sort controls change', async () => {
    const w = mountTab();
    await w.find('.bindings-sort-select').setValue('action');
    await w.find('.bindings-sort-direction').trigger('click');
    expect(w.emitted('sortChange')).toEqual([
      ['action', 'asc'],
      ['button', 'desc'],
    ]);
  });
});

// ============================================================================
// ToolsTab
// ============================================================================

import ToolsTab from '../../../renderer/components/sidebar/ToolsTab.vue';

describe('ToolsTab', () => {
  const tools = [
    { key: 'claude-code', name: 'Claude Code', command: 'claude', hasInitialPrompt: true, initialPromptCount: 2 },
    { key: 'copilot-cli', name: 'Copilot CLI', command: 'copilot', hasInitialPrompt: false, initialPromptCount: 0 },
  ];

  it('renders tool items', () => {
    const w = mount(ToolsTab, { props: { tools } });
    expect(w.findAll('.settings-list-item').length).toBe(2);
  });

  it('shows tool name and command', () => {
    const w = mount(ToolsTab, { props: { tools } });
    expect(w.find('.tool-name').text()).toBe('Claude Code');
    expect(w.find('.tool-command').text()).toBe('claude');
  });

  it('shows prompt badge when hasInitialPrompt', () => {
    const w = mount(ToolsTab, { props: { tools } });
    const items = w.findAll('.settings-list-item');
    expect(items[0].find('.tool-prompt-badge').text()).toContain('2 prompts');
    expect(items[1].find('.tool-prompt-badge').exists()).toBe(false);
  });

  it('shows empty message when no tools', () => {
    const w = mount(ToolsTab, { props: { tools: [] } });
    expect(w.find('.tools-empty').text()).toContain('No CLI types configured');
  });

  it('emits add on add button click', async () => {
    const w = mount(ToolsTab, { props: { tools } });
    await w.find('.settings-tool-actions button').trigger('click');
    expect(w.emitted('add')).toBeTruthy();
  });

  it('emits edit on edit button click', async () => {
    const w = mount(ToolsTab, { props: { tools } });
    const items = w.findAll('.settings-list-item');
    await items[0].findAll('button')[3].trigger('click');
    expect(w.emitted('edit')).toEqual([['claude-code']]);
  });

  it('emits delete on delete button click', async () => {
    const w = mount(ToolsTab, { props: { tools } });
    const items = w.findAll('.settings-list-item');
    await items[0].findAll('button')[4].trigger('click');
    expect(w.emitted('delete')).toEqual([['claude-code']]);
  });

  it('emits move on up/down buttons', async () => {
    const w = mount(ToolsTab, { props: { tools } });
    const items = w.findAll('.settings-list-item');
    // First item: Up is disabled (index 0), Down is enabled (index 1)
    expect(items[0].findAll('button')[0].attributes('disabled')).toBeDefined();
    await items[0].findAll('button')[1].trigger('click');
    expect(w.emitted('move')).toEqual([['claude-code', 'down']]);
    // Second item: Up is enabled (index 0), Down is disabled (index 1)
    expect(items[1].findAll('button')[1].attributes('disabled')).toBeDefined();
    await items[1].findAll('button')[0].trigger('click');
    expect(w.emitted('move')).toEqual([['claude-code', 'down'], ['copilot-cli', 'up']]);
  });
});

// ============================================================================
// ChipbarActionsTab
// ============================================================================

import ChipbarActionsTab from '../../../renderer/components/sidebar/ChipbarActionsTab.vue';

describe('ChipbarActionsTab', () => {
  const actions = [
    { label: 'Plan', sequence: 'plan{Enter}' },
    { label: 'Build', sequence: 'npm run build{Enter}' },
  ];

  it('renders chipbar actions and template help', () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    expect(w.findAll('.settings-list-item').length).toBe(2);
    expect(w.text()).toContain('Template expansions');
    expect(w.text()).toContain('Plan');
  });

  it('shows an empty state when no actions are configured', () => {
    const w = mount(ChipbarActionsTab, { props: { actions: [] } });
    expect(w.find('.settings-empty').text()).toContain('No chip bar actions configured');
  });

  it('emits add and edit actions', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    await w.find('.settings-panel__header button').trigger('click');
    await w.findAll('.settings-list-item')[1].findAll('button')[2].trigger('click');
    expect(w.emitted('add')).toBeTruthy();
    expect(w.emitted('edit')).toEqual([[1]]);
  });

  it('emits move with source and target indices', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    const items = w.findAll('.settings-list-item');
    expect(items[0].findAll('button')[0].attributes('disabled')).toBeDefined();
    await items[0].findAll('button')[1].trigger('click');
    await items[1].findAll('button')[0].trigger('click');
    expect(w.emitted('move')).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('confirms before emitting delete', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    const deleteButton = w.findAll('.settings-list-item')[0].findAll('button')[3];
    await deleteButton.trigger('click');
    expect(w.emitted('delete')).toBeUndefined();
    expect(deleteButton.text()).toBe('Confirm?');
    await deleteButton.trigger('click');
    expect(w.emitted('delete')).toEqual([[0]]);
  });

  it('resets delete confirm after reorder', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    const deleteButton = w.findAll('.settings-list-item')[0].findAll('button')[3];
    await deleteButton.trigger('click');
    expect(deleteButton.text()).toBe('Confirm?');

    const downButton = w.findAll('.settings-list-item')[0].findAll('button')[1];
    await downButton.trigger('click');
    expect(w.emitted('move')).toEqual([[0, 1]]);

    // Parent handles move by updating the actions prop with reordered array
    const reordered = [actions[1], actions[0]];
    await w.setProps({ actions: reordered });
    await nextTick();

    const newFirstItemButtons = w.findAll('.settings-list-item')[0].findAll('button');
    expect(newFirstItemButtons[3].text()).toBe('Delete');
    expect(w.emitted('delete')).toBeUndefined();
  });

  it('resets delete confirm when actions prop changes externally', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions } });
    const deleteButton = w.findAll('.settings-list-item')[0].findAll('button')[3];
    await deleteButton.trigger('click');
    expect(deleteButton.text()).toBe('Confirm?');

    await w.setProps({
      actions: [
        { label: 'New', sequence: 'new{Enter}' },
        { label: 'Plan', sequence: 'plan{Enter}' },
        { label: 'Build', sequence: 'npm run build{Enter}' },
      ],
    });
    await nextTick();

    const firstButton = w.findAll('.settings-list-item')[0].findAll('button')[3];
    expect(firstButton.text()).toBe('Delete');
    expect(w.emitted('delete')).toBeUndefined();
  });
});

// ============================================================================
// TelegramTab
// ============================================================================

import TelegramTab from '../../../renderer/components/sidebar/TelegramTab.vue';

describe('TelegramTab', () => {
  const config = {
    botToken: 'test-token',
    chatId: '12345',
    allowedUsers: 'user1, user2',
    notificationsEnabled: true,
    autoStart: false,
  };

  it('renders connection fields', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: false } });
    const inputs = w.findAll('input[type="text"], input[type="password"]');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
  });

  it('shows bot running status', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: true } });
    expect(w.find('.bot-running').text()).toContain('Running');
  });

  it('shows bot stopped status', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: false } });
    expect(w.find('.bot-stopped').text()).toContain('Stopped');
  });

  it('shows start button when stopped', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: false } });
    const btns = w.findAll('.bot-status button');
    expect(btns[0].text()).toBe('Start Bot');
  });

  it('shows stop button when running', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: true } });
    const btns = w.findAll('.bot-status button');
    expect(btns[0].text()).toBe('Stop Bot');
  });

  it('emits startBot on start click', async () => {
    const w = mount(TelegramTab, { props: { config, botRunning: false } });
    await w.find('.bot-status button').trigger('click');
    expect(w.emitted('startBot')).toBeTruthy();
  });

  it('emits stopBot on stop click', async () => {
    const w = mount(TelegramTab, { props: { config, botRunning: true } });
    await w.find('.bot-status button').trigger('click');
    expect(w.emitted('stopBot')).toBeTruthy();
  });

  it('renders notification checkbox', () => {
    const w = mount(TelegramTab, { props: { config, botRunning: false } });
    const checkbox = w.find('.notification-toggle input');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('renders autostart checkbox and emits updates', async () => {
    const w = mount(TelegramTab, { props: { config: { ...config, autoStart: true }, botRunning: false } });
    const checkboxes = w.findAll('.notification-toggle input');
    expect((checkboxes[1].element as HTMLInputElement).checked).toBe(true);

    await checkboxes[1].setValue(false);

    expect(w.emitted('updateField')).toContainEqual(['autoStart', false]);
  });
});
