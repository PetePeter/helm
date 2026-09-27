/**
 * The lines an operator task's card shows in place of its description:
 * who is building it, what it waits on, and when the operator checks next.
 * "no timer" is shown on purpose — a task nobody will check is a dropped ask.
 */
import { formatDateTime } from '../utils/date-format.js';
import type { PlanTask } from '../../src/types/plan.js';

export interface TaskCardSource extends PlanTask {
  builderName?: string;
  nextCheckAt?: number;
}

export interface TaskCardLines {
  builder?: string;
  waitingOn?: string;
  nextCheck: string;
}

export function taskCardLines(task: TaskCardSource, now: number): TaskCardLines {
  const builder = task.builderName ?? task.builderSessionId;
  const nextCheck = task.nextCheckAt === undefined
    ? 'no timer'
    : task.nextCheckAt <= now ? 'due now' : formatDateTime(task.nextCheckAt);
  return {
    ...(builder ? { builder } : {}),
    ...(task.waitingOn ? { waitingOn: task.waitingOn } : {}),
    nextCheck,
  };
}
