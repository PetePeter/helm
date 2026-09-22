import { describe, expect, it } from 'vitest';
import type { Session } from '../renderer/state.js';
import { buildTeamViewProjection } from '../renderer/team-view/team-view-projection.js';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    cliType: 'codex',
    processId: 0,
    ...overrides,
  };
}

describe('buildTeamViewProjection', () => {
  it('groups every open session by project and omits projects without sessions', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('one', { projectId: 'alpha', projectPath: '/work/alpha' }),
        session('two', { projectId: 'beta', projectPath: '/work/beta' }),
      ],
      projects: [
        { id: 'alpha', name: 'Alpha', canonicalPath: '/work/alpha', alternatePaths: [] },
        { id: 'beta', name: 'Beta', canonicalPath: '/work/beta', alternatePaths: [] },
        { id: 'empty', name: 'Empty', canonicalPath: '/work/empty', alternatePaths: [] },
      ],
    });

    expect(result.departments.map(department => department.name)).toEqual(['Alpha', 'Beta']);
    expect(result.departments.flatMap(department => department.desks).map(desk => desk.sessionId))
      .toEqual(['one', 'two']);
  });

  it('assigns deterministic focus labels independent of source array order', () => {
    const sessions = [
      session('z', { projectId: 'beta', createdAt: 20 }),
      session('b', { projectId: 'alpha', createdAt: 20 }),
      session('a', { projectId: 'alpha', createdAt: 10 }),
    ];
    const input = {
      projects: [
        { id: 'beta', name: 'Beta', canonicalPath: '/beta', alternatePaths: [] },
        { id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] },
      ],
    };

    const first = buildTeamViewProjection({ ...input, sessions });
    const second = buildTeamViewProjection({ ...input, sessions: [...sessions].reverse() });

    expect(first.departments.flatMap(department => department.desks)
      .map(desk => [desk.sessionId, desk.focusLabel]))
      .toEqual([['a', '^1'], ['b', '^2'], ['z', '^3']]);
    expect(second).toEqual(first);
  });

  it('uses the shared Session List slots when present, leaving unassigned desks undiscoverable', () => {
    const result = buildTeamViewProjection({
      sessions: [session('one'), session('two'), session('three')],
      projects: [],
      focusSlotForSession: id => ({ one: 3, two: 0 }[id]),
    });

    expect(result.departments[0].desks.map(desk => [desk.sessionId, desk.focusIndex, desk.focusLabel]))
      .toEqual([['two', 9, '^0'], ['one', 2, '^3'], ['three', -1, '']]);
  });

  it('keeps presentation visibility separate from open-session membership', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('one', { projectId: 'alpha' }),
        session('two', { projectId: 'alpha', cliSessionName: 'stable-two' }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      collapsedDepartmentIds: new Set(['project:alpha']),
      hiddenSessionIds: new Set(['stable-two']),
    });

    expect(result.departments[0]).toMatchObject({ collapsed: true, visibleDeskCount: 1 });
    expect(result.departments[0].desks.map(desk => [desk.sessionId, desk.hidden]))
      .toEqual([['one', false], ['two', true]]);
  });

  it('projects lock and artifact status from the existing live session boundaries', () => {
    const result = buildTeamViewProjection({
      sessions: [session('one', { locked: true })],
      projects: [],
      artifactCountForSession: sessionId => sessionId === 'one' ? 3 : 0,
    });
    expect(result.departments[0].desks[0]).toMatchObject({ locked: true, artifactCount: 3 });
  });

  it('uses the authoritative state, derives only safe waiting reasons, and clips passive tails', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('human', { projectId: 'alpha', questionPending: true, createdAt: 1 }),
        session('agent', { projectId: 'alpha', aiagentState: 'planning', createdAt: 2 }),
        session('unknown', { projectId: 'alpha', createdAt: 3 }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      stateForSession: () => 'waiting',
      waitingReasonForSession: candidate => candidate.id === 'agent' ? 'agent' : undefined,
      terminalTailForSession: id => id === 'human'
        ? ['one', 'two', 'three', 'four']
        : [],
      tailLineLimit: 2,
    });

    expect(result.departments[0].desks).toMatchObject([
      { sessionId: 'human', state: 'waiting', waitingReason: 'human', terminalTail: ['three', 'four'] },
      { sessionId: 'agent', state: 'waiting', waitingReason: 'agent', terminalTail: [] },
      { sessionId: 'unknown', state: 'waiting', waitingReason: 'unknown', terminalTail: [] },
    ]);
  });

  it('projects the shared activity level onto desks, defaulting to idle', () => {
    const withSource = buildTeamViewProjection({
      sessions: [session('busy', { projectId: 'alpha' }), session('quiet', { projectId: 'alpha' })],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      activityLevelForSession: id => (id === 'busy' ? 'active' : 'inactive'),
    });
    expect(withSource.departments[0].desks.map(desk => [desk.sessionId, desk.activityLevel]))
      .toEqual([['busy', 'active'], ['quiet', 'inactive']]);

    const withoutSource = buildTeamViewProjection({
      sessions: [session('one')],
      projects: [],
    });
    expect(withoutSource.departments[0].desks[0].activityLevel).toBe('idle');
  });

  it('orders desks by focus slot ascending, then slot-less desks by createdAt', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('slot3', { projectId: 'alpha', createdAt: 100 }),
        session('loose-new', { projectId: 'alpha', createdAt: 500 }),
        session('slot1', { projectId: 'alpha', createdAt: 200 }),
        session('loose-old', { projectId: 'alpha', createdAt: 400 }),
        session('slot2', { projectId: 'alpha', createdAt: 300 }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      focusSlotForSession: id => ({ slot1: 1, slot2: 2, slot3: 3 })[id],
    });

    // Slot-bearing desks lead in slot order regardless of createdAt; desks
    // without a slot follow in createdAt order and carry no advertised key.
    expect(result.departments[0].desks.map(desk => [desk.sessionId, desk.focusLabel]))
      .toEqual([['slot1', '^1'], ['slot2', '^2'], ['slot3', '^3'], ['loose-old', ''], ['loose-new', '']]);
  });

  it('orders departments by their lowest member slot so Ctrl+number reads top-down', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('a1', { projectId: 'alpha' }),
        session('b1', { projectId: 'beta' }),
        session('b2', { projectId: 'beta' }),
        session('c1', { projectId: 'gamma' }),
      ],
      projects: [
        { id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] },
        { id: 'beta', name: 'Beta', canonicalPath: '/beta', alternatePaths: [] },
        { id: 'gamma', name: 'Gamma', canonicalPath: '/gamma', alternatePaths: [] },
      ],
      // Beta holds ^1, alpha holds ^3, gamma holds none: beta leads, gamma trails.
      focusSlotForSession: id => ({ a1: 3, b1: 1, b2: 2 })[id],
    });

    expect(result.departments.map(department => department.id))
      .toEqual(['project:beta', 'project:alpha', 'project:gamma']);
  });

  it('counts hidden desks per department while keeping them in desks', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('one', { projectId: 'alpha' }),
        session('two', { projectId: 'alpha', cliSessionName: 'stable-two' }),
        session('three', { projectId: 'alpha' }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      // 'two' is hidden via its cliSessionName alias; 'three' via its id.
      hiddenSessionIds: new Set(['stable-two', 'three']),
    });

    expect(result.departments[0].desks.map(desk => desk.sessionId)).toEqual(['one', 'three', 'two']);
    expect(result.departments[0].desks.map(desk => desk.hidden)).toEqual([false, true, true]);
    expect(result.departments[0].visibleDeskCount).toBe(1);
    expect(result.departments[0].hiddenDeskCount).toBe(2);
  });

  it('keeps a fully hidden department in the projection', () => {
    const result = buildTeamViewProjection({
      sessions: [session('one', { projectId: 'alpha' }), session('two', { projectId: 'alpha' })],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      hiddenSessionIds: new Set(['one', 'two']),
    });

    expect(result.departments).toHaveLength(1);
    expect(result.departments[0].desks).toHaveLength(2);
    expect(result.departments[0].visibleDeskCount).toBe(0);
    expect(result.departments[0].hiddenDeskCount).toBe(2);
    expect(result.visibleDeskCount).toBe(0);
  });

  it('feeds notificationsForSession verbatim into desk.notifications, defaulting to empty', () => {
    const notifications = [
      { id: 'n1', title: 'Attention', content: 'Please review', createdAt: 1 },
      { id: 'n2', title: 'Second', content: 'Also review', createdAt: 2 },
    ];
    const result = buildTeamViewProjection({
      sessions: [
        session('one', { projectId: 'alpha', createdAt: 1 }),
        session('two', { projectId: 'alpha', createdAt: 2 }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      notificationsForSession: sessionId => (sessionId === 'one' ? notifications : []),
    });

    const desks = result.departments[0].desks;
    // Verbatim pass-through: the badge derives its count from notifications.length.
    expect(desks.find(desk => desk.sessionId === 'one')?.notifications).toEqual(notifications);
    expect(desks.find(desk => desk.sessionId === 'two')?.notifications).toEqual([]);
    // No redundant count field — the projection owns the list, not a derived number.
    expect(desks[0]).not.toHaveProperty('notificationCount');
    expect(desks[1]).not.toHaveProperty('notificationCount');

    const absent = buildTeamViewProjection({ sessions: [session('solo')], projects: [] });
    expect(absent.departments[0].desks[0].notifications).toEqual([]);
  });

  it('does not infer an agent wait from a completed or idle agent phase', () => {
    const result = buildTeamViewProjection({
      sessions: [session('completed', { aiagentState: 'completed' }), session('idle', { aiagentState: 'idle' })],
      projects: [],
      stateForSession: () => 'waiting',
    });
    expect(result.departments[0].desks.map(desk => desk.waitingReason)).toEqual(['unknown', 'unknown']);
  });
});
