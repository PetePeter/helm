import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ProfileSpawnCwdContext {
  userProfileId?: string;
  projectStore?: { list: () => Array<{ canonicalPath: string; alternatePaths?: string[] }> };
}

/** Select a stable default cwd when a caller does not provide one. */
export function getDefaultProfileProjectCwd(runtime: ProfileSpawnCwdContext): string {
  if (!runtime?.userProfileId || !runtime.projectStore) throw noProjectFoldersError();

  const projects = runtime.projectStore.list()
    .filter((project) => project.canonicalPath.trim().length > 0)
    .map((project) => resolve(project.canonicalPath))
    .sort(compareProjectPaths);
  if (projects.length === 0) throw noProjectFoldersError();
  return projects[0];
}

/** Reject a cwd that is not inside a project owned by the caller's profile. */
export function assertCwdInProfileProjects(runtime: ProfileSpawnCwdContext, cwd: string): void {
  const displayCwd = cwd || '(empty cwd)';
  if (!runtime?.userProfileId || !runtime.projectStore) throw outsideProfileError(displayCwd);

  const resolvedCwd = resolveProfilePath(cwd);
  if (!resolvedCwd) throw outsideProfileError(displayCwd);

  for (const project of runtime.projectStore.list()) {
    const projectPaths = [project.canonicalPath, ...(project.alternatePaths ?? [])];
    for (const projectPath of projectPaths) {
      const resolvedProject = resolveProfilePath(projectPath);
      if (resolvedProject && isPathWithin(resolvedProject, resolvedCwd)) return;
    }
  }

  throw outsideProfileError(displayCwd);
}

function outsideProfileError(cwd: string): Error {
  return new Error(`Cannot spawn in cwd "${cwd}": it is outside the profile's project folders.`);
}

function noProjectFoldersError(): Error {
  return new Error('Cannot spawn without a cwd: this profile has no project folders. Add a project first.');
}

function compareProjectPaths(left: string, right: string): number {
  const leftKey = process.platform === 'win32' ? left.toLowerCase() : left;
  const rightKey = process.platform === 'win32' ? right.toLowerCase() : right;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveProfilePath(path: string): string | null {
  if (!path.trim()) return null;
  let probe = resolve(path);
  const missingParts: string[] = [];
  while (true) {
    try {
      const canonical = realpathSync.native(probe);
      if (probe === resolve(path) && !statSync(canonical).isDirectory()) return null;
      const base = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      return resolve(base, ...missingParts);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = dirname(probe);
      if (parent === probe) return null;
      missingParts.unshift(basename(probe));
      probe = parent;
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
