import { describe, it, expect } from 'vitest';
import { groupDirsByProject, locatePath } from '../../renderer/utils/dir-picker-model.js';

const items = [
  { name: 'stray', path: 'C:\\stray' },
  { name: 'app', path: 'C:\\repo\\app', projectId: 'p1', projectName: 'Repo' },
  { name: 'repo', path: 'C:\\repo', projectId: 'p1', projectName: 'Repo', isCanonical: true },
  { name: 'site', path: 'C:\\site', projectId: 'p2', projectName: 'Site' },
];

describe('groupDirsByProject', () => {
  it('returns null when no item carries project metadata (flat list)', () => {
    expect(groupDirsByProject([{ name: 'a', path: 'C:\\a' }])).toBeNull();
  });

  it('groups by project, Main dir first, ungrouped dirs last under Other', () => {
    const groups = groupDirsByProject(items)!;
    expect(groups.map(g => g.title)).toEqual(['Repo', 'Site', 'Other']);
    expect(groups[0].dirs.map(d => d.path)).toEqual(['C:\\repo', 'C:\\repo\\app']);
    expect(groups[2].dirs.map(d => d.path)).toEqual(['C:\\stray']);
  });
});

describe('locatePath', () => {
  const groups = groupDirsByProject(items)!;

  it('finds the project and dir index of a path', () => {
    expect(locatePath(groups, 'C:\\repo\\app')).toEqual({ projectIndex: 0, dirIndex: 1 });
  });

  it('returns null for an unknown or missing path', () => {
    expect(locatePath(groups, 'C:\\nope')).toBeNull();
    expect(locatePath(groups, undefined)).toBeNull();
  });
});
