/**
 * Operator task checks follow the builder's news, not a blind poll.
 *
 * A check timer (operator-delegation.ts) is a slow safety net. What actually
 * gives the operator something to do is the builder session finishing or
 * standing down, so that fires the check now. A builder that is gone leaves
 * nothing to probe, so its checks end without a prompt. And a check timer the
 * user cancelled marks the task `checks: "off"`, so a later hand-off for the
 * same task never quietly re-arms it.
 */
import type { PlanTask } from '../types/plan.js';
import type { ScheduledTask } from '../types/scheduled-task.js';
import { logger } from '../utils/logger.js';

/** Builder phases that mean "come and look". */
const NEWS_STATES = new Set(['completed', 'idle']);

export interface OperatorTaskWatcherPort {
  onSessionUpdated(listener: (e: { id: string; aiagentState?: string }) => void): void;
  onSessionRemoved(listener: (e: { sessionId: string }) => void): void;
  onTimerChanged(listener: (timer: ScheduledTask) => void): void;
  /** The session's AIAGENT phase record, or null when the session does not exist. */
  getSession(id: string): { aiagentState?: string } | null;
  getPlan(id: string): { status: string; task?: PlanTask } | null;
  patchPlanTask(id: string, patch: PlanTask): void;
  listScheduledTasks(): ScheduledTask[];
  runTaskNow(id: string): unknown;
  deleteTask(id: string): unknown;
}

export class OperatorTaskWatcher {
  private readonly lastState = new Map<string, string | undefined>();

  constructor(private readonly port: OperatorTaskWatcherPort) {}

  start(): void {
    this.port.onSessionUpdated((e) => this.onStateChange(e.id, e.aiagentState));
    this.port.onSessionRemoved((e) => this.endChecksFor(e.sessionId));
    this.port.onTimerChanged((t) => this.onTimerChanged(t));
    for (const { planId, task } of this.checks()) {
      const planTask = this.port.getPlan(planId)?.task;
      if (this.isDisabled(task) && planTask?.checks !== 'off') {
        this.port.patchPlanTask(planId, { checks: 'off' });
      }
      const builder = planTask?.builderSessionId;
      if (!builder) continue;
      const session = this.port.getSession(builder);
      // Closed while Helm was down: session:removed never came.
      if (!session) this.endCheck(planId, task.id);
      // Seed, so a builder that finished before a restart is not news again.
      else this.lastState.set(builder, session.aiagentState);
    }
  }

  /** Live check timers, each with the open task plan it checks. */
  private *checks(): Generator<{ planId: string; task: ScheduledTask }> {
    for (const task of this.port.listScheduledTasks()) {
      if (task.status !== 'pending' || task.mode !== 'direct') continue;
      for (const planId of task.planIds) {
        const plan = this.port.getPlan(planId);
        if (plan?.task?.builderSessionId && plan.status !== 'done') yield { planId, task };
      }
    }
  }

  private checksBuiltBy(sessionId: string) {
    return [...this.checks()].filter(({ planId }) => this.port.getPlan(planId)?.task?.builderSessionId === sessionId);
  }

  private onStateChange(sessionId: string, state: string | undefined): void {
    const previous = this.lastState.get(sessionId);
    this.lastState.set(sessionId, state);
    if (!state || state === previous || !NEWS_STATES.has(state)) return;
    for (const { planId, task } of this.checksBuiltBy(sessionId)) {
      if (this.isDisabled(task) || this.port.getPlan(planId)?.task?.checks === 'off') continue;
      logger.info(`[OperatorTaskWatcher] builder ${sessionId} is ${state} — checking "${task.title}" now`);
      void this.port.runTaskNow(task.id);
    }
  }

  private endChecksFor(sessionId: string): void {
    this.lastState.delete(sessionId);
    for (const { planId, task } of this.checksBuiltBy(sessionId)) this.endCheck(planId, task.id);
  }

  private endCheck(planId: string, timerId: string): void {
    logger.info(`[OperatorTaskWatcher] builder of ${planId} is gone — ending its checks`);
    this.port.deleteTask(timerId);
    this.port.patchPlanTask(planId, { waitingOn: 'builder session is gone — nothing to probe' });
  }

  private onTimerChanged(timer: ScheduledTask): void {
    if (timer.status !== 'cancelled' && !this.isDisabled(timer)) return;
    for (const planId of timer.planIds) {
      const plan = this.port.getPlan(planId);
      if (plan?.task && plan.status !== 'done') this.port.patchPlanTask(planId, { checks: 'off' });
    }
  }

  private isDisabled(task: ScheduledTask): boolean {
    return task.enabled === false || task.scheduleKind === 'none';
  }
}
