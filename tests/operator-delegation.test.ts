/**
 * Operator delegation — the `task` an operator must pass when it hands work
 * to a session. The port is a small in-memory fake of the service's plan,
 * scheduler and session surface; the rules under test are the real ones.
 */
import { describe, it, expect } from 'vitest';
import { requireOperatorTask, trackOperatorTask, type OperatorDelegationPort } from '../src/session/operator-delegation.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';
import type { PlanItem, PlanTask } from '../src/types/plan.js';
import type { ScheduledTask } from '../src/types/scheduled-task.js';

class FakePort implements OperatorDelegationPort {
  plans = new Map<string, PlanItem>();
  timers: ScheduledTask[] = [];
  roles: Record<string, string | undefined> = { op: 'operator', worker: undefined };

  getSession(ref: string) {
    return ref in this.roles ? { id: ref, role: this.roles[ref], workingDir: 'C:/op' } : null;
  }
  getPlanIdMapping(ref: string) {
    const plan = [...this.plans.values()].find((p) => p.humanId === ref || p.id === ref);
    if (!plan) throw new Error(`Plan not found: ${ref}`);
    return { uuid: plan.id, humanId: plan.humanId ?? plan.id };
  }
  getPlan(id: string) {
    return this.plans.get(id) ?? null;
  }
  createPlan(dirPath: string, title: string, description: string) {
    const id = `uuid-${this.plans.size + 1}`;
    const humanId = `P-${900 + this.plans.size + 1}`;
    this.plans.set(id, { id, humanId, dirPath, title, description, status: 'ready' } as PlanItem);
    return { id, humanId };
  }
  updatePlan(id: string, updates: { task?: PlanTask | null }) {
    const plan = this.plans.get(id)!;
    plan.task = { ...plan.task, ...updates.task };
    return { ok: true as const, updatedAt: 0 };
  }
  createScheduledTask(params: Omit<ScheduledTask, 'id' | 'status' | 'createdAt' | 'scheduledTime'> & { scheduledTime: string }) {
    const id = `timer-${this.timers.length + 1}`;
    this.timers.push({ ...params, id, status: 'pending', createdAt: 0, scheduledTime: new Date(params.scheduledTime) } as ScheduledTask);
    return { id };
  }
  listScheduledTasks() {
    return this.timers;
  }
}

describe('requireOperatorTask', () => {
  it('asks nothing of a work session', () => {
    expect(requireOperatorTask(new FakePort(), 'worker', undefined, 'session_send_text')).toBeNull();
  });

  it('rejects an operator call with no task, saying what task is', () => {
    expect(() => requireOperatorTask(new FakePort(), 'op', undefined, 'session_send_text'))
      .toThrow(/session_send_text from the operator needs task: a short title .* or the P-id/);
  });

  it('rejects a P-id that is not one of the operator\'s open tasks', () => {
    const port = new FakePort();
    const { id } = port.createPlan('C:/op', 'done thing', '');
    port.plans.get(id)!.status = 'done';
    expect(() => requireOperatorTask(port, 'op', 'P-901', 'session_send_text'))
      .toThrow(/P-901 is done/);
  });
});

describe('trackOperatorTask', () => {
  it('turns a title into a task plan naming the builder, with a repeating check timer', () => {
    const port = new FakePort();
    const task = requireOperatorTask(port, 'op', 'Fix the HA dashboard', 'session_send_text')!;

    const result = trackOperatorTask(port, task, 'worker');

    const plan = port.plans.get('uuid-1')!;
    expect(plan.title).toBe('Fix the HA dashboard');
    expect(plan.task?.builderSessionId).toBe('worker');
    expect(port.timers).toHaveLength(1);
    expect(port.timers[0]).toMatchObject({
      scheduleKind: 'interval', mode: 'direct', targetSessionId: 'op', planIds: ['uuid-1'],
    });
    expect(port.timers[0].initialPrompt).toContain('P-901');
    expect(result).toEqual({ taskId: 'P-901' });
  });

  it('reuses an open task by P-id and never stacks a second timer', () => {
    const port = new FakePort();
    trackOperatorTask(port, requireOperatorTask(port, 'op', 'Fix it', 'session_create')!, 'worker');

    trackOperatorTask(port, requireOperatorTask(port, 'op', 'P-901', 'session_send_text')!, 'worker');

    expect(port.plans.size).toBe(1);
    expect(port.timers).toHaveLength(1);
  });
});

describe('session_create from the operator', () => {
  class SpawningPort extends FakePort {
    spawned = 0;
    spawnCli() {
      this.spawned += 1;
      return { id: 'worker' };
    }
  }
  const deps = (service: SpawningPort) => ({
    service: service as unknown as HelmControlService,
    setPlanStateWithValidation: () => ({}),
    completePlanWithValidation: () => ({}),
  });

  it('is refused, and spawns nothing, without initialPrompt', async () => {
    const service = new SpawningPort();
    await expect(callMcpTool(deps(service), 'session_create', {
      cliType: 'claude-code', dirPath: 'C:/ha', task: 'Fix HA',
    }, { sessionId: 'op' })).rejects.toThrow(/needs initialPrompt: the work for the new session/);
    expect(service.spawned).toBe(0);
  });

  it('spawns with the work and echoes the task it now tracks', async () => {
    const service = new SpawningPort();
    await expect(callMcpTool(deps(service), 'session_create', {
      cliType: 'claude-code', dirPath: 'C:/ha', task: 'Fix HA', initialPrompt: 'Fix the HA dashboard',
    }, { sessionId: 'op' })).resolves.toEqual({ id: 'worker', taskId: 'P-901' });
    expect(service.timers).toHaveLength(1);
  });
});
