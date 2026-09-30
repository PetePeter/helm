/**
 * OperatorTaskWatcher — operator task checks follow the builder session's
 * news instead of a blind 30-minute poll: a finished/idle builder prompts the
 * check now, a vanished builder ends the checks, and a check the user cancelled
 * stays cancelled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { OperatorTaskWatcher, type OperatorTaskWatcherPort } from '../src/session/operator-task-watcher.js';
import type { PlanTask } from '../src/types/plan.js';
import type { ScheduledTask } from '../src/types/scheduled-task.js';

class FakePort extends EventEmitter implements OperatorTaskWatcherPort {
  sessions = new Map<string, { aiagentState?: string }>([['worker', {}], ['op', {}]]);
  plans = new Map<string, { status: string; task?: PlanTask }>();
  timers: ScheduledTask[] = [];
  ran: string[] = [];

  onSessionUpdated(fn: (e: { id: string; aiagentState?: string }) => void) { this.on('session:updated', fn); }
  onSessionRemoved(fn: (e: { sessionId: string }) => void) { this.on('session:removed', fn); }
  onTimerChanged(fn: (t: ScheduledTask) => void) { this.on('task:changed', fn); }
  getSession(id: string) { return this.sessions.get(id) ?? null; }
  getPlan(id: string) { return this.plans.get(id) ?? null; }
  patchPlanTask(id: string, patch: PlanTask) {
    const plan = this.plans.get(id)!;
    plan.task = { ...plan.task, ...patch };
  }
  listScheduledTasks() { return this.timers; }
  runTaskNow(id: string) { this.ran.push(id); }
  deleteTask(id: string) { this.timers = this.timers.filter(t => t.id !== id); }
}

const timer = (id: string, planId: string, status: ScheduledTask['status'] = 'pending'): ScheduledTask => ({
  id, title: `Check ${planId}`, planIds: [planId], initialPrompt: 'check task', cliType: '', dirPath: 'C:/op',
  scheduledTime: new Date(), scheduleKind: 'interval', intervalMs: 1, mode: 'direct',
  targetSessionId: 'op', status, createdAt: 0,
} as ScheduledTask);

let port: FakePort;
beforeEach(() => {
  port = new FakePort();
  port.plans.set('p1', { status: 'coding', task: { builderSessionId: 'worker' } });
  port.timers.push(timer('t1', 'p1'));
  new OperatorTaskWatcher(port).start();
});

const setState = (sessionId: string, aiagentState: string) =>
  port.emit('session:updated', { id: sessionId, aiagentState });

describe('OperatorTaskWatcher', () => {
  it('checks the task as soon as its builder reports completed or idle', () => {
    setState('worker', 'implementing');
    expect(port.ran).toEqual([]);
    setState('worker', 'completed');
    expect(port.ran).toEqual(['t1']);
  });

  it('checks once per transition, not on every repeat of the same state', () => {
    setState('worker', 'completed');
    setState('worker', 'completed');
    expect(port.ran).toEqual(['t1']);
    setState('worker', 'implementing');
    setState('worker', 'idle');
    expect(port.ran).toEqual(['t1', 't1']);
  });

  it('ignores sessions that build no task, and tasks that are done', () => {
    setState('op', 'completed');
    port.plans.get('p1')!.status = 'done';
    setState('worker', 'completed');
    expect(port.ran).toEqual([]);
  });

  it('ends the checks without a prompt when the builder session goes away', () => {
    port.sessions.delete('worker');
    port.emit('session:removed', { sessionId: 'worker' });
    expect(port.timers).toEqual([]);
    expect(port.ran).toEqual([]);
    expect(port.plans.get('p1')!.task?.waitingOn).toMatch(/builder session .*gone/i);
  });

  it('on start, ends checks whose builder is already gone (closed while Helm was down)', () => {
    const fresh = new FakePort();
    fresh.plans.set('p2', { status: 'coding', task: { builderSessionId: 'ghost' } });
    fresh.timers.push(timer('t2', 'p2'));
    new OperatorTaskWatcher(fresh).start();
    expect(fresh.timers).toEqual([]);
  });

  it('does not treat a builder that finished before a restart as news', () => {
    const fresh = new FakePort();
    fresh.sessions.set('worker', { aiagentState: 'completed' });
    fresh.plans.set('p1', { status: 'coding', task: { builderSessionId: 'worker' } });
    fresh.timers.push(timer('t1', 'p1'));
    new OperatorTaskWatcher(fresh).start();

    fresh.emit('session:updated', { id: 'worker', aiagentState: 'completed' });

    expect(fresh.ran).toEqual([]);
  });

  it('turns checks off for good when the user cancels a check timer', () => {
    port.emit('task:changed', { ...timer('t1', 'p1'), status: 'cancelled' });
    expect(port.plans.get('p1')!.task?.checks).toBe('off');
  });
});
