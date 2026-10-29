import type { ScheduledTaskManager } from '../../session/scheduled-task-manager.js';
import type { CreateScheduledTaskParams, ScheduledTask, UpdateScheduledTaskParams } from '../../types/scheduled-task.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { ContextLevel } from '../../session/context-limits.js';
import { resolveWorkingDirectory } from './working-dir-gate.js';

/** What the scheduler needs to know about a direct task's target to advise its caller. */
export interface ScheduleTargetState {
  /** Idle time after which Helm auto-freezes the session; Infinity when it never does. */
  freezeAfterMs: number;
  contextLevel?: ContextLevel;
}

const LEVEL_NAMES: Partial<Record<ContextLevel, string>> = { warn: 'amber', hot: 'red' };

/**
 * Scheduler facade for MCP tool operations.
 * Thin wrapper around ScheduledTaskManager with ISO date string conversion
 * and working-directory validation.
 */
export class HelmSchedulerService {
  constructor(
    private readonly scheduler: ScheduledTaskManager,
    private readonly configLoader?: ConfigLoader,
    private readonly projectStore?: ProjectStore,
    private readonly targetState?: (sessionId: string) => ScheduleTargetState | undefined,
  ) {}

  createTask(params: Omit<CreateScheduledTaskParams, 'scheduledTime' | 'endDate'> & { scheduledTime: string; endDate?: string }): { id: string; warnings?: string[] } {
    this.validateWorkingDir(params.dirPath);
    const task = this.scheduler.createTask({
      ...params,
      scheduledTime: new Date(params.scheduledTime),
      endDate: params.endDate ? new Date(params.endDate) : undefined,
    });
    return { id: task.id, ...this.warningsFor(task) };
  }

  listTasks(): ScheduledTask[] {
    return this.scheduler.listTasks();
  }

  getTask(id: string): ScheduledTask | null {
    return this.scheduler.getTask(id);
  }

  updateTask(id: string, updates: Omit<UpdateScheduledTaskParams, 'scheduledTime' | 'endDate'> & { scheduledTime?: string; endDate?: string }): { ok: true; warnings?: string[] } {
    if (updates.dirPath) this.validateWorkingDir(updates.dirPath);
    const { endDate, scheduledTime, ...rest } = updates;
    const converted: UpdateScheduledTaskParams = {
      ...rest,
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
    };
    if (Object.prototype.hasOwnProperty.call(updates, 'endDate')) {
      converted.endDate = endDate ? new Date(endDate) : undefined;
    }
    const result = this.scheduler.updateTask(id, converted);
    if (!result) {
      const existing = this.scheduler.getTask(id);
      throw new Error(existing
        ? `Scheduled task ${id} cannot be updated (status ${existing.status})`
        : `Scheduled task not found: ${id}`);
    }
    return { ok: true, ...this.warningsFor(result) };
  }

  cancelTask(id: string): { ok: true } {
    const cancelled = this.scheduler.cancelTask(id);
    if (!cancelled) throw new Error(`Scheduled task not found: ${id}`);
    return { ok: true };
  }

  deleteTask(id: string): { ok: true } {
    this.scheduler.deleteTask(id);
    return { ok: true };
  }

  /**
   * Advice for the LLM that set a direct task: a run landing past the target's
   * freeze point meets a frozen session, and thawing a full context re-reads
   * all of it at the uncached price. Advice only — the task is saved either way.
   */
  private warningsFor(task: ScheduledTask): { warnings?: string[] } {
    if (task.mode !== 'direct' || !task.targetSessionId || task.status !== 'pending' || !task.nextRunAt) return {};
    const target = this.targetState?.(task.targetSessionId);
    if (!target) return {};
    const warnings: string[] = [];
    const inMs = task.nextRunAt.getTime() - Date.now();
    if (inMs > target.freezeAfterMs) {
      warnings.push(`The next run is in ${Math.round(inMs / 60_000)} min, past the ${Math.round(target.freezeAfterMs / 60_000)} min after which Helm freezes an idle session. `
        + 'Before the target goes idle it should write a handover note and call session_quick_compact; set onFrozen to choose what the run does if it is frozen.');
    }
    const level = target.contextLevel && LEVEL_NAMES[target.contextLevel];
    if (task.onFrozen === 'unfreeze' && level) {
      warnings.push(`The target's context is ${level}: unfreezing re-reads all of it at the uncached price. Consider onFrozen "quickCompact".`);
    }
    return warnings.length ? { warnings } : {};
  }

  private validateWorkingDir(dirPath: string): void {
    if (!this.configLoader) return; // no gate available → allow (shouldn't happen in production)
    resolveWorkingDirectory(this.configLoader, this.projectStore, dirPath);
  }
}
