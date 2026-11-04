import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './helpers/temp-root.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { MemoryPersistence } from '../src/session/memory-persistence.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { ProjectStore } from '../src/session/project-store.js';
import { SuggestedPlanService } from '../src/session/suggested-plan-service.js';

describe('SuggestedPlanService', () => {
  let root: string | undefined;
  let plans: PlanManager;
  let memories: MemoryManager;
  let service: SuggestedPlanService;
  let dirPath: string;
  let projectId: string;
  const createdPlanIds: string[] = [];

  function setup() {
    root = makeTempRoot('helm-suggested-plan-');
    dirPath = join(root, 'project');
    const projects = new ProjectStore(join(root, 'projects.json'));
    projectId = projects.resolveForPath(dirPath).id;
    projects.save();
    plans = new PlanManager(projects);
    memories = new MemoryManager({
      persistence: new MemoryPersistence(join(root, 'memories.json')),
      resolveSessionProject: () => projectId,
    });
    service = new SuggestedPlanService(plans, memories);
  }

  function createSuggestedIdea(stage: 'seed' | 'growing' | 'suggested' = 'suggested') {
    const idea = memories.createForSession('session-a', {
      kind: 'idea',
      tldr: 'A useful idea',
      content: 'A sufficiently detailed idea description.',
    });
    if (stage !== 'seed') memories.update(idea.id, { ideaStage: stage });
    return memories.getRecord(idea.id)!;
  }

  afterEach(() => {
    for (const id of createdPlanIds.splice(0)) plans?.delete(id);
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('creates a linked suggested plan without putting it on the startable frontier', () => {
    setup();
    const idea = createSuggestedIdea('growing');

    const plan = service.createSuggested({
      dirPath,
      title: 'Build the idea',
      description: 'Implement the accepted idea.',
      sourceIdeaId: idea.id,
    });
    createdPlanIds.push(plan.id);

    expect(plan).toMatchObject({ status: 'suggested', sourceIdeaId: idea.id, projectId });
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('suggested');
    expect(plans.getStartableForDirectory(dirPath).map(item => item.id)).not.toContain(plan.id);
    expect(plans.claimPlan(plan.id, 'session-a')).toBe(false);
    expect(plans.applyItem(plan.id)).toBeNull();
    expect(plans.setState(plan.id, 'planning')).toBeNull();
  });

  it('returns the existing live suggestion on retry and reconciles the idea stage', () => {
    setup();
    const idea = createSuggestedIdea('growing');
    const existing = service.createSuggested({
      dirPath,
      title: 'First suggestion',
      description: 'The first linked plan.',
      sourceIdeaId: idea.id,
    });
    createdPlanIds.push(existing.id);

    const retry = service.createSuggested({
      dirPath,
      title: 'Retry title is ignored',
      description: 'The existing suggestion is reused.',
      sourceIdeaId: idea.id,
    });

    expect(retry.id).toBe(existing.id);
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('suggested');
    expect(plans.getForDirectory(dirPath).filter(plan => plan.sourceIdeaId === idea.id && plan.status === 'suggested'))
      .toHaveLength(1);
  });

  it('repairs a plan created before the idea stage write landed', () => {
    setup();
    const idea = createSuggestedIdea('growing');
    const interruptedPlan = plans.createSuggested(
      dirPath,
      'Interrupted suggestion',
      'The plan write completed before the idea stage update.',
      idea.id,
    );
    createdPlanIds.push(interruptedPlan.id);

    const retry = service.createSuggested({
      dirPath,
      title: 'Retry title is ignored',
      description: 'Reconcile the already-written suggestion.',
      sourceIdeaId: idea.id,
    });

    expect(retry.id).toBe(interruptedPlan.id);
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('suggested');
    expect(plans.getForDirectory(dirPath).filter(plan => plan.sourceIdeaId === idea.id)).toHaveLength(1);
  });

  it('accepts through planning and recomputes an unblocked plan to ready, idempotently', () => {
    setup();
    const idea = createSuggestedIdea();
    const plan = service.createSuggested({ dirPath, title: 'Build it', description: 'Do it.', sourceIdeaId: idea.id });
    createdPlanIds.push(plan.id);

    expect(service.accept(plan.id)).toMatchObject({ ok: true });
    expect(plans.getItem(plan.id)?.status).toBe('ready');
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('accepted');
    expect(service.accept(plan.id)).toMatchObject({ ok: true });
  });

  it('finishes an interrupted accept after the idea write has already landed', () => {
    setup();
    const idea = createSuggestedIdea();
    const plan = service.createSuggested({ dirPath, title: 'Build it', description: 'Do it.', sourceIdeaId: idea.id });
    createdPlanIds.push(plan.id);
    memories.update(idea.id, { ideaStage: 'accepted' });

    expect(service.accept(plan.id)).toMatchObject({ ok: true });
    expect(plans.getItem(plan.id)?.status).toBe('ready');
  });

  it('rejects by writing the idea first, then deleting the plan; retries are safe', () => {
    setup();
    const idea = createSuggestedIdea();
    const plan = service.createSuggested({ dirPath, title: 'Build it', description: 'Do it.', sourceIdeaId: idea.id });
    createdPlanIds.push(plan.id);

    expect(service.reject(plan.id)).toMatchObject({ ok: true });
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('rejected');
    expect(plans.getItem(plan.id)).toBeNull();
    expect(service.reject(plan.id)).toMatchObject({ ok: true });
  });

  it('finishes an interrupted reject after the idea write has already landed', () => {
    setup();
    const idea = createSuggestedIdea();
    const plan = service.createSuggested({ dirPath, title: 'Build it', description: 'Do it.', sourceIdeaId: idea.id });
    createdPlanIds.push(plan.id);
    memories.update(idea.id, { ideaStage: 'rejected' });

    expect(service.reject(plan.id)).toMatchObject({ ok: true });
    expect(plans.getItem(plan.id)).toBeNull();
  });

  it('rejects an unlinked suggestion without a memory write', () => {
    setup();
    const plan = service.createSuggested({ dirPath, title: 'Unlinked', description: 'No source.' });
    createdPlanIds.push(plan.id);

    expect(service.reject(plan.id)).toMatchObject({ ok: true });
    expect(plans.getItem(plan.id)).toBeNull();
    expect(memories.listRecords()).toHaveLength(0);
  });

  it('rejects a seed idea before creating a plan', () => {
    setup();
    const seedIdea = createSuggestedIdea('seed');

    expect(() => service.createSuggested({
      dirPath,
      title: 'Invalid source',
      description: 'Must not be created.',
      sourceIdeaId: seedIdea.id,
    })).toThrow(/growing or suggested/i);
    expect(plans.getForDirectory(dirPath)).toHaveLength(0);
    expect(memories.getRecord(seedIdea.id)?.ideaStage).toBe('seed');
  });

  it('refuses a linked idea from another project before writing either side', () => {
    setup();
    const idea = createSuggestedIdea();
    const otherProjects = new ProjectStore(join(root!, 'other-projects.json'));
    const otherProjectId = otherProjects.resolveForPath(join(root!, 'other')).id;
    otherProjects.save();
    const otherMemories = new MemoryManager({ resolveSessionProject: () => otherProjectId });
    const otherIdea = otherMemories.createForSession('session-b', {
      kind: 'idea',
      tldr: 'Foreign idea',
      content: 'This idea belongs to another project.',
    });
    otherMemories.update(otherIdea.id, { ideaStage: 'suggested' });
    service = new SuggestedPlanService(plans, otherMemories);

    expect(() => service.createSuggested({
      dirPath,
      title: 'Cross-project link',
      description: 'Must fail before writing.',
      sourceIdeaId: otherIdea.id,
    })).toThrow(/project/i);
    expect(plans.getForDirectory(dirPath)).toHaveLength(0);
    expect(otherMemories.getRecord(otherIdea.id)?.ideaStage).toBe('suggested');
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('suggested');
  });
});
