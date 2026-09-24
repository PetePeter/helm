import { logger } from '../../utils/logger.js';
import { normalizeProjectPath } from '../../session/project-identity.js';
import { resolveWorkingDirectory } from './working-dir-gate.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { PlanManager, PlanRefResolution } from '../../session/plan-manager.js';
import type { PlanAttachmentManager } from '../../session/plan-attachment-manager.js';
import type { ContextManager } from '../../session/context-manager.js';
import type { SequenceContextMetadata } from '../../types/context.js';
import { filterPlanItems, type PlanFilter, type PlanItem, type PlanStatus, type PlanType } from '../../types/plan.js';

function claimOf(
  sessionId: string,
  sessionNameOf: (sessionId: string) => string | undefined,
): { sessionId: string; sessionName?: string } {
  const sessionName = sessionNameOf(sessionId);
  return sessionName ? { sessionId, sessionName } : { sessionId };
}

/**
 * Plan CRUD: create, read, update, delete, complete, reopen, state changes,
 * dependency linking/unlinking, and directory/item export.
 */
export class HelmPlanService {
  constructor(
    private readonly planManager: PlanManager,
    private readonly configLoader: ConfigLoader,
    private readonly attachmentManager: PlanAttachmentManager,
    private readonly contextManager?: ContextManager,
    private readonly projectStore?: ProjectStore,
  ) {}

  listPlans(dirPath: string, filter: PlanFilter = 'active'): PlanItem[] {
    const exported = this.planManager.exportDirectory(normalizeProjectPath(dirPath));
    if (!exported) return [];
    return filterPlanItems(exported.items, exported.dependencies, filter);
  }

  /**
   * [sessionNameOf] resolves a claiming session's display name. It is a
   * callback so this service stays free of the session registry; a claim whose
   * session is gone keeps its id and simply has no name.
   */
  plansSummary(
    dirPath: string,
    filter: PlanFilter = 'active',
    sessionNameOf: (sessionId: string) => string | undefined = () => undefined,
  ) {
    const exported = this.planManager.exportDirectory(normalizeProjectPath(dirPath));
    if (!exported) return [];
    const dependencies = exported.dependencies;
    const items = filterPlanItems(exported.items, dependencies, filter);
    // Map over the FULL item set so blockedBy/blocks resolve to P-00xx ids even
    // when the referenced precursor/successor was excluded by the filter.
    const idToHumanId = new Map(exported.items.map((i) => [i.id, i.humanId ?? i.id]));
    return items.map((item) => ({
      id: item.id,
      humanId: item.humanId ?? item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      stateUpdatedAt: item.stateUpdatedAt,
      // The lane a plan belongs to, so a summary reader can group by sequence
      // without a second pass over the full records. Absent when the plan is in
      // no sequence. Nothing else joins this payload: keeping descriptions out
      // is the point of it.
      sequenceId: item.sequenceId,
      // Who is working it, so the phone board can show a claim at a glance.
      // Only the name rides along, never the session record.
      ...(item.sessionId ? claimOf(item.sessionId, sessionNameOf) : {}),
      blockedBy: dependencies
        .filter((d) => d.toId === item.id)
        .map((d) => idToHumanId.get(d.fromId) ?? d.fromId),
      blocks: dependencies
        .filter((d) => d.fromId === item.id)
        .map((d) => idToHumanId.get(d.toId) ?? d.toId),
    }));
  }

  getPlanIdMapping(humanId: string): { uuid: string; humanId: string } {
    const resolution = this.planManager.resolveItemRef(humanId);
    if (resolution.status === 'found') {
      return {
        uuid: resolution.item.id,
        humanId: resolution.item.humanId ?? resolution.item.id,
      };
    }
    if (resolution.status === 'ambiguous') {
      const matches = resolution.matches
        .map((item) => `${item.humanId ?? item.id} (${item.id}) in ${item.dirPath}`)
        .join(', ');
      throw new Error(`Plan ID reference is ambiguous: ${humanId}. Matching plans: ${matches}`);
    }
    throw new Error(`Plan not found: ${humanId}`);
  }

  getPlan(id: string): (Omit<PlanItem, 'sequenceId'> & {
    hasAttachments: boolean;
    sequenceId?: string;
    sequenceContextMetadata?: SequenceContextMetadata[];
  }) | null {
    const plan = this.resolvePlanRef(id, 'Plan')?.item ?? null;
    if (!plan) return null;
    const { sequenceId, ...planWithoutSequence } = plan;
    const sequenceContextMetadata = this.contextManager
      ? this.contextManager.getContextMetadataForPlanWithSequence(plan.id, sequenceId)
      : [];
    return {
      ...planWithoutSequence,
      hasAttachments: this.attachmentManager.list(plan.id).length > 0,
      ...(sequenceId ? { sequenceId } : {}),
      ...(sequenceContextMetadata.length > 0 ? { sequenceContextMetadata } : {}),
    };
  }

  createPlan(dirPath: string, title: string, description: string, type?: PlanType, autoImplement?: boolean): { id: string; humanId: string } {
    const normalizedDir = this.requireWorkingDirectory(dirPath).path;
    const item = this.planManager.createWithType(normalizedDir, title, description, type, autoImplement);
    return { id: item.id, humanId: item.humanId ?? item.id };
  }

  updatePlan(id: string, updates: { title?: string; description?: string; type?: PlanType | null; autoImplement?: boolean; completionRecap?: boolean }): { ok: true; updatedAt: number } {
    const plan = this.resolvePlanRef(id, 'Plan');
    if (!plan) throw new Error(`Plan not found: ${id}`);
    const nextUpdates: { title?: string; description?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean } = {
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
    };
    if (Object.prototype.hasOwnProperty.call(updates, 'type')) {
      nextUpdates.type = updates.type ?? undefined;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'autoImplement')) {
      nextUpdates.autoImplement = updates.autoImplement;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'completionRecap')) {
      nextUpdates.completionRecap = updates.completionRecap;
    }
    const updated = this.planManager.updateWithType(plan.item.id, nextUpdates);
    if (!updated) throw new Error(`Plan not found: ${id}`);
    return { ok: true, updatedAt: updated.updatedAt };
  }

  deletePlan(id: string): boolean {
    const plan = this.resolvePlanRef(id, 'Plan');
    if (!plan) return false;
    const deleted = this.planManager.delete(plan.item.id);
    if (deleted) {
      this.attachmentManager.deletePlanAttachments(plan.item.id);
      // Same as the desktop's plan:delete: a stale binding would keep its
      // context counted as used, so cleanup could never clear it.
      this.contextManager?.removeBindingsForTarget('plan', plan.item.id);
    }
    return deleted;
  }

  completePlan(id: string, completionNotes?: string): PlanItem | null {
    logger.info(`[MCP:Service] completePlan id=${id}`);
    const plan = this.resolvePlanRef(id, 'Plan');
    return plan ? this.planManager.completeItem(plan.item.id, completionNotes) : null;
  }

  reopenPlan(id: string): { ok: true } {
    logger.info(`[MCP:Service] reopenPlan id=${id}`);
    const plan = this.resolvePlanRef(id, 'Plan');
    if (!plan) throw new Error(`Plan not found: ${id}`);
    const result = this.planManager.reopenItem(plan.item.id);
    if (!result) throw new Error(`Plan ${id} could not be reopened from its current state`);
    return { ok: true };
  }

  setPlanState(
    id: string,
    status: Exclude<PlanStatus, 'done'>,
    stateInfo?: string,
  ): { ok: true } {
    logger.info(`[MCP:Service] setPlanState id=${id} status=${status}`);
    const plan = this.resolvePlanRef(id, 'Plan');
    if (!plan) throw new Error(`Plan not found: ${id}`);
    const result = this.planManager.setState(plan.item.id, status, stateInfo);
    if (!result) throw new Error(`Plan ${id} could not be set to ${status} from its current state`);
    return { ok: true };
  }

  linkPlans(fromId: string, toId: string): void {
    if (fromId === toId) {
      throw new Error('Cannot link a plan to itself');
    }
    const from = this.resolvePlanRef(fromId, 'Source plan');
    const to = this.resolvePlanRef(toId, 'Target plan');
    if (!from) {
      throw new Error(`Source plan not found: ${fromId}`);
    }
    if (!to) {
      throw new Error(`Target plan not found: ${toId}`);
    }
    if (from.item.id === to.item.id) {
      throw new Error('Cannot link a plan to itself');
    }
    if (from.item.dirPath !== to.item.dirPath) {
      throw new Error('Cannot link plans across different directories');
    }

    const exported = this.planManager.exportDirectory(from.item.dirPath);
    const existing = exported?.dependencies.some((d) => d.fromId === from.item.id && d.toId === to.item.id);
    if (existing) {
      throw new Error('Link already exists between these plans');
    }

    // Check for cycle: adding fromId->toId would create a cycle if toId can already reach fromId
    const deps = exported?.dependencies ?? [];
    const visited = new Set<string>();
    const stack = [to.item.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === from.item.id) {
        throw new Error('Link would create a cycle (circular ordering is not allowed)');
      }
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dep of deps) {
        if (dep.fromId === current) {
          stack.push(dep.toId);
        }
      }
    }

    const success = this.planManager.addDependency(from.item.id, to.item.id);
    if (!success) {
      throw new Error('Failed to link plans');
    }
  }

  unlinkPlans(fromId: string, toId: string): void {
    const from = this.resolvePlanRef(fromId, 'Source plan');
    const to = this.resolvePlanRef(toId, 'Target plan');
    if (!from) {
      throw new Error(`Source plan not found: ${fromId}`);
    }
    if (!to) {
      throw new Error(`Target plan not found: ${toId}`);
    }
    const success = this.planManager.removeDependency(from.item.id, to.item.id);
    if (!success) {
      throw new Error('Link not found between these plans');
    }
  }

  exportDirectory(dirPath: string): { dirPath: string; items: PlanItem[]; dependencies: { fromId: string; toId: string }[] } | null {
    return this.planManager.exportDirectory(dirPath);
  }

  exportItem(id: string): { item: PlanItem; dependencies: { fromId: string; toId: string }[] } | null {
    const plan = this.resolvePlanRef(id, 'Plan');
    return plan ? this.planManager.exportItem(plan.item.id) : null;
  }

  private resolvePlanRef(ref: string, label: string): Extract<PlanRefResolution, { status: 'found' }> | null {
    const resolution = this.planManager.resolveItemRef(ref);
    if (resolution.status === 'found') return resolution;
    if (resolution.status === 'ambiguous') {
      const matches = resolution.matches
        .map((item) => `${item.humanId ?? item.id} (${item.id}) in ${item.dirPath}`)
        .join(', ');
      throw new Error(`${label} reference is ambiguous: ${ref}. Matching plans: ${matches}`);
    }
    return null;
  }

  private requireWorkingDirectory(dirPath: string) {
    return resolveWorkingDirectory(this.configLoader, this.projectStore, dirPath);
  }
}
