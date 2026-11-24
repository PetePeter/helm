import type { UserTask } from '../../src/types/user-task.js';

export type UserTaskFilter = 'all' | 'mine' | 'ai' | 'urgent' | 'done';
export type UserTaskGrouping = 'project' | 'author';

export interface UserTaskColumn {
  key: string;
  label: string;
  /** Post-it tint index; derived, never stored on the task. */
  tint: number;
  tasks: UserTask[];
}

export const GENERAL_LABEL = 'General';
export const USER_TASK_TINTS = 5;

export function authorLabel(task: UserTask): string {
  return task.author.kind === 'user' ? 'You' : task.author.name;
}

export function matchesFilter(task: UserTask, filter: UserTaskFilter): boolean {
  const done = task.doneAt !== undefined;
  if (filter === 'done') return done;
  if (done) return false;
  if (filter === 'mine') return task.author.kind === 'user';
  if (filter === 'ai') return task.author.kind === 'ai';
  if (filter === 'urgent') return task.urgent;
  return true;
}

export function matchesSearch(task: UserTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [task.title, task.body, authorLabel(task), ...task.attachments.map(a => a.title)]
    .some(text => text.toLowerCase().includes(q));
}

/** Stable tint per key so a project keeps its colour as tasks come and go. */
export function tintFor(key: string): number {
  if (!key) return 0;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return 1 + (Math.abs(hash) % (USER_TASK_TINTS - 1));
}

/**
 * Columns in board order. Tasks keep the manager's order (urgent, then newest)
 * inside each column; columns with an urgent task come first, General last.
 */
export function groupTasks(
  tasks: readonly UserTask[],
  grouping: UserTaskGrouping,
  projectName: (projectId: string) => string | undefined,
): UserTaskColumn[] {
  const columns = new Map<string, UserTaskColumn>();
  for (const task of tasks) {
    const key = grouping === 'project'
      ? task.projectId ?? ''
      : task.author.kind === 'user' ? 'user' : `ai:${task.author.name}`;
    const label = grouping === 'project'
      ? (task.projectId ? projectName(task.projectId) ?? 'Unknown project' : GENERAL_LABEL)
      : authorLabel(task);
    let column = columns.get(key);
    if (!column) {
      column = { key, label, tint: grouping === 'project' ? tintFor(key) : 0, tasks: [] };
      columns.set(key, column);
    }
    column.tasks.push(task);
  }
  return [...columns.values()].sort((a, b) => {
    if (grouping === 'project' && (a.key === '') !== (b.key === '')) return a.key === '' ? 1 : -1;
    const urgent = Number(b.tasks.some(t => t.urgent)) - Number(a.tasks.some(t => t.urgent));
    return urgent || a.label.localeCompare(b.label);
  });
}
