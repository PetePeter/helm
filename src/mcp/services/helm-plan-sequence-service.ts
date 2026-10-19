import { resolveWorkingDirectory } from './working-dir-gate.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { PlanManager, PlanRefResolution } from '../../session/plan-manager.js';
import type { PlanItem, PlanSequence } from '../../types/plan.js';

export type PlanSequenceMemberFields = {
  memberPlanIds: string[];
  memberHumanIds: string[];
  openMemberPlanIds: string[];
  openMemberHumanIds: string[];
};

/**
 * Plan sequence (shared-memory store) operations: list, create, update,
 * memory append, delete, and plan-to-sequence assignment.
 */
export class HelmPlanSequenceService {
  constructor(
    private readonly planManager: PlanManager,
    private readonly configLoader: ConfigLoader,
    private readonly projectStore?: ProjectStore,
  ) {}

  listPlanSequences(input: { dirPath?: string; planRef?: string }): Array<PlanSequence & PlanSequenceMemberFields & { selectedForPlan?: boolean }> {
    const plan = input.planRef ? this.resolvePlanRef(input.planRef, 'Plan')?.item ?? null : null;
    if (input.planRef && !plan) {
      throw new Error(`Plan not found: ${input.planRef}`);
    }
    const dirPath = input.dirPath ?? plan?.dirPath;
    if (!dirPath) {
      throw new Error('dirPath or planId is required');
    }
    const items = this.planManager.getForDirectory(dirPath);
    return this.planManager.getSequencesForDirectory(dirPath).map((sequence) => {
      const members = items.filter((item) => item.sequenceId === sequence.id);
      return {
        ...sequence,
        ...this.buildMemberFields(members),
        ...(plan ? { selectedForPlan: plan.sequenceId === sequence.id } : {}),
      };
    });
  }

  getPlanSequence(id: string): (PlanSequence & PlanSequenceMemberFields) | null {
    const sequence = this.planManager.getSequence(id);
    if (!sequence) return null;
    const items = this.planManager.getForDirectory(sequence.dirPath);
    const members = items.filter((item) => item.sequenceId === sequence.id);
    return {
      ...sequence,
      ...this.buildMemberFields(members),
    };
  }

  private buildMemberFields(members: PlanItem[]): PlanSequenceMemberFields {
    const openMembers = members.filter((item) => item.status !== 'done');
    return {
      memberPlanIds: members.map((item) => item.id),
      memberHumanIds: members.map((item) => item.humanId ?? item.id),
      openMemberPlanIds: openMembers.map((item) => item.id),
      openMemberHumanIds: openMembers.map((item) => item.humanId ?? item.id),
    };
  }

  createPlanSequence(input: { dirPath: string; title: string; missionStatement?: string; sharedMemory?: string }): { id: string } {
    const normalizedDir = this.requireWorkingDirectory(input.dirPath).path;
    const seq = this.planManager.createSequence(normalizedDir, input.title, input.missionStatement ?? '', input.sharedMemory ?? '');
    return { id: seq.id };
  }

  updatePlanSequence(
    id: string,
    updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number; expectedUpdatedAt?: number },
  ): { ok: true; updatedAt: number } {
    const sequence = this.planManager.getSequence(id);
    if (!sequence) {
      throw new Error(`Sequence not found: ${id}`);
    }
    this.assertSequenceMutex(sequence, updates.expectedUpdatedAt);
    const updated = this.planManager.updateSequence(id, updates);
    if (!updated) {
      throw new Error(`Sequence not found: ${id}`);
    }
    return { ok: true, updatedAt: updated.updatedAt };
  }


  deletePlanSequence(id: string): boolean {
    return this.planManager.deleteSequence(id);
  }

  assignPlanSequence(planRef: string, sequenceId: string | null): { ok: true } {
    const plan = this.resolvePlanRef(planRef, 'Plan')?.item ?? null;
    if (!plan) {
      throw new Error(`Plan not found: ${planRef}`);
    }
    const updated = this.planManager.assignSequence(plan.id, sequenceId);
    if (!updated) {
      throw new Error(sequenceId ? `Sequence not found or not in plan directory: ${sequenceId}` : `Plan not found: ${planRef}`);
    }
    return { ok: true };
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

  private assertSequenceMutex(sequence: PlanSequence, expectedUpdatedAt?: number): void {
    if (expectedUpdatedAt === undefined) return;
    if (sequence.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Sequence ${sequence.id} was updated concurrently. Expected updatedAt=${expectedUpdatedAt}, current updatedAt=${sequence.updatedAt}. Re-read it before writing sharedMemory.`);
    }
  }

  private requireWorkingDirectory(dirPath: string) {
    return resolveWorkingDirectory(this.configLoader, this.projectStore, dirPath);
  }
}
