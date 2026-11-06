/**
 * MCP list tools return summaries; bodies and per-item detail come from the
 * matching *_get. Guards against list responses regrowing into tens of KB
 * (memory_list was ~81 KB, scheduler_list ~17 KB before this).
 *
 * The service is a plain fake returning full records, so the test exercises
 * the real dispatcher projection, not a reimplementation of it.
 */
import { describe, expect, it } from 'vitest';
import { callMcpTool, type McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';

const auth = { sessionId: 's1' };

function deps(service: Record<string, unknown>): McpToolDispatcherDeps {
  return { service } as unknown as McpToolDispatcherDeps;
}

async function first(service: Record<string, unknown>, tool: string, args: Record<string, unknown> = {}) {
  const result = await callMcpTool(deps(service), tool, args, auth) as Array<Record<string, unknown>>;
  return result[0]!;
}

describe('MCP list projections', () => {
  it('scheduler_list drops prompts and schedule internals, keeping what picks a task', async () => {
    const item = await first({
      listScheduledTasks: () => [{
        id: 't1', title: 'Dream', dirPath: 'x:/repo', status: 'pending', enabled: false,
        nextRunAt: new Date(5), systemKind: 'dream', cliType: 'c1',
        initialPrompt: 'p'.repeat(400), description: 'd', planIds: ['a'], userPrompt: 'u',
        scheduledTime: new Date(1), intervalMs: 1000, cronExpression: '* * * * *', createdAt: 1,
      }],
    }, 'scheduler_list');
    expect(item).toMatchObject({ id: 't1', title: 'Dream', dirPath: 'x:/repo', status: 'pending', enabled: false, systemKind: 'dream' });
    for (const key of ['initialPrompt', 'description', 'planIds', 'userPrompt', 'cronExpression', 'intervalMs']) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it('plan_list drops descriptions and completion notes', async () => {
    const item = await first({
      listPlans: () => [{ id: 'p1', humanId: 'P-1', title: 'T', status: 'ready', description: 'long', completionNotes: 'n' }],
    }, 'plan_list', { dirPath: 'x:/repo' });
    expect(item).toMatchObject({ id: 'p1', humanId: 'P-1', title: 'T', status: 'ready' });
    expect(item).not.toHaveProperty('description');
    expect(item).not.toHaveProperty('completionNotes');
  });

  it('context_list drops bodies but keeps canvas position for the phone graph', async () => {
    const item = await first({
      listContexts: () => [{ id: 'c1', title: 'T', type: 'note', permission: 'readonly', content: 'body', x: 1, y: 2, planIds: [], sequenceIds: [] }],
    }, 'context_list', { projectId: 'pr' });
    expect(item).toMatchObject({ id: 'c1', title: 'T', x: 1, y: 2 });
    expect(item).not.toHaveProperty('content');
  });

  it('sequence_list drops mission and shared memory but keeps member ids the phone lanes use', async () => {
    const item = await first({
      listPlanSequences: () => [{ id: 's1', title: 'Lane', missionStatement: 'm', sharedMemory: 'x', memberPlanIds: ['a'], memberHumanIds: ['P-1'] }],
    }, 'sequence_list');
    expect(item).toMatchObject({ id: 's1', title: 'Lane', memberPlanIds: ['a'], memberHumanIds: ['P-1'] });
    expect(item).not.toHaveProperty('missionStatement');
    expect(item).not.toHaveProperty('sharedMemory');
  });

  it('project_list drops the nested directory list, keeping the fields the phone reads', async () => {
    const item = await first({
      listProjects: () => [{ id: 'pr', name: 'Helm', canonicalPath: 'x:/repo', directories: [{ path: 'x:/repo' }] }],
    }, 'project_list');
    expect(item).toMatchObject({ id: 'pr', name: 'Helm', canonicalPath: 'x:/repo' });
    expect(item).not.toHaveProperty('directories');
  });

  it('directory_list drops the source breakdown, keeping the fields phone and peers read', async () => {
    const item = await first({
      listDirectories: () => [{ dirPath: 'x:/repo', name: 'repo', projectId: 'pr', projectName: 'Helm', isCanonical: true, source: ['config', 'plans'], planCount: 2, sessionCount: 1 }],
    }, 'directory_list');
    expect(item).toMatchObject({ dirPath: 'x:/repo', name: 'repo', projectId: 'pr', projectName: 'Helm', isCanonical: true });
    expect(item).not.toHaveProperty('source');
  });
});
