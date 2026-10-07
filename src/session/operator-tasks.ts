/**
 * Operator tasks — an in-flight ask the operator is following through.
 *
 * A task is an ordinary plan in the operator's own project carrying a
 * `task` block (who is building it, which plan they work, what it waits on).
 * Its check timer is an ordinary scheduler row whose planIds include the task
 * plan, so the next check is derived, never stored twice.
 */
import type { PlanItem, PlanTask } from '../types/plan.js';
import type { ScheduledTask } from '../types/scheduled-task.js';

const TASK_FIELDS = ['builderSessionId', 'watchPlanId', 'waitingOn', 'checks'] as const;

/**
 * Validate an MCP `task` argument. null clears the block; an object is a
 * PATCH merged into the stored one, where "" removes a field. Unknown keys and
 * non-strings throw — a misspelt field must not silently become a no-op.
 */
export function parsePlanTask(input: unknown): PlanTask | null {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('task must be an object or null');
  const task: PlanTask = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(TASK_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`task.${key} is not a task field (${TASK_FIELDS.join(', ')})`);
    }
    if (typeof value !== 'string') throw new Error(`task.${key} must be a string`);
    task[key as keyof PlanTask] = value.trim();
  }
  return task;
}

/** Apply a parsed patch to a stored block: "" removes a field. */
export function mergePlanTask(current: PlanTask | undefined, patch: PlanTask): PlanTask {
  const merged: PlanTask = { ...current, ...patch };
  for (const field of TASK_FIELDS) if (merged[field] === '') delete merged[field];
  return merged;
}

/** Earliest upcoming run of a live timer linked to [planId]. */
export function nextCheckAt(planId: string, timers: readonly ScheduledTask[]): number | undefined {
  let earliest: number | undefined;
  for (const t of timers) {
    if (t.status !== 'pending' || t.enabled === false || t.scheduleKind === 'none' || !t.planIds.includes(planId)) continue;
    // new Date(): rows that crossed IPC or JSON may carry ISO strings.
    const at = new Date(t.nextRunAt ?? t.scheduledTime).getTime();
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

/** A task's card lines: the stored block plus the builder's name and next check. */
export function taskCardOf(
  planId: string,
  task: PlanTask,
  sessionNameOf: (sessionId: string) => string | undefined,
  nextCheckOf: (planId: string) => number | undefined,
): PlanTask & { builderName?: string; nextCheckAt?: number } {
  const builderName = task.builderSessionId ? sessionNameOf(task.builderSessionId) : undefined;
  const nextCheck = nextCheckOf(planId);
  return {
    ...task,
    ...(builderName ? { builderName } : {}),
    ...(nextCheck !== undefined ? { nextCheckAt: nextCheck } : {}),
  };
}

/** One line per open task plan, for the operator's post-compaction reminder. */
export function openTaskLines(plans: readonly PlanItem[]): string[] {
  return plans
    .filter((plan) => plan.task && plan.status !== 'done')
    .map((plan) => {
      const waiting = plan.task?.waitingOn ? ` (waiting on: ${plan.task.waitingOn})` : '';
      return `${plan.humanId ?? plan.id} "${plan.title}"${waiting}`;
    });
}
