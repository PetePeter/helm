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

  it('uses the authoritative state, derives only safe waiting reasons, and clips passive tails', () => {
    const result = buildTeamViewProjection({
      sessions: [
        session('human', { projectId: 'alpha', questionPending: true, createdAt: 1 }),
        session('agent', { projectId: 'alpha', aiagentState: 'planning', createdAt: 2 }),
        session('unknown', { projectId: 'alpha', createdAt: 3 }),
      ],
      projects: [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }],
      stateForSession: () => 'waiting',
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
});
