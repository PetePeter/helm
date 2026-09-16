import type { ConfigLoader } from '../../config/loader.js';
import type { PlanManager } from '../../session/plan-manager.js';
import type { SessionManager } from '../../session/manager.js';
import type { DirectorySummary, CliSummary } from '../helm-control-service.js';
import type { ProjectStore } from '../../session/project-store.js';

/**
 * Case-insensitive path comparison for Windows without resolving relative paths.
 * Used for comparing already-normalized paths (from sessions/config).
 */
function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Directory and CLI type listing for the MCP surface.
 */
export class HelmDirectoryService {
  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly sessionManager: SessionManager,
    private readonly planManager: PlanManager,
    private readonly projectStore?: ProjectStore,
  ) {}

  listDirectories(): DirectorySummary[] {
    const configured = this.configLoader.getWorkingDirectories();
    const sessions = this.sessionManager.getAllSessions();
    const consolidated = new Map<string, DirectorySummary>();

    const mergeEntry = (rawPath: string, sourceTag: 'config' | 'plans' | 'sessions', name?: string) => {
      const project = this.projectStore?.findByPath(rawPath);
      const projectId = project?.id;
      const dirPath = rawPath;
      const existing = consolidated.get(dirPath);
      const planCount = this.planManager.getForDirectory(dirPath).length;
      const sessionCount = sessions.filter((session) => session.workingDir && pathsEqual(session.workingDir, dirPath)).length;
      const source = new Set<Array<'config' | 'plans' | 'sessions'>[number]>(existing?.source ?? []);
      source.add(sourceTag);
      if (planCount > 0) source.add('plans');
      if (sessionCount > 0) source.add('sessions');
      consolidated.set(dirPath, {
        dirPath,
        ...(projectId ? { projectId } : {}),
        ...(project?.name ? { projectName: project.name } : {}),
        name: name ?? existing?.name ?? project?.name ?? dirPath.split(/[/\\]/).pop() ?? dirPath,
        source: [...source],
        planCount: Math.max(existing?.planCount ?? 0, planCount),
        sessionCount: Math.max(existing?.sessionCount ?? 0, sessionCount),
      });
    };

    // 1. Configured directories
    for (const entry of configured) {
      mergeEntry(entry.path, 'config', entry.name);
    }

    // 2. Directories that have plans but aren't configured
    for (const planDir of this.planManager.getAllPlanDirectories()) {
      const isConfigured = configured.some((entry) => pathsEqual(entry.path, planDir));
      if (!isConfigured) {
        mergeEntry(planDir, 'plans');
      }
    }

    // 3. Directories that have sessions but aren't configured
    for (const session of sessions) {
      if (!session.workingDir) continue;
      const workingDir = session.workingDir;
      const isConfigured = configured.some((entry) => pathsEqual(entry.path, workingDir));
      if (!isConfigured) {
        mergeEntry(workingDir, 'sessions');
      }
    }

    return [...consolidated.values()]
      .sort((a, b) => a.dirPath.localeCompare(b.dirPath));
  }

  listClis(): CliSummary[] {
    const supportedDirPaths = this.configLoader.getWorkingDirectories().map((entry) => entry.path);
    return this.configLoader.getCliTypes().map((cliType) => {
      const entry = this.requireCliEntry(cliType);
      return {
        cliType,
        name: entry.name,
        command: entry.spawnCommand ?? '',
        supportsResume: Boolean(entry.spawnCommand || entry.resumeCommand || entry.continueCommand),
        supportedDirPaths,
      };
    });
  }

  private requireCliEntry(cliType: string) {
    const entry = this.configLoader.getCliTypeEntry(cliType);
    if (!entry) {
      throw new Error(`Unknown CLI type: ${cliType}`);
    }
    return entry;
  }
}
