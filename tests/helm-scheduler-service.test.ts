import { describe, expect, it, vi } from 'vitest';
import { HelmSchedulerService } from '../src/mcp/services/helm-scheduler-service.js';
import type { ScheduledTask, CreateScheduledTaskParams, UpdateScheduledTaskParams } from '../src/types/scheduled-task.js';
import type { ConfigLoader, WorkingDirectory } from '../src/config/loader.js';
import type { ProjectStore, ProjectRecord } from '../src/session/project-store.js';

function makeMockScheduler() {
  const tasks = new Map<string, ScheduledTask>();
  const scheduler = {
    createTask: vi.fn((params: CreateScheduledTaskParams): ScheduledTask => {
      const task: ScheduledTask = {
        id: 'task-1',
        title: params.title,
        description: params.description,
        planIds: params.planIds,
        initialPrompt: params.initialPrompt,
        cliType: params.cliType,
        scheduledTime: params.scheduledTime,
        dirPath: params.dirPath,
        scheduleKind: params.scheduleKind,
        intervalMs: params.intervalMs,
        cronExpression: params.cronExpression,
        endDate: params.endDate,
        mode: params.mode,
        targetSessionId: params.targetSessionId,
        onFrozen: params.onFrozen,
        nextRunAt: params.scheduledTime,
        status: 'pending',
        createdAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    }),
    listTasks: vi.fn(() => [...tasks.values()]),
    getTask: vi.fn((id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn((id: string, updates: UpdateScheduledTaskParams) => {
      const task = tasks.get(id);
      const updated = task ? { ...task, ...updates } : { id, ...updates } as unknown as ScheduledTask;
      if (task) tasks.set(id, updated);
      return updated;
    }),
    cancelTask: vi.fn((id: string) => {
      const task = tasks.get(id);
      if (task) { task.status = 'cancelled'; }
      return true;
    }),
    deleteTask: vi.fn((id: string) => tasks.delete(id)),
  };

  return scheduler;
}

/** Mock ConfigLoader that knows one working directory. */
function makeMockConfigLoader(knownPaths: string[] = ['/known/project']): ConfigLoader {
  const dirs: WorkingDirectory[] = knownPaths.map(p => ({
    path: p,
    name: p.split('/').pop()!,
    cliType: 'claude-code',
  }));
  return {
    getWorkingDirectories: vi.fn(() => dirs),
    ensureWorkingDirectory: vi.fn((path: string, name: string) => {
      const wd: WorkingDirectory = { path, name, cliType: 'claude-code' };
      dirs.push(wd);
      return wd;
    }),
  } as unknown as ConfigLoader;
}

describe('HelmSchedulerService', () => {
  it('createTask converts ISO string to Date', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);

    service.createTask({
      title: 'Test',
      initialPrompt: 'hello',
      cliType: 'claude-code',
      dirPath: '/tmp',
      scheduledTime: '2026-05-04T10:00:00Z',
    });

    expect(scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledTime: expect.any(Date),
      }),
    );
    const passedDate = scheduler.createTask.mock.calls[0][0].scheduledTime;
    expect(passedDate.toISOString()).toBe('2026-05-04T10:00:00.000Z');
  });

  it('listTasks delegates', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);
    service.listTasks();
    expect(scheduler.listTasks).toHaveBeenCalled();
  });

  it('getTask delegates with id', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);
    service.getTask('task-1');
    expect(scheduler.getTask).toHaveBeenCalledWith('task-1');
  });

  it('updateTask converts ISO string to Date and delegates', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);

    service.updateTask('task-1', {
      title: 'Updated',
      scheduledTime: '2026-05-05T12:00:00Z',
    });

    expect(scheduler.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      scheduledTime: expect.any(Date),
    }));
    const passedDate = scheduler.updateTask.mock.calls[0][1].scheduledTime;
    expect(passedDate.toISOString()).toBe('2026-05-05T12:00:00.000Z');
  });

  it('cancelTask delegates with id', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);
    service.cancelTask('task-1');
    expect(scheduler.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('deleteTask delegates with id', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);
    service.deleteTask('task-1');
    expect(scheduler.deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('createTask passes all params including interval mode', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);

    service.createTask({
      title: 'Recurring',
      initialPrompt: 'check status',
      cliType: 'claude-code',
      dirPath: '/tmp',
      scheduledTime: '2026-05-04T10:00:00Z',
      scheduleKind: 'interval',
      intervalMs: 300000,
      planIds: ['p1'],
      mode: 'direct',
      targetSessionId: 'sess-1',
    });

    expect(scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleKind: 'interval',
        intervalMs: 300000,
        planIds: ['p1'],
        mode: 'direct',
        targetSessionId: 'sess-1',
      }),
    );
  });

  it('passes cron fields and converts endDate', () => {
    const scheduler = makeMockScheduler();
    const service = new HelmSchedulerService(scheduler as any);

    service.createTask({
      title: 'Weekday report',
      initialPrompt: 'report',
      cliType: 'claude-code',
      dirPath: '/tmp',
      scheduledTime: '2026-05-04T08:00:00Z',
      scheduleKind: 'cron',
      cronExpression: '0 9 * * 1-5',
      endDate: '2026-12-31T23:59:59Z',
    });

    expect(scheduler.createTask).toHaveBeenCalledWith(expect.objectContaining({
      scheduleKind: 'cron',
      cronExpression: '0 9 * * 1-5',
      endDate: expect.any(Date),
    }));
    expect(scheduler.createTask.mock.calls[0][0].endDate?.toISOString()).toBe('2026-12-31T23:59:59.000Z');
  });

  // ---------------------------------------------------------------------------
  // Working-directory validation
  // ---------------------------------------------------------------------------

  it('createTask throws when dirPath is not a known working directory', () => {
    const scheduler = makeMockScheduler();
    const configLoader = makeMockConfigLoader(['/known/project']);
    const service = new HelmSchedulerService(scheduler as any, configLoader);

    expect(() =>
      service.createTask({
        title: 'Evil',
        initialPrompt: 'hack',
        cliType: 'claude-code',
        dirPath: '/unknown/random-dir',
        scheduledTime: '2026-05-04T10:00:00Z',
      }),
    ).toThrow(/Working directory is not configured in Helm/);

    expect(scheduler.createTask).not.toHaveBeenCalled();
  });

  it('createTask accepts a known working directory', () => {
    const scheduler = makeMockScheduler();
    const configLoader = makeMockConfigLoader(['/known/project']);
    const service = new HelmSchedulerService(scheduler as any, configLoader);

    service.createTask({
      title: 'Good',
      initialPrompt: 'hello',
      cliType: 'claude-code',
      dirPath: '/known/project',
      scheduledTime: '2026-05-04T10:00:00Z',
    });

    expect(scheduler.createTask).toHaveBeenCalled();
  });

  it('createTask self-heals when dirPath belongs to a known project', () => {
    const scheduler = makeMockScheduler();
    const configLoader = makeMockConfigLoader(['/existing/dir']);
    const projectStore = {
      findByPath: vi.fn((dirPath: string) => {
        if (dirPath === '/project-alt-path') return { id: 'p1', name: 'proj', canonicalPath: '/known/project' } as ProjectRecord;
        return null;
      }),
    } as unknown as ProjectStore;
    const service = new HelmSchedulerService(scheduler as any, configLoader, projectStore);

    service.createTask({
      title: 'SelfHeal',
      initialPrompt: 'go',
      cliType: 'claude-code',
      dirPath: '/project-alt-path',
      scheduledTime: '2026-05-04T10:00:00Z',
    });

    expect(scheduler.createTask).toHaveBeenCalled();
    expect(configLoader.ensureWorkingDirectory).toHaveBeenCalledWith('/project-alt-path', 'proj');
  });

  it('updateTask throws when updating dirPath to an unknown directory', () => {
    const scheduler = makeMockScheduler();
    const configLoader = makeMockConfigLoader(['/known/project']);
    const service = new HelmSchedulerService(scheduler as any, configLoader);

    expect(() =>
      service.updateTask('task-1', {
        dirPath: '/unknown/dir',
      }),
    ).toThrow(/Working directory is not configured in Helm/);

    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it('createTask allows unknown dirPath when no configLoader (graceful degradation)', () => {
    const scheduler = makeMockScheduler();
    // No configLoader → validation skipped
    const service = new HelmSchedulerService(scheduler as any);

    service.createTask({
      title: 'NoGate',
      initialPrompt: 'ok',
      cliType: 'claude-code',
      dirPath: '/totally/random',
      scheduledTime: '2026-05-04T10:00:00Z',
    });

    expect(scheduler.createTask).toHaveBeenCalled();
  });

  describe('warnings for a direct task', () => {
    const HOUR = 60 * 60_000;
    const targetState = (contextLevel: 'ok' | 'warn' | 'hot' = 'ok') => () => ({ freezeAfterMs: HOUR, contextLevel });
    const direct = (inMs: number, onFrozen?: 'skip' | 'unfreeze' | 'quickCompact') => ({
      title: 'Watchdog', initialPrompt: 'poke', cliType: '', dirPath: '/tmp',
      scheduledTime: new Date(Date.now() + inMs).toISOString(),
      mode: 'direct' as const, targetSessionId: 'target', onFrozen,
    });

    it('tells the caller to hand over and quick compact when the next run lands past the freeze point', () => {
      const service = new HelmSchedulerService(makeMockScheduler() as any, undefined, undefined, targetState());

      const result = service.createTask(direct(2 * HOUR));

      expect(result.warnings).toEqual([expect.stringMatching(/handover.*session_quick_compact/s)]);
    });

    it('warns that unfreezing an amber session re-reads it all at full price', () => {
      const service = new HelmSchedulerService(makeMockScheduler() as any, undefined, undefined, targetState('warn'));

      const result = service.createTask(direct(10 * 60_000, 'unfreeze'));

      expect(result.warnings).toEqual([expect.stringMatching(/amber.*quickCompact/s)]);
    });

    it('stays quiet for a near run on a green session', () => {
      const service = new HelmSchedulerService(makeMockScheduler() as any, undefined, undefined, targetState());

      expect(service.createTask(direct(10 * 60_000, 'unfreeze'))).toEqual({ id: 'task-1' });
    });

    it('carries the same warnings on update', () => {
      const scheduler = makeMockScheduler();
      const service = new HelmSchedulerService(scheduler as any, undefined, undefined, targetState('hot'));
      service.createTask(direct(10 * 60_000));

      const result = service.updateTask('task-1', { onFrozen: 'unfreeze' });

      expect(result.warnings).toEqual([expect.stringMatching(/red.*quickCompact/s)]);
    });
  });

  it('says "not found" only for an id that does not exist', () => {
    const scheduler = makeMockScheduler();
    scheduler.updateTask.mockReturnValue(null as any);
    const service = new HelmSchedulerService(scheduler as any);
    service.createTask({ title: 'T', initialPrompt: 'p', cliType: 'c', dirPath: '/tmp', scheduledTime: new Date().toISOString() });
    scheduler.getTask('task-1')!.status = 'completed';

    expect(() => service.updateTask('task-1', { title: 'x' })).toThrow('Scheduled task task-1 cannot be updated (status completed)');
    expect(() => service.updateTask('nope', { title: 'x' })).toThrow('Scheduled task not found: nope');
  });
});
