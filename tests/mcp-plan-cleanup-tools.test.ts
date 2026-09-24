import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { callMcpTool, type McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { ContextManager } from '../src/session/context-manager.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * P-0812: the phone drives directory cleanup through MCP. These run the real
 * PlanManager + ContextManager through the dispatcher so the MCP path is proven
 * to delete the same set the desktop IPC path does (sequences first, then contexts).
 * Each test uses a unique dirPath: PlanManager shares APPDATA across vitest files.
 */
function setup() {
  const dirPath = `/p0812-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const projectStore = {
    resolveForPath: vi.fn((p: string) => ({ id: p === dirPath ? projectId : 'other-project' })),
    findByPath: vi.fn((p: string) => ({ id: p === dirPath ? projectId : 'other-project' })),
    getById: vi.fn((id: string) => ({ canonicalPath: id === projectId ? dirPath : '/other' })),
    save: vi.fn(),
  } as any;
  const planManager = new PlanManager(projectStore);
  const contextManager = new ContextManager(planManager);
  const configLoader = { getWorkingDirectories: () => [{ name: 'T', path: dirPath }] } as any;
  const service = new HelmControlService(planManager, {} as any, {} as any, configLoader, undefined, contextManager);
  const deps: McpToolDispatcherDeps = {
    service,
    setPlanStateWithValidation: () => ({}),
    completePlanWithValidation: () => ({}),
  };
  const callWith = (name: string, args: Record<string, unknown>) => callMcpTool(deps, name, args, { sessionId: 's1' });
  const call = (name: string) => callWith(name, { dirPath });
  return { dirPath, projectId, planManager, contextManager, call, callWith };
}

describe('plan cleanup MCP tools (P-0812)', () => {
  it('are declared with a required dirPath', () => {
    for (const name of ['plan_cleanup_counts', 'sequence_clear_empty', 'context_clear_unreferenced']) {
      const def = MCP_TOOLS.find(t => t.name === name);
      expect(def?.inputSchema).toMatchObject({ required: ['dirPath'] });
    }
  });

  it('counts, clears empty sequences, then clears the contexts that released', async () => {
    const { dirPath, projectId, planManager, contextManager, call } = setup();
    const item = planManager.create(dirPath, 'Step', '');
    const used = planManager.createSequence(dirPath, 'Used');
    planManager.assignSequence(item.id, used.id);
    const empty = planManager.createSequence(dirPath, 'Empty');
    const boundToEmpty = contextManager.create(projectId, { title: 'Bound to empty' });
    contextManager.bind(boundToEmpty.id, 'sequence', empty.id);
    const boundToPlan = contextManager.create(projectId, { title: 'Bound to plan' });
    contextManager.bind(boundToPlan.id, 'plan', item.id);

    expect(await call('plan_cleanup_counts')).toEqual({
      donePlans: 0, emptySequences: 1, unreferencedContexts: 0, unusedContexts: 1,
    });
    expect(await call('sequence_clear_empty')).toEqual({ deleted: 1 });
    expect(await call('context_clear_unreferenced')).toEqual({ deleted: 1 });

    expect(planManager.getSequence(empty.id)).toBeNull();
    expect(planManager.getSequence(used.id)).not.toBeNull();
    expect(contextManager.get(boundToEmpty.id)).toBeNull();
    expect(contextManager.get(boundToPlan.id)).not.toBeNull();
  });

  it('plan_delete and sequence_delete drop the context bindings, like the desktop does', async () => {
    // Stale bindings would strand the contexts: cleanup counts only unbound ones.
    const { dirPath, projectId, planManager, contextManager, callWith } = setup();
    const item = planManager.create(dirPath, 'Step', '');
    const lane = planManager.createSequence(dirPath, 'Lane');
    const onPlan = contextManager.create(projectId, { title: 'On plan' });
    contextManager.bind(onPlan.id, 'plan', item.id);
    const onLane = contextManager.create(projectId, { title: 'On lane' });
    contextManager.bind(onLane.id, 'sequence', lane.id);
    await callWith('plan_delete', { uuid: item.id });
    await callWith('sequence_delete', { id: lane.id });

    expect(contextManager.getBindingsForContext(onPlan.id)).toEqual([]);
    expect(contextManager.getBindingsForContext(onLane.id)).toEqual([]);
  });

  it('is a no-op on a clean directory', async () => {
    const { call } = setup();
    expect(await call('sequence_clear_empty')).toEqual({ deleted: 0 });
    expect(await call('context_clear_unreferenced')).toEqual({ deleted: 0 });
  });
});
