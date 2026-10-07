/**
 * Scheduled Task Types
 *
 * Task scheduling system for CLI sessions with plan references.
 */

export type ScheduledTaskStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
export type ScheduledTaskScheduleKind = 'once' | 'interval' | 'cron';
export type ScheduledTaskScheduleSelection = ScheduledTaskScheduleKind | 'none';
export type ScheduledTaskMode = 'spawn' | 'direct';

export interface ScheduledTask {
  id: string;
  title: string;
  description?: string;
  planIds: string[];
  initialPrompt: string;
  cliType: string;
  cliParams?: string;
  scheduledTime: Date;
  scheduleKind?: ScheduledTaskScheduleSelection;
  intervalMs?: number;
  cronExpression?: string;
  endDate?: Date;
  nextRunAt?: Date;
  dirPath: string;
  mode?: ScheduledTaskMode;
  targetSessionId?: string;
  /** Helm-owned recurring task kind. System rows cannot be deleted. */
  systemKind?: 'dream';
  /** Whether the task may run. Undefined preserves legacy task behaviour. */
  enabled?: boolean;
  /** User additions to a Helm-owned system prompt. */
  userPrompt?: string;
  /** Stable project ownership for Helm-owned system rows. */
  projectId?: string;
  status: ScheduledTaskStatus;
  sessionId?: string;
  createdAt: number;
  completedAt?: number;
  lastRunAt?: number;
  error?: string;
}

/**
 * A historical record of a scheduled task run.
 *
 * Captures the task's setup fields snapshotted at fire time so the entry is
 * stable even when a recurring task is reset to pending after running.
 * Intentionally carries NO stdout/pty output — history is metadata only.
 */
export interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  title: string;
  description?: string;
  initialPrompt: string;
  cliType: string;
  cliParams?: string;
  dirPath: string;
  mode?: ScheduledTaskMode;
  targetSessionId?: string;
  scheduleKind?: ScheduledTaskScheduleKind;
  intervalMs?: number;
  cronExpression?: string;
  endDate?: Date;
  planIds: string[];
  ranAt: number;
  outcome: 'done' | 'failed' | 'cancelled';
  error?: string;
  sessionId?: string;
}

export interface CreateScheduledTaskParams {
  title: string;
  description?: string;
  planIds: string[];
  initialPrompt: string;
  cliType: string;
  cliParams?: string;
  scheduledTime: Date;
  scheduleKind?: ScheduledTaskScheduleKind;
  intervalMs?: number;
  cronExpression?: string;
  endDate?: Date;
  dirPath: string;
  mode?: ScheduledTaskMode;
  targetSessionId?: string;
}

export interface UpdateScheduledTaskParams {
  title?: string;
  description?: string;
  planIds?: string[];
  initialPrompt?: string;
  cliType?: string;
  cliParams?: string;
  scheduledTime?: Date;
  scheduleKind?: ScheduledTaskScheduleSelection;
  intervalMs?: number;
  cronExpression?: string;
  endDate?: Date;
  dirPath?: string;
  mode?: ScheduledTaskMode;
  targetSessionId?: string;
  enabled?: boolean;
  userPrompt?: string;
}
