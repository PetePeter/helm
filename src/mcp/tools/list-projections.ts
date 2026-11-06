/**
 * List tools answer with summaries; the matching *_get returns the full record.
 * Every list is read at the start of many workflows, so bodies, prompts and
 * nested collections here cost tokens on every call (memory_list reached
 * ~81 KB, scheduler_list ~17 KB). Fields the phone or fleet peers read from a
 * list stay — see tests/mcp-list-projections.test.ts.
 */
import type { ScheduledTask } from '../../types/scheduled-task.js';

function omit<T extends object>(item: T, keys: readonly string[]): Partial<T> {
  const copy = { ...item } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Partial<T>;
}

const omitAll = <T extends object>(keys: readonly string[]) => (items: readonly T[]) => items.map(item => omit(item, keys));

/** Details via plan_get. */
export const projectPlanList = omitAll(['description', 'completionNotes']);
/** Body via context_get; x/y stay for the phone's graph. */
export const projectContextList = omitAll(['content']);
/** Mission and shared memory via sequence_get; member ids stay for the phone's lanes. */
export const projectSequenceList = omitAll(['missionStatement', 'sharedMemory']);
/** Folders via project_dir_list. */
export const projectProjectList = omitAll(['directories']);
/** Which source registered a folder is never needed to pick one. */
export const projectDirectoryList = omitAll(['source']);

/** Prompt and schedule internals via scheduler_get. */
export function projectSchedulerList(tasks: readonly ScheduledTask[]) {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    dirPath: task.dirPath,
    status: task.status,
    cliType: task.cliType,
    ...(task.enabled !== undefined ? { enabled: task.enabled } : {}),
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
    ...(task.lastRunAt !== undefined ? { lastRunAt: task.lastRunAt } : {}),
    ...(task.systemKind ? { systemKind: task.systemKind } : {}),
    ...(task.mode ? { mode: task.mode } : {}),
    ...(task.error ? { error: task.error } : {}),
  }));
}
