import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './helpers/temp-root.js';
import { ConfigLoader } from '../src/config/loader.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { MemoryPersistence } from '../src/session/memory-persistence.js';
import { PlanAttachmentManager } from '../src/session/plan-attachment-manager.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { ProjectStore } from '../src/session/project-store.js';
import { SuggestedPlanService } from '../src/session/suggested-plan-service.js';
import { ContextManager } from '../src/session/context-manager.js';
import { HelmPlanService } from '../src/mcp/services/helm-plan-service.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { asPlanStatus } from '../src/mcp/tools/validation.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';

describe('suggested plan MCP surface', () => {
  let root: string | undefined;
  let plans: PlanManager | undefined;

  afterEach(() => {
    if (plans) {
      for (const item of plans.getForDirectory(join(root!, 'project'))) plans.delete(item.id);
    }
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('exposes dedicated accept/reject tools and rejects suggested as a generic state', () => {
    const names = new Set(MCP_TOOLS.map(tool => tool.name));
    expect(names.has('plan_accept_suggestion')).toBe(true);
    expect(names.has('plan_reject_suggestion')).toBe(true);
    expect(() => asPlanStatus('suggested')).toThrow(/planning.*ready.*coding.*review.*blocked/i);
  });

  it('creates through plan_create and routes accept/reject through the shared service', async () => {
    root = makeTempRoot('helm-suggested-mcp-');
    const dirPath = join(root, 'project');
    const projects = new ProjectStore(join(root, 'projects.json'));
    const projectId = projects.resolveForPath(dirPath).id;
    plans = new PlanManager(projects);
    const memories = new MemoryManager({
      persistence: new MemoryPersistence(join(root, 'memories.json')),
      resolveSessionProject: () => projectId,
    });
    const idea = memories.createForSession('session-a', {
      kind: 'idea',
      tldr: 'A proposed feature',
      content: 'Enough detail for a suggested plan.',
    });
    memories.update(idea.id, { ideaStage: 'suggested' });

    const config = new ConfigLoader(join(root, 'config'));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'settings.yaml'), 'hapticFeedback: true\nnotifications: true\nescProtectionEnabled: true\n', 'utf8');
    config.setProjectStore(projects);
    config.load();
    const service = new HelmPlanService(
      plans,
      config,
      new PlanAttachmentManager(plans, join(root, 'config')),
      new ContextManager(plans),
      projects,
    );
    service.setSuggestedPlanService(new SuggestedPlanService(plans, memories));

    const dispatcherService = {
      createPlan: (...args: Parameters<HelmPlanService['createPlan']>) => service.createPlan(...args),
      getPlan: (id: string) => service.getPlan(id),
      deletePlan: (id: string) => service.deletePlan(id),
      acceptSuggestedPlan: (id: string) => service.acceptSuggestedPlan(id),
      rejectSuggestedPlan: (id: string) => service.rejectSuggestedPlan(id),
    } as unknown as HelmControlService;
    const deps = {
      service: dispatcherService,
      setPlanStateWithValidation: () => undefined,
      completePlanWithValidation: () => undefined,
    };

    const regular = await callMcpTool(deps, 'plan_create', {
      dirPath,
      title: 'Regular plan',
      description: 'Created without the recap flag.',
      completionRecap: true,
    }, {}) as { id: string };
    const regularView = await callMcpTool(deps, 'plan_get', { uuid: regular.id }, {}) as { completionRecap?: boolean };
    expect(regularView.completionRecap).toBe(true);

    const defaultPlan = await callMcpTool(deps, 'plan_create', {
      dirPath,
      title: 'Default plan',
      description: 'Keeps the existing default.',
    }, {}) as { id: string };
    expect(plans.getItem(defaultPlan.id)?.completionRecap).toBeUndefined();

    const accepted = await callMcpTool(deps, 'plan_create', {
      dirPath,
      title: 'Implement idea',
      description: 'Build it.',
      status: 'suggested',
      sourceIdeaId: idea.id,
      completionRecap: true,
    }, {}) as { id: string; humanId: string };
    expect(plans.getItem(accepted.id)).toMatchObject({ status: 'suggested', sourceIdeaId: idea.id });
    const suggestedView = await callMcpTool(deps, 'plan_get', { uuid: accepted.id }, {}) as { completionRecap?: boolean };
    expect(suggestedView.completionRecap).toBe(true);
    expect(await callMcpTool(deps, 'plan_accept_suggestion', { uuid: accepted.humanId }, {})).toEqual({ ok: true });
    expect(plans.getItem(accepted.id)?.status).toBe('ready');
    expect(memories.getRecord(idea.id)?.ideaStage).toBe('accepted');

    const nextIdea = memories.createForSession('session-a', {
      kind: 'idea',
      tldr: 'Another proposed feature',
      content: 'Enough detail for the second suggestion.',
    });
    memories.update(nextIdea.id, { ideaStage: 'suggested' });
    const rejected = await callMcpTool(deps, 'plan_create', {
      dirPath,
      title: 'Do not implement',
      description: 'Reject it.',
      status: 'suggested',
      sourceIdeaId: nextIdea.id,
    }, {}) as { id: string };
    expect(await callMcpTool(deps, 'plan_reject_suggestion', { uuid: rejected.id }, {})).toEqual({ ok: true, deleted: true });
    expect(memories.getRecord(nextIdea.id)?.ideaStage).toBe('rejected');
    expect(plans.getItem(rejected.id)).toBeNull();
    expect(await callMcpTool(deps, 'plan_reject_suggestion', { uuid: rejected.id }, {})).toEqual({ ok: true, deleted: false });

    const deleteIdea = memories.createForSession('session-a', {
      kind: 'idea',
      tldr: 'A suggestion deleted through plan_delete',
      content: 'Generic delete should reject this linked idea.',
    });
    memories.update(deleteIdea.id, { ideaStage: 'suggested' });
    const deletedSuggestion = await callMcpTool(deps, 'plan_create', {
      dirPath,
      title: 'Reject through generic delete',
      description: 'Deleting a suggestion means rejecting it.',
      status: 'suggested',
      sourceIdeaId: deleteIdea.id,
    }, {}) as { id: string };

    expect(await callMcpTool(deps, 'plan_delete', { uuid: deletedSuggestion.id }, {})).toEqual({ deleted: true });
    expect(memories.getRecord(deleteIdea.id)?.ideaStage).toBe('rejected');
    expect(plans.getItem(deletedSuggestion.id)).toBeNull();
  });
});
