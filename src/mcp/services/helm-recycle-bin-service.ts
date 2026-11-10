import type { RecycleBinManager } from '../../session/recycle-bin-manager.js';
import type { RecycleBinEntry, RecycleBinRestorer } from '../../types/recycle-bin.js';

export interface RecycleBinSearchOptions {
  query?: string;
  dirPath?: string;
  cliType?: string;
  limit?: number;
}

export interface RecycleBinSearchResult {
  id: string;
  name: string;
  cliType: string;
  dir: string;
  project?: { id?: string; name?: string };
  runtimeGroup?: { id?: string; name?: string };
  closedAt: number;
  mission?: string;
}

export interface RecycleBinRestoreInput {
  id: string;
  /** Expected saved name guard; it is never used to rename the restored session. */
  name?: string;
}

/** Profile-scoped MCP facade over the recycle-bin manager and shared restorer. */
export class HelmRecycleBinService {
  constructor(
    private readonly recycleBin: Pick<RecycleBinManager, 'list' | 'peek'>,
    private readonly profileId: string,
    private readonly restoreEntry: RecycleBinRestorer,
  ) {}

  search(options: RecycleBinSearchOptions = {}): RecycleBinSearchResult[] {
    const query = options.query?.trim().toLowerCase();
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100');
    }

    return this.recycleBin.list()
      .filter(entry => !options.dirPath || entry.workingDir === options.dirPath)
      .filter(entry => !options.cliType || entry.cliType === options.cliType)
      .filter(entry => !query || [entry.name, entry.workingDir, entry.projectName, entry.mission?.text]
        .some(value => value?.toLowerCase().includes(query)))
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, limit)
      .map(entry => projectEntry(entry));
  }

  async restore(input: RecycleBinRestoreInput): Promise<{ sessionId: string }> {
    const entry = this.recycleBin.peek(input.id);
    if (!entry) throw new Error(`Recycle-bin entry not found or expired: ${input.id}`);
    if (input.name !== undefined && input.name !== entry.name) {
      throw new Error('Expected name does not match the recycle-bin entry');
    }

    const restored = await this.restoreEntry(input.id, {
      profileId: this.profileId,
      ...(input.name !== undefined ? { expectedName: input.name } : {}),
    });
    if (!restored) throw new Error(`Recycle-bin entry could not be restored: ${input.id}`);
    return { sessionId: restored.sessionId };
  }
}

function projectEntry(entry: RecycleBinEntry): RecycleBinSearchResult {
  const project = entry.projectId || entry.projectName
    ? { ...(entry.projectId ? { id: entry.projectId } : {}), ...(entry.projectName ? { name: entry.projectName } : {}) }
    : undefined;
  const runtimeGroup = entry.runtimeGroupId || entry.runtimeGroupName
    ? { ...(entry.runtimeGroupId ? { id: entry.runtimeGroupId } : {}), ...(entry.runtimeGroupName ? { name: entry.runtimeGroupName } : {}) }
    : undefined;

  return {
    id: entry.id,
    name: entry.name,
    cliType: entry.cliType,
    dir: entry.workingDir,
    ...(project ? { project } : {}),
    ...(runtimeGroup ? { runtimeGroup } : {}),
    closedAt: entry.closedAt,
    ...(entry.mission?.text ? { mission: entry.mission.text } : {}),
  };
}
