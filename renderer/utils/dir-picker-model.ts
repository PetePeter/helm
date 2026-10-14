/**
 * Pure model for the new-session directory picker: groups the flat dir list
 * into projects for the master/detail layout. Kept free of Vue so a future
 * one-step spawn sheet can reuse it.
 */

export interface DirItem {
  name: string;
  path: string;
  projectId?: string;
  projectName?: string;
  isCanonical?: boolean;
}

export interface DirGroup {
  key: string;
  title: string;
  dirs: DirItem[];
}

const OTHER = 'Other';

/**
 * Group dirs by project, Main (canonical) dir first. Dirs without a project
 * collect under a trailing "Other" group. Returns null when no dir carries
 * project metadata — the picker then shows a flat list.
 */
export function groupDirsByProject(items: readonly DirItem[]): DirGroup[] | null {
  if (!items.some(item => item.projectName)) return null;

  const groups = new Map<string, DirGroup>();
  const other: DirGroup = { key: '', title: OTHER, dirs: [] };
  for (const item of items) {
    if (!item.projectName) { other.dirs.push(item); continue; }
    const key = item.projectId || item.projectName;
    if (!groups.has(key)) groups.set(key, { key, title: item.projectName, dirs: [] });
    groups.get(key)!.dirs.push(item);
  }
  for (const group of groups.values()) {
    group.dirs.sort((a, b) => Number(!!b.isCanonical) - Number(!!a.isCanonical));
  }
  return other.dirs.length ? [...groups.values(), other] : [...groups.values()];
}

/** Position of a path within the groups, or null when absent. */
export function locatePath(
  groups: readonly DirGroup[],
  path: string | undefined,
): { projectIndex: number; dirIndex: number } | null {
  if (!path) return null;
  for (let projectIndex = 0; projectIndex < groups.length; projectIndex++) {
    const dirIndex = groups[projectIndex].dirs.findIndex(dir => dir.path === path);
    if (dirIndex >= 0) return { projectIndex, dirIndex };
  }
  return null;
}
