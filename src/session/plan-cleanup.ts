import type { PlanManager } from './plan-manager.js';
import type { ContextManager } from './context-manager.js';

/**
 * Bulk directory cleanup (P-0805), shared by the desktop IPC handlers and the
 * MCP tools (P-0812) so the phone and the desktop delete exactly the same set.
 * Order matters for "Clear unused": sequences go first, because deleting one
 * releases its context bindings — that is what makes those contexts unreferenced.
 */

export interface PlanCleanupCounts {
  donePlans: number;
  emptySequences: number;
  unreferencedContexts: number;
  /** What "Clear unused" deletes: unreferenced contexts plus contexts bound only to empty sequences. */
  unusedContexts: number;
}

/** Counts shown before the user confirms a cleanup — computed without mutating anything. */
export function getPlanCleanupCounts(
  planManager: PlanManager,
  contextManager: ContextManager | undefined,
  dirPath: string,
): PlanCleanupCounts {
  const projectId = planManager.getProjectIdForDirectory(dirPath);
  const emptySequenceIds = new Set(planManager.getEmptySequencesForDirectory(dirPath).map(s => s.id));
  const contexts = projectId && contextManager ? contextManager.listForProject(projectId) : [];
  const bindingsOf = (id: string) => contextManager?.getBindingsForContext(id) ?? [];
  return {
    donePlans: planManager.getForDirectory(dirPath).filter(i => i.status === 'done').length,
    emptySequences: emptySequenceIds.size,
    unreferencedContexts: contexts.filter(c => bindingsOf(c.id).length === 0).length,
    unusedContexts: contexts.filter(c => bindingsOf(c.id).every(
      b => b.targetType === 'sequence' && emptySequenceIds.has(b.targetId),
    )).length,
  };
}

/** Deletes plan-less sequences and releases their context bindings. Returns the count deleted. */
export function clearEmptySequences(
  planManager: PlanManager,
  contextManager: ContextManager | undefined,
  dirPath: string,
): number {
  const deleted = planManager.deleteEmptySequencesForDirectory(dirPath);
  for (const sequence of deleted) contextManager?.removeBindingsForTarget('sequence', sequence.id);
  return deleted.length;
}

/** Deletes the directory's project contexts that have no bindings left. Returns the count deleted. */
export function clearUnreferencedContexts(
  planManager: PlanManager,
  contextManager: ContextManager | undefined,
  dirPath: string,
): number {
  const projectId = planManager.getProjectIdForDirectory(dirPath);
  return projectId ? contextManager?.deleteUnreferencedForProject(projectId) ?? 0 : 0;
}
