/**
 * Operator delegation — a hand-off the operator must follow up is a tracked task.
 *
 * The operator's prompt asks it to open a follow-up task with a check timer
 * whenever it delegates work, and a model forgets. So its session_create and
 * session_send_text calls carry `task` (a title, or the P-id of an open task)
 * when there is something to follow up, and Helm does the bookkeeping here.
 * A one-off note carries no task and is not tracked. Work sessions are untouched.
 *
 * The timer is only a slow safety net: OperatorTaskWatcher fires the check as
 * soon as the builder finishes, and ends it when the builder goes away.
 */
import type { PlanItem, PlanTask } from '../types/plan.js';
import type { ScheduledTask } from '../types/scheduled-task.js';
import { nextCheckAt } from './operator-tasks.js';

/** Safety-net check interval; the real trigger is the builder's news (OperatorTaskWatcher). */
const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const PLAN_REF = /^(P-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The slice of HelmControlService this needs. */
export interface OperatorDelegationPort {
  getSession(ref: string): { id: string; name?: string; role?: string; workingDir?: string } | null;
  getPlanIdMapping(ref: string): { uuid: string; humanId: string };
  getPlan(id: string): Pick<PlanItem, 'id' | 'humanId' | 'status' | 'task'> | null;
  createPlan(dirPath: string, title: string, description: string): { id: string; humanId: string };
  updatePlan(id: string, updates: { task?: PlanTask | null }): unknown;
  createScheduledTask(params: {
    title: string; initialPrompt: string; cliType: string; dirPath: string; scheduledTime: string;
    scheduleKind: 'interval'; intervalMs: number; planIds: string[]; mode: 'direct'; targetSessionId: string;
  }): { id: string };
  listScheduledTasks(): ScheduledTask[];
}

/** A validated operator task: an open plan to reuse, or a title to open one with. */
export type OperatorTask =
  | { operatorId: string; dirPath: string; planId: string; humanId: string }
  | { operatorId: string; dirPath: string; title: string };

/**
 * Validate BEFORE any side effect, so a rejected call spawns and sends nothing.
 * Null when the caller is not the operator.
 */
export function requireOperatorTask(
  port: OperatorDelegationPort,
  callerId: string | undefined,
  task: unknown,
): OperatorTask | null {
  const caller = callerId ? port.getSession(callerId) : null;
  if (caller?.role !== 'operator') return null;
  const ref = typeof task === 'string' ? task.trim() : '';
  if (!ref) return null; // a one-off: nothing to follow up
  const base = { operatorId: caller.id, dirPath: caller.workingDir ?? '' };
  if (!PLAN_REF.test(ref)) return { ...base, title: ref };
  const { uuid, humanId } = port.getPlanIdMapping(ref);
  const plan = port.getPlan(uuid);
  if (!plan?.task || plan.status === 'done') {
    throw new Error(
      `task ${humanId} is ${plan?.status === 'done' ? 'done' : 'not one of your tasks'}. ` +
        'Pass a short title to open a new task instead.',
    );
  }
  return { ...base, planId: uuid, humanId };
}

/** Record who builds the task and make sure one check timer runs on it. */
export function trackOperatorTask(
  port: OperatorDelegationPort,
  task: OperatorTask,
  builderSessionId: string,
): { taskId: string } {
  const { id, humanId } = 'planId' in task
    ? { id: task.planId, humanId: task.humanId }
    : port.createPlan(task.dirPath, task.title, `Delegated by the operator to session ${builderSessionId}.`);
  port.updatePlan(id, { task: { builderSessionId } });
  const checksOff = port.getPlan(id)?.task?.checks === 'off';
  if (!checksOff && nextCheckAt(id, port.listScheduledTasks()) === undefined) {
    const builder = port.getSession(builderSessionId);
    port.createScheduledTask({
      title: `Check ${humanId}`,
      initialPrompt: `check task ${humanId}: probe session "${builder?.name ?? builderSessionId}" (${builderSessionId})`,
      cliType: '',
      dirPath: task.dirPath,
      scheduledTime: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
      scheduleKind: 'interval',
      intervalMs: CHECK_INTERVAL_MS,
      planIds: [id],
      mode: 'direct',
      targetSessionId: task.operatorId,
    });
  }
  return { taskId: humanId };
}
