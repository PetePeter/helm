/**
 * Tests for session-groups.ts — pure grouping, nav list, and reorder logic.
 */

import { describe, it, expect } from 'vitest';
import type { Session } from '../renderer/state';
import {
  dirDisplayName,
  pathsMatch,
  resolveGroupDisplayName,
  groupSessionsByDirectory,
  buildFlatNavList,
  findNavIndexBySessionId,
  moveGroupUp,
  moveGroupDown,
  toggleCollapse,
} from '../renderer/session-groups';
import type { SessionGroup, SessionGroupPrefs } from '../renderer/session-groups';

// ============================================================================
// Helpers
// ============================================================================

function makeSession(id: string, workingDir: string, name = id): Session {
  return { id, name, cliType: 'claude-code', processId: 1000 + parseInt(id.replace(/\D/g, '') || '0'), workingDir };
}

// ============================================================================
// dirDisplayName
// ============================================================================

describe('dirDisplayName', () => {
  it('extracts last segment from Windows path', () => {
    expect(dirDisplayName('X:\\coding\\gamepad-cli-hub')).toBe('gamepad-cli-hub');
  });

  it('extracts last segment from Unix path', () => {
    expect(dirDisplayName('/home/user/projects/my-app')).toBe('my-app');
  });

  it('handles trailing slashes', () => {
    expect(dirDisplayName('X:\\coding\\project\\')).toBe('project');
    expect(dirDisplayName('/home/user/project/')).toBe('project');
  });

  it('returns full string for single segment', () => {
    expect(dirDisplayName('project')).toBe('project');
  });

  it('handles empty string', () => {
    expect(dirDisplayName('')).toBe('');
  });
});

// ============================================================================
// resolveGroupDisplayName
// ============================================================================

describe('resolveGroupDisplayName', () => {
  const dirs = [
    { name: 'My Project', path: 'X:\\coding\\project-a' },
    { name: 'Work App', path: '/home/user/work' },
  ];

  it('returns custom name when directory has a matching config entry', () => {
    expect(resolveGroupDisplayName('X:\\coding\\project-a', dirs)).toBe('My Project');
    expect(resolveGroupDisplayName('/home/user/work', dirs)).toBe('Work App');
  });

  it('falls back to path tail when no config entry matches', () => {
    expect(resolveGroupDisplayName('X:\\coding\\project-b', dirs)).toBe('project-b');
    expect(resolveGroupDisplayName('/home/user/other', dirs)).toBe('other');
  });

  it('returns full path when path has no separators and no match', () => {
    expect(resolveGroupDisplayName('standalone', dirs)).toBe('standalone');
  });

  it('returns path tail for empty directories list', () => {
    expect(resolveGroupDisplayName('X:\\coding\\project-a', [])).toBe('project-a');
  });

  describe('project matching', () => {
    // Multi-directory projects (canonical + at least one alternate).
    const projects = [
      { name: 'Helm Hub', canonicalPath: 'X:\\coding\\helm-hub', alternatePaths: ['X:\\coding\\helm-hub-worktree'] },
      { name: 'Work App', canonicalPath: '/home/user/work', alternatePaths: ['/home/user/work-v2'] },
    ];

    it('appends the folder for the canonical dir of a multi-dir project', () => {
      expect(resolveGroupDisplayName('X:\\coding\\helm-hub', [], projects)).toBe('Helm Hub - helm-hub');
    });

    it('appends the folder for an alternate dir of a multi-dir project', () => {
      expect(resolveGroupDisplayName('X:\\coding\\helm-hub-worktree', [], projects)).toBe('Helm Hub - helm-hub-worktree');
    });

    it('shows only the project name when the project has a single directory', () => {
      const single = [{ name: 'Solo', canonicalPath: 'X:\\coding\\solo', alternatePaths: [] as string[] }];
      expect(resolveGroupDisplayName('X:\\coding\\solo', [], single)).toBe('Solo');
    });

    it('project identity takes priority over configured directory aliases', () => {
      expect(resolveGroupDisplayName('X:\\coding\\helm-hub', [{ name: 'Custom Dir Name', path: 'X:\\coding\\helm-hub' }], projects)).toBe('Helm Hub - helm-hub');
    });

    it('falls back to path tail when no project matches', () => {
      expect(resolveGroupDisplayName('X:\\coding\\unknown', [], projects)).toBe('unknown');
    });

    it('works without projects param (backward compatible)', () => {
      expect(resolveGroupDisplayName('X:\\coding\\project-a', dirs)).toBe('My Project');
      expect(resolveGroupDisplayName('X:\\coding\\unknown', [])).toBe('unknown');
    });
  });
});

describe('pathsMatch', () => {
  it('matches equivalent separator spellings', () => {
    expect(pathsMatch('X:\\coding\\gamepad-cli-hub', 'X:/coding/gamepad-cli-hub')).toBe(true);
  });
});


describe('groupSessionsByDirectory', () => {
  const sessions: Session[] = [
    makeSession('s1', 'X:\\coding\\project-a'),
    makeSession('s2', 'X:\\coding\\project-b'),
    makeSession('s3', 'X:\\coding\\project-a'),
    makeSession('s4', 'X:\\coding\\project-b'),
    makeSession('s5', 'X:\\coding\\project-c'),
  ];

  const getDir = (id: string) => sessions.find(s => s.id === id)?.workingDir || '';

  it('groups sessions by directory', () => {
    const groups = groupSessionsByDirectory(sessions, getDir);
    expect(groups).toHaveLength(3);
    expect(groups[0].sessions.map(s => s.id)).toEqual(['s1', 's3']);
    expect(groups[1].sessions.map(s => s.id)).toEqual(['s2', 's4']);
    expect(groups[2].sessions.map(s => s.id)).toEqual(['s5']);
  });

  it('sets displayName from directory path', () => {
    const groups = groupSessionsByDirectory(sessions, getDir);
    expect(groups[0].displayName).toBe('project-a');
    expect(groups[1].displayName).toBe('project-b');
    expect(groups[2].displayName).toBe('project-c');
  });

  it('respects prefs.order for group ordering', () => {
    const prefs: SessionGroupPrefs = {
      order: ['X:\\coding\\project-c', 'X:\\coding\\project-a', 'X:\\coding\\project-b'],
      collapsed: [],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    expect(groups.map(g => g.displayName)).toEqual(['project-c', 'project-a', 'project-b']);
  });

  it('appends unknown directories alphabetically after ordered ones', () => {
    const prefs: SessionGroupPrefs = {
      order: ['X:\\coding\\project-b'],
      collapsed: [],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    expect(groups.map(g => g.displayName)).toEqual(['project-b', 'project-a', 'project-c']);
  });

  it('applies collapse state from prefs', () => {
    const prefs: SessionGroupPrefs = {
      order: [],
      collapsed: ['X:\\coding\\project-a'],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    expect(groups[0].collapsed).toBe(true);
    expect(groups[1].collapsed).toBe(false);
  });

  it('ignores prefs.order entries with no sessions', () => {
    const prefs: SessionGroupPrefs = {
      order: ['X:\\coding\\nonexistent', 'X:\\coding\\project-a'],
      collapsed: [],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    expect(groups[0].dirPath).toBe('X:\\coding\\project-a');
    expect(groups.every(g => g.dirPath !== 'X:\\coding\\nonexistent')).toBe(true);
  });

  it('returns empty array for no sessions', () => {
    expect(groupSessionsByDirectory([], () => '')).toEqual([]);
  });

  it('falls back to session.workingDir when getDir returns empty', () => {
    const s = [makeSession('s1', 'X:\\fallback\\dir')];
    const groups = groupSessionsByDirectory(s, () => '', { order: [], collapsed: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0].dirPath).toBe('X:\\fallback\\dir');
  });

  it('groups by projectPath before concrete working directory', () => {
    const projectSessions = [
      { ...makeSession('s1', 'X:\\coding\\repo\\packages\\ui'), projectPath: 'X:\\coding\\repo' },
      { ...makeSession('s2', 'X:\\coding\\repo\\apps\\desktop'), projectPath: 'X:\\coding\\repo' },
    ];
    const groups = groupSessionsByDirectory(
      projectSessions,
      id => projectSessions.find(s => s.id === id)?.workingDir || '',
      { order: [], collapsed: [] },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].dirPath).toBe('X:\\coding\\repo');
    expect(groups[0].sessions.map(session => session.id)).toEqual(['s1', 's2']);
  });

  it('all groups default to expanded when no collapse prefs', () => {
    const groups = groupSessionsByDirectory(sessions, getDir);
    expect(groups.every(g => !g.collapsed)).toBe(true);
  });

  // ── Bookmarked directories ──

  it('includes bookmarked dirs with no sessions as empty groups', () => {
    const prefs: SessionGroupPrefs = {
      order: [],
      collapsed: [],
      bookmarked: ['X:\\coding\\bookmarked-dir'],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    const bookmarkedGroup = groups.find(g => g.dirPath === 'X:\\coding\\bookmarked-dir');
    expect(bookmarkedGroup).toBeDefined();
    expect(bookmarkedGroup!.sessions).toEqual([]);
  });

  it('does not duplicate group when bookmarked dir also has active sessions', () => {
    const prefs: SessionGroupPrefs = {
      order: [],
      collapsed: [],
      bookmarked: ['X:\\coding\\project-a'],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    const matching = groups.filter(g => g.dirPath === 'X:\\coding\\project-a');
    expect(matching).toHaveLength(1);
    expect(matching[0].sessions.length).toBeGreaterThan(0);
  });

  it('bookmarked dirs respect order prefs', () => {
    const prefs: SessionGroupPrefs = {
      order: ['X:\\coding\\bookmarked', 'X:\\coding\\project-a'],
      collapsed: [],
      bookmarked: ['X:\\coding\\bookmarked'],
    };
    const groups = groupSessionsByDirectory(sessions, getDir, prefs);
    expect(groups[0].dirPath).toBe('X:\\coding\\bookmarked');
    expect(groups[0].sessions).toEqual([]);
  });

  it('bookmarked dirs respect collapse state', () => {
    const prefs: SessionGroupPrefs = {
      order: [],
      collapsed: ['X:\\coding\\bookmarked'],
      bookmarked: ['X:\\coding\\bookmarked'],
    };
    const groups = groupSessionsByDirectory([], () => '', prefs);
    expect(groups[0].collapsed).toBe(true);
  });

  it('returns bookmarked groups even with zero active sessions', () => {
    const prefs: SessionGroupPrefs = {
      order: [],
      collapsed: [],
      bookmarked: ['X:\\coding\\empty-project'],
    };
    const groups = groupSessionsByDirectory([], () => '', prefs);
    expect(groups).toHaveLength(1);
    expect(groups[0].dirPath).toBe('X:\\coding\\empty-project');
    expect(groups[0].displayName).toBe('empty-project');
    expect(groups[0].sessions).toEqual([]);
  });
});

// ============================================================================
// buildFlatNavList
// ============================================================================

describe('buildFlatNavList', () => {
  const makeGroup = (dir: string, sessionIds: string[], collapsed = false): SessionGroup => ({
    dirPath: dir,
    displayName: dirDisplayName(dir),
    sessions: sessionIds.map(id => makeSession(id, dir)),
    collapsed,
  });

  it('builds flat list with headers and cards for expanded groups', () => {
    const groups = [makeGroup('/a', ['s1', 's2']), makeGroup('/b', ['s3'])];
    const nav = buildFlatNavList(groups);
    expect(nav).toEqual([
      { type: 'group-header', id: '/a', groupIndex: 0 },
      { type: 'session-card', id: 's1', groupIndex: 0 },
      { type: 'session-card', id: 's2', groupIndex: 0 },
      { type: 'group-header', id: '/b', groupIndex: 1 },
      { type: 'session-card', id: 's3', groupIndex: 1 },
    ]);
  });

  it('omits session cards for collapsed groups', () => {
    const groups = [makeGroup('/a', ['s1', 's2'], true), makeGroup('/b', ['s3'])];
    const nav = buildFlatNavList(groups);
    expect(nav).toEqual([
      { type: 'group-header', id: '/a', groupIndex: 0 },
      { type: 'group-header', id: '/b', groupIndex: 1 },
      { type: 'session-card', id: 's3', groupIndex: 1 },
    ]);
  });

  it('returns empty for no groups', () => {
    expect(buildFlatNavList([])).toEqual([]);
  });

  it('handles all groups collapsed', () => {
    const groups = [makeGroup('/a', ['s1'], true), makeGroup('/b', ['s2'], true)];
    const nav = buildFlatNavList(groups);
    expect(nav).toHaveLength(2);
    expect(nav.every(item => item.type === 'group-header')).toBe(true);
  });

  it('skips group with no sessions (non-sticky)', () => {
    const groups = [makeGroup('/a', [])];
    const nav = buildFlatNavList(groups);
    expect(nav).toEqual([]);
  });

  it('skips empty groups but preserves non-empty siblings', () => {
    const groups = [makeGroup('/a', []), makeGroup('/b', ['s1'])];
    const nav = buildFlatNavList(groups);
    expect(nav).toEqual([
      { type: 'group-header', id: '/b', groupIndex: 1 },
      { type: 'session-card', id: 's1', groupIndex: 1 },
    ]);
  });

});

// ============================================================================
// findNavIndexBySessionId
// ============================================================================

describe('findNavIndexBySessionId', () => {
  const nav = [
    { type: 'group-header' as const, id: '/a', groupIndex: 0 },
    { type: 'session-card' as const, id: 's1', groupIndex: 0 },
    { type: 'session-card' as const, id: 's2', groupIndex: 0 },
    { type: 'group-header' as const, id: '/b', groupIndex: 1 },
    { type: 'session-card' as const, id: 's3', groupIndex: 1 },
  ];

  it('finds session card index', () => {
    expect(findNavIndexBySessionId(nav, 's1')).toBe(1);
    expect(findNavIndexBySessionId(nav, 's3')).toBe(4);
  });

  it('returns -1 for unknown session', () => {
    expect(findNavIndexBySessionId(nav, 'unknown')).toBe(-1);
  });

  it('returns -1 for group header id', () => {
    expect(findNavIndexBySessionId(nav, '/a')).toBe(-1);
  });

  it('returns -1 for empty nav list', () => {
    expect(findNavIndexBySessionId([], 's1')).toBe(-1);
  });
});

// ============================================================================
// moveGroupUp / moveGroupDown
// ============================================================================

describe('moveGroupUp', () => {
  it('swaps with previous element', () => {
    expect(moveGroupUp(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c']);
  });

  it('no-op when already first', () => {
    expect(moveGroupUp(['/a', '/b'], '/a')).toEqual(['/a', '/b']);
  });

  it('no-op for unknown dirPath', () => {
    expect(moveGroupUp(['/a', '/b'], '/x')).toEqual(['/a', '/b']);
  });

  it('returns new array (no mutation)', () => {
    const order = ['/a', '/b'];
    const result = moveGroupUp(order, '/b');
    expect(result).not.toBe(order);
    expect(order).toEqual(['/a', '/b']);
  });
});

describe('moveGroupDown', () => {
  it('swaps with next element', () => {
    expect(moveGroupDown(['/a', '/b', '/c'], '/b')).toEqual(['/a', '/c', '/b']);
  });

  it('no-op when already last', () => {
    expect(moveGroupDown(['/a', '/b'], '/b')).toEqual(['/a', '/b']);
  });

  it('no-op for unknown dirPath', () => {
    expect(moveGroupDown(['/a', '/b'], '/x')).toEqual(['/a', '/b']);
  });

  it('returns new array (no mutation)', () => {
    const order = ['/a', '/b'];
    const result = moveGroupDown(order, '/a');
    expect(result).not.toBe(order);
    expect(order).toEqual(['/a', '/b']);
  });
});

// ============================================================================
// toggleCollapse
// ============================================================================

describe('toggleCollapse', () => {
  it('adds dirPath when not collapsed', () => {
    expect(toggleCollapse([], '/a')).toEqual(['/a']);
  });

  it('removes dirPath when already collapsed', () => {
    expect(toggleCollapse(['/a', '/b'], '/a')).toEqual(['/b']);
  });

  it('returns new array (no mutation)', () => {
    const collapsed = ['/a'];
    const result = toggleCollapse(collapsed, '/a');
    expect(result).not.toBe(collapsed);
    expect(collapsed).toEqual(['/a']);
  });
});
