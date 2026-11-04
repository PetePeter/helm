import type { MemoryManager } from './memory-manager.js';
import type { PlanManager } from './plan-manager.js';
import type { PlanItem, PlanType } from '../types/plan.js';

export interface CreateSuggestedPlanInput {
  dirPath: string;
  title: string;
  description: string;
  sourceIdeaId?: string;
  type?: PlanType;
  autoImplement?: boolean;
}

/** Coordinates the plan and idea stores at their shared acceptance boundary. */
export class SuggestedPlanService {
  constructor(
    private readonly plans: PlanManager,
    private readonly memories: MemoryManager,
  ) {}

  createSuggested(input: CreateSuggestedPlanInput): PlanItem {
    if (input.sourceIdeaId) {
      this.validateSuggestedSource(input.sourceIdeaId, input.dirPath);
    }
    return this.plans.createSuggested(
      input.dirPath,
      input.title,
      input.description,
      input.sourceIdeaId,
      input.type,
      input.autoImplement,
    );
  }

  /** Apply the same project and stage boundary to externally supplied plan links. */
  validateSuggestedSource(sourceIdeaId: string, dirPath: string): void {
    const projectId = this.plans.getProjectIdForDirectory(dirPath);
    this.requireIdea(sourceIdeaId, projectId, ['suggested']);
    const existing = this.plans.getLiveSuggestedPlanForSourceIdea(sourceIdeaId);
    if (existing) {
      throw new Error(`Source idea ${sourceIdeaId} already has live suggested plan ${existing.id}`);
    }
  }

  accept(planId: string): { ok: true } {
    const plan = this.plans.getItem(planId);
    if (!plan) throw new Error(`Suggested plan not found: ${planId}`);
    if (plan.status !== 'suggested' && !(plan.sourceIdeaId && (plan.status === 'planning' || plan.status === 'ready'))) {
      throw new Error(`Plan ${planId} is not a suggested plan`);
    }

    const idea = plan.sourceIdeaId
      ? this.requireIdea(plan.sourceIdeaId, plan.projectId ?? this.plans.getProjectIdForDirectory(plan.dirPath), ['suggested', 'accepted'])
      : null;
    if (plan.status !== 'suggested') {
      if (idea?.ideaStage === 'accepted') return { ok: true };
      throw new Error(`Plan ${planId} is not a suggested plan`);
    }
    if (idea && idea.ideaStage !== 'accepted') {
      this.memories.update(idea.id, { ideaStage: 'accepted' });
    }
    const accepted = this.plans.acceptSuggested(planId);
    if (!accepted) throw new Error(`Plan ${planId} could not be accepted`);
    return { ok: true };
  }

  reject(planId: string): { ok: true; deleted: boolean } {
    const plan = this.plans.getItem(planId);
    if (!plan) {
      // Delete is naturally idempotent: a phone may retry after its first
      // successful response was lost while the plan disappeared from the board.
      return { ok: true, deleted: false };
    }
    if (plan.status !== 'suggested') {
      throw new Error(`Plan ${planId} is not a suggested plan`);
    }

    const idea = plan.sourceIdeaId
      ? this.requireIdea(plan.sourceIdeaId, plan.projectId ?? this.plans.getProjectIdForDirectory(plan.dirPath), ['suggested', 'rejected'])
      : null;
    if (idea && idea.ideaStage !== 'rejected') {
      this.memories.update(idea.id, { ideaStage: 'rejected' });
    }
    const deleted = this.plans.delete(planId);
    if (!deleted) throw new Error(`Plan ${planId} could not be rejected`);
    return { ok: true, deleted };
  }

  private requireIdea(id: string, projectId: string | null | undefined, allowedStages: readonly string[]) {
    const idea = this.memories.getRecord(id);
    if (!idea || idea.kind !== 'idea') throw new Error(`Source idea not found: ${id}`);
    if (!projectId || idea.projectId !== projectId) throw new Error(`Source idea ${id} belongs to a different project`);
    if (!allowedStages.includes(idea.ideaStage ?? '')) {
      throw new Error(`Source idea ${id} must be at stage ${allowedStages.join(' or ')}`);
    }
    return idea;
  }
}
