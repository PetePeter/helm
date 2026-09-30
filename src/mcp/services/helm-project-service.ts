import { validateProjectDirectory } from '../../session/validation.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { MemoryManager } from '../../session/memory-manager.js';

/**
 * Project management for the MCP surface.
 * Delegates to ProjectStore for persistence and wraps results for MCP consumers.
 */
export class HelmProjectService {
  /**
   * The memory manager arrives after construction (it is injected into
   * HelmControlService later), so it is reached through a getter rather than
   * held directly.
   */
  constructor(
    private readonly projectStore: ProjectStore,
    private readonly getMemoryManager: () => Pick<MemoryManager, 'purgeProject'> | null = () => null,
    private readonly getMessManager: () => { purgeProject(projectId: string): void } | null = () => null,
  ) {}

  /**
   * Register a brand-new project (working directory) so it becomes a valid
   * target for plan/sequence/context creation. Validates that the directory
   * exists on disk and is not already registered.
   */
  createProject(dirPath: string, name?: string): { id: string; name: string; canonicalPath: string } {
    validateProjectDirectory(dirPath);
    const record = this.projectStore.createProject(dirPath, name);
    this.projectStore.save();
    return { id: record.id, name: record.name, canonicalPath: record.canonicalPath };
  }

  renameProject(projectId: string, name: string): { ok: true } {
    if (!this.projectStore.getById(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
    this.projectStore.rename(projectId, name);
    this.projectStore.save();
    return { ok: true };
  }

  setProjectMemoryPrivate(projectId: string, memoryPrivate: boolean): { ok: true } {
    if (!this.projectStore.getById(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
    this.projectStore.setMemoryPrivate(projectId, memoryPrivate);
    this.projectStore.save();
    return { ok: true };
  }

  deleteProject(projectId: string): { ok: true } {
    if (!this.projectStore.getById(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
    // Memories are project-scoped and outlive their sessions, so nothing else
    // would ever reclaim them once the project they describe is gone.
    this.getMemoryManager()?.purgeProject(projectId);
    this.getMessManager()?.purgeProject(projectId);
    this.projectStore.delete(projectId);
    this.projectStore.save();
    return { ok: true };
  }

  listProjects() {
    return this.projectStore.list().map(r => ({
      id: r.id,
      name: r.name,
      canonicalPath: r.canonicalPath,
      directories: [r.canonicalPath],
      memoryPrivate: r.memoryPrivate === true,
    }));
  }

  listProjectDirs(projectId: string) {
    const record = this.projectStore.getById(projectId);
    if (!record) throw new Error(`Project not found: ${projectId}`);
    return [record.canonicalPath];
  }

  addProjectDir(projectId: string, dirPath: string): { ok: true } {
    validateProjectDirectory(dirPath);
    this.projectStore.addDirectory(projectId, dirPath);
    this.projectStore.save();
    return { ok: true };
  }

  removeProjectDir(projectId: string, dirPath: string): { ok: true } {
    validateProjectDirectory(dirPath);
    this.projectStore.removeDirectory(projectId, dirPath);
    this.projectStore.save();
    return { ok: true };
  }
}
