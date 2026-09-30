/**
 * Tests for runtime session groups — buildSessionGroups + buildFlatNavList
 * interplay with RuntimeGroup exclusive membership.
 */

import { describe, it, expect } from 'vitest';
import type { Session } from '../renderer/state';
import { buildSessionGroups, buildFlatNavList } from '../renderer/session-groups';
import type { SessionGroupPrefs } from '../renderer/session-groups';
import { RUNTIME_GROUP_COLORS, type RuntimeGroup } from '../src/types/runtime-group';

// ============================================================================
// Helpers
// ============================================================================

function makeSession(id: string, workingDir: string, name = id): Session {
  return { id, name, cliType: 'claude-code', processId: 1000 + parseInt(id.replace(/\D/g, '') || '0'), workingDir };
}

/** getDir resolves each session id to its own workingDir. */
function makeGetDir(sessions: Session[]): (id: string) => string {
  const map = new Map(sessions.map(s => [s.id, s.workingDir]));
  return (id: string) => map.get(id) ?? '';
}

function makeRuntimeGroup(id: string, name: string, sessionIds: string[], collapsed = false): RuntimeGroup {
  return { id, name, sessionIds, collapsed, createdAt: 1, updatedAt: 1 };
}

const emptyPrefs: SessionGroupPrefs = { order: [], collapsed: [] };

// ============================================================================
// buildSessionGroups
// ============================================================================

describe('buildSessionGroups', () => {
  it('G1: runtime group claims a session, excluding it from its directory group', () => {
    const s1 = makeSession('s1', 'X:\\dirA');
    const s2 = makeSession('s2', 'X:\\dirA');
    const sessions = [s1, s2];
    const rgs = [makeRuntimeGroup('g1', 'G', ['s1'])];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);

    const runtimeGroup = groups.find(g => g.kind === 'runtime' && g.groupId === 'g1');
    expect(runtimeGroup).toBeDefined();
    expect(runtimeGroup!.sessions.map(s => s.id)).toEqual(['s1']);

    const dirGroup = groups.find(g => g.kind === 'directory' && g.dirPath === 'X:\\dirA');
    expect(dirGroup).toBeDefined();
    expect(dirGroup!.sessions.map(s => s.id)).toEqual(['s2']);
  });

  it('gives a runtime group its picked colour, the default when unset, and folders none', () => {
    const s1 = makeSession('s1', 'X:\dirA');
    const s2 = makeSession('s2', 'X:\dirA');
    const s3 = makeSession('s3', 'X:\dirA');
    const sessions = [s1, s2, s3];
    const rgs = [{ ...makeRuntimeGroup('g1', 'G', ['s1']), color: RUNTIME_GROUP_COLORS[3] }, makeRuntimeGroup('g2', 'H', ['s2'])];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);

    expect(groups.map(g => [g.kind, g.color])).toEqual([
      ['runtime', RUNTIME_GROUP_COLORS[3]],
      ['runtime', RUNTIME_GROUP_COLORS[0]],
      ['directory', undefined],
    ]);
  });

  it('G2: runtime groups come before directory groups in nav order', () => {
    const s1 = makeSession('s1', 'X:\\dirA');
    const s2 = makeSession('s2', 'X:\\dirA');
    const sessions = [s1, s2];
    const rgs = [makeRuntimeGroup('g1', 'G', ['s1'])];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);
    const nav = buildFlatNavList(groups);

    const firstHeader = nav.find(item => item.type === 'group-header');
    expect(firstHeader).toBeDefined();
    expect(groups[firstHeader!.groupIndex].kind).toBe('runtime');
  });

  it('G3a: empty runtime group still emits a group-header (no session cards)', () => {
    const s1 = makeSession('s1', 'X:\\dirA');
    const sessions = [s1];
    const rgs = [makeRuntimeGroup('g1', 'Empty', [])];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);
    const nav = buildFlatNavList(groups);

    const emptyHeader = nav.find(item => item.type === 'group-header' && item.id === 'g1');
    expect(emptyHeader).toBeDefined();
    // No session-card items belong to the empty runtime group.
    const emptyIndex = groups.findIndex(g => g.groupId === 'g1');
    const cardsForEmpty = nav.filter(item => item.type === 'session-card' && item.groupIndex === emptyIndex);
    expect(cardsForEmpty).toHaveLength(0);
  });

  it('G3b: collapsed runtime group shows its header but zero session cards', () => {
    const s1 = makeSession('s1', 'X:\\dirA');
    const sessions = [s1];
    const rgs = [makeRuntimeGroup('g1', 'G', ['s1'], /* collapsed */ true)];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);
    const nav = buildFlatNavList(groups);

    const header = nav.find(item => item.type === 'group-header' && item.id === 'g1');
    expect(header).toBeDefined();

    const gIndex = groups.findIndex(g => g.groupId === 'g1');
    const cards = nav.filter(item => item.type === 'session-card' && item.groupIndex === gIndex);
    expect(cards).toHaveLength(0);
  });

  it('G4: directory drops out entirely when all its sessions are claimed and it is not bookmarked', () => {
    const s1 = makeSession('s1', 'X:\\dirA');
    const s2 = makeSession('s2', 'X:\\dirA');
    const sessions = [s1, s2];
    const rgs = [makeRuntimeGroup('g1', 'G', ['s1', 's2'])];

    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, rgs);

    const dirGroup = groups.find(g => g.kind === 'directory' && g.dirPath === 'X:\\dirA');
    expect(dirGroup).toBeUndefined();

    // The runtime group still holds both sessions.
    const runtimeGroup = groups.find(g => g.groupId === 'g1');
    expect(runtimeGroup!.sessions.map(s => s.id)).toEqual(['s1', 's2']);
  });
});

describe('buildSessionGroups — Remote rows grouped by machine', () => {
  const remote = (id: string, peerId: string, dir = '/w/proj'): Session =>
    ({ ...makeSession(id, dir), remote: { peerId, sessionId: `${id}-there` } });
  const names: Record<string, string> = { p1: 'Box', p2: 'Laptop' };
  const machineName = (peerId: string) => names[peerId] ?? peerId;

  it('M1: Remote rows leave directory groups and sit under their owner machine, after local groups', () => {
    const sessions = [makeSession('s1', '/w/proj'), remote('r1', 'p1'), remote('r2', 'p2'), remote('r3', 'p1', '/w/other')];
    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, [], machineName);

    expect(groups.map(g => [g.kind, g.displayName, g.sessions.map(s => s.id)])).toEqual([
      ['directory', 'proj', ['s1']],
      ['machine', 'Box', ['r1', 'r3']],
      ['machine', 'Laptop', ['r2']],
    ]);
  });

  it('M2: machine groups have their own header key and honour collapse prefs', () => {
    const sessions = [remote('r1', 'p1')];
    const groups = buildSessionGroups(sessions, makeGetDir(sessions), { order: [], collapsed: ['machine:p1'] }, [], machineName);
    expect(groups[0]).toMatchObject({ dirPath: 'machine:p1', collapsed: true });
  });

  it('M3: a runtime group still claims a Remote row', () => {
    const sessions = [remote('r1', 'p1')];
    const groups = buildSessionGroups(sessions, makeGetDir(sessions), emptyPrefs, [makeRuntimeGroup('g1', 'G', ['r1'])], machineName);
    expect(groups.map(g => g.kind)).toEqual(['runtime']);
  });
});
