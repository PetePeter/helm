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
  sessions = new Map<string, { activityLevel?: string }>([['worker', {}], ['op', {}]]);
  plans = new Map<string, { status: string; task?: PlanTask }>();
  timers: ScheduledTask[] = [];
  ran: string[] = [];

  onSessionUpdated(fn: (e: { id: string; activityLevel?: string }) => void) { this.on('session:updated', fn); }
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

const setLevel = (sessionId: string, activityLevel: string) =>
  port.emit('session:updated', { id: sessionId, activityLevel });
/** A whole builder turn: works, then stops. */
const turnEnds = (sessionId: string) => { setLevel(sessionId, 'active'); setLevel(sessionId, 'inactive'); };

describe('OperatorTaskWatcher', () => {
  it('checks the task as soon as its builder turn ends', () => {
    setLevel('worker', 'active');
    expect(port.ran).toEqual([]);
    setLevel('worker', 'inactive');
    expect(port.ran).toEqual(['t1']);
  });

  it('does not run an unscheduled operator check when its builder finishes', () => {
    port.timers[0] = { ...port.timers[0], scheduleKind: 'none' };

    turnEnds('worker');

    expect(port.ran).toEqual([]);
  });

  it('turns operator checks off when a timer is unscheduled, and keeps it off after rescheduling', () => {
    const timerWasDisabled = { ...timer('t1', 'p1'), scheduleKind: 'none' };
    port.emit('task:changed', timerWasDisabled);
    expect(port.plans.get('p1')!.task?.checks).toBe('off');

    port.timers[0] = { ...timer('t1', 'p1'), scheduleKind: 'interval' };
    turnEnds('worker');

    expect(port.ran).toEqual([]);
  });

  it('checks once per turn end, not when an ended turn later goes idle', () => {
    turnEnds('worker');
    setLevel('worker', 'idle');
    expect(port.ran).toEqual(['t1']);
    turnEnds('worker');
    expect(port.ran).toEqual(['t1', 't1']);
  });

  it('ignores sessions that build no task, and tasks that are done', () => {
    turnEnds('op');
    port.plans.get('p1')!.status = 'done';
    turnEnds('worker');
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

  it('still cleans up an unscheduled timer whose builder disappeared while Helm was down', () => {
    const fresh = new FakePort();
    fresh.plans.set('p2', { status: 'coding', task: { builderSessionId: 'ghost' } });
    fresh.timers.push({ ...timer('t2', 'p2'), scheduleKind: 'none' });

    new OperatorTaskWatcher(fresh).start();

    expect(fresh.timers).toEqual([]);
    expect(fresh.plans.get('p2')!.task?.waitingOn).toMatch(/builder session .*gone/i);
    expect(fresh.plans.get('p2')!.task?.checks).toBe('off');
  });

  it('does not treat a builder that finished before a restart as news', () => {
    const fresh = new FakePort();
    fresh.sessions.set('worker', { activityLevel: 'inactive' });
    fresh.plans.set('p1', { status: 'coding', task: { builderSessionId: 'worker' } });
    fresh.timers.push(timer('t1', 'p1'));
    new OperatorTaskWatcher(fresh).start();

    fresh.emit('session:updated', { id: 'worker', activityLevel: 'idle' });

    expect(fresh.ran).toEqual([]);
  });

  it('turns checks off for good when the user cancels a check timer', () => {
    port.emit('task:changed', { ...timer('t1', 'p1'), status: 'cancelled' });
    expect(port.plans.get('p1')!.task?.checks).toBe('off');
  });
});
