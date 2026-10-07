/**
 * ScheduledTaskManager Tests
 *
 * Tests use fakes (real implementations with in-memory state) rather than mocks.
 * Test real scheduling behavior with short timeouts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ScheduledTaskManager, MAX_TIMER_DELAY_MS } from '../src/session/scheduled-task-manager.js';
import { normalizeProjectPath } from '../src/session/project-identity.js';
import { saveScheduledTasks } from '../src/session/persistence.js';

/** The raw directory the tests schedule into, and the shape it is stored in. */
const TEST_DIR = 'X:\\\\coding\\\\test';
const TEST_DIR_NORMALIZED = normalizeProjectPath(TEST_DIR);

/**
 * The same directory written the way a careless caller would: trailing separator
 * everywhere, plus mixed case on Windows only — case folding is a win32-only part
 * of normalizeProjectPath, so asserting it elsewhere would fail on a case-sensitive
 * filesystem for reasons that have nothing to do with the code under test.
 */
const TEST_DIR_MESSY =
  process.platform === 'win32' ? 'X:\\\\Coding\\\\TEST\\\\' : `${TEST_DIR}\\\\`;

/**
 * Scheduled-task persistence resolves to one process-wide config path — the
 * real user config dir. Reading it makes these tests depend on whatever the
 * running app happens to have scheduled, and writing it races the other suite
 * that drives a ScheduledTaskManager. Keep the store in memory.
 */
vi.mock('../src/session/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  let stored: unknown[] = [];
  return {
    ...actual,
    saveScheduledTasks: (tasks: unknown[]) => { stored = tasks; },
    loadScheduledTasks: () => stored,
  };
});
import type { ScheduledTask, ScheduledTaskHistoryEntry, CreateScheduledTaskParams } from '../src/types/scheduled-task.js';
import type { ProjectRecord } from '../src/types/project.js';

// ─── Fakes for dependencies ─────────────────────────────────────────────────────

class FakeSessionManager {
  private sessions = new Map<string, Record<string, unknown> & { id: string; cliType: string; workingDir: string }>();
  private activeSessionId: string | null = null;

  spawn(cliType: string, workingDir: string, env?: Record<string, string>): string {
    const id = `session-${Date.now()}`;
    this.sessions.set(id, { id, cliType, workingDir });
    return id;
  }

  hasSession(id: string) { return this.sessions.has(id); }
  updateSession(id: string, patch: Record<string, unknown>) { Object.assign(this.sessions.get(id)!, patch); }
  getSession(id: string) { return this.sessions.get(id); }
  getActiveSession() { return this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null; }
  addSession(session: Record<string, unknown> & { id: string; cliType: string; workingDir: string }) {
    this.sessions.set(session.id, session);
    if (!this.activeSessionId) this.activeSessionId = session.id;
  }
  setActiveSession(id: string) { this.activeSessionId = id; }
  removeSession(id: string) {
    this.sessions.delete(id);
    if (this.activeSessionId === id) this.activeSessionId = null;
  }
}

class FakePtyManager extends EventEmitter {
  private writes = new Map<string, string[]>();
  private activePids = new Set<string>();

  constructor() {
    super();
  }

  async spawnCommand(
    cliType: string,
    workingDir: string,
    _env?: Record<string, string>,
  ): Promise<{ pid: number; sessionId: string }> {
    const sessionId = `pty-${Date.now()}`;
    return { pid: 1234, sessionId };
  }

  spawn(options: { sessionId: string }): { pid: number } {
    this.activePids.add(options.sessionId);
    return { pid: 1234 + options.sessionId.length };
  }

  has(sessionId: string): boolean {
    return this.activePids.has(sessionId);
  }

  deliverText(sessionId: string, text: string, options?: { withReturn?: boolean; submitSuffix?: string }): void {
    if (!this.writes.has(sessionId)) this.writes.set(sessionId, []);
    const suffix = options?.submitSuffix ?? (options?.withReturn ? '\r' : '');
    this.writes.get(sessionId)!.push(text + suffix);
  }

  async nudgeResize(_sessionId: string): Promise<void> {}

  getWrites(sessionId: string): string[] {
    return this.writes.get(sessionId) ?? [];
  }

  write(sessionId: string, data: string): void {
    if (!this.writes.has(sessionId)) this.writes.set(sessionId, []);
    this.writes.get(sessionId)!.push(data);
  }

  emitExit(sessionId: string): void {
    this.activePids.delete(sessionId);
    this.emit('exit', sessionId, 0);
  }

  kill = vi.fn();
}

class FakePlanManager extends EventEmitter {
  plans = new Map<string, { id: string; title: string; status?: string }>();

  getItem(id: string) { return this.plans.get(id); }

  /** Mirrors PlanManager.completeItem's event. */
  complete(id: string) {
    const item = this.plans.get(id)!;
    item.status = 'done';
    this.emit('plan:completed', item);
  }
}

class FakeConfigLoader {
  submitSuffixByCli = new Map<string, string>();
  envByCli = new Map<string, Array<{ name: string; value: string }>>();
  /** CLI refs that resolve to nothing, as a deleted or misspelled type would. */
  unknownCliTypes = new Set<string>();
  /** CLI refs whose display name maps to more than one type. */
  ambiguousCliTypes = new Set<string>();

  getCliTypeEntry(cliType: string) {
    return {
      env: this.envByCli.get(cliType) ?? [],
      cliType,
      displayName: cliType,
      icon: cliType,
      spawnCommand: `echo ${cliType}`,
      resumeCommand: '',
      continueCommand: '',
      command: '{rawCommand}',
      sessions: {},
      bindings: {},
      sequences: {},
      submitSuffix: this.submitSuffixByCli.get(cliType),
      stickConfig: { mode: 'cursor' },
      dpadConfig: { autoRepeat: true },
    };
  }

  /** Mirrors ConfigLoader's single resolution choke point, throw included. */
  resolveCliType(ref: string) {
    if (this.ambiguousCliTypes.has(ref)) {
      throw new Error(`Ambiguous CLI type display name: ${ref}`);
    }
    if (!ref || this.unknownCliTypes.has(ref)) return null;
    return { id: ref, config: this.getCliTypeEntry(ref) };
  }

  getWorkingDirectories() { return [{ path: 'X:\\\\coding\\\\test', name: 'test' }]; }
  getMcpConfig() { return { authToken: 'test-token', port: 47373, enabled: true }; }
  reloadActiveProfileIfChanged() {}
}

/** In-memory history manager fake — captures appends without touching disk. */
class FakeHistoryManager extends EventEmitter {
  entries: ScheduledTaskHistoryEntry[] = [];
  append(entry: Omit<ScheduledTaskHistoryEntry, 'id'>): ScheduledTaskHistoryEntry {
    const created = { id: `h-${this.entries.length}`, ...entry } as ScheduledTaskHistoryEntry;
    this.entries.unshift(created);
    this.emit('history:changed');
    return created;
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ScheduledTaskManager', () => {
  let manager: ScheduledTaskManager;
  let sessionManager: FakeSessionManager;
  let ptyManager: FakePtyManager;
  let planManager: FakePlanManager;
  let configLoader: FakeConfigLoader;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
    ptyManager = new FakePtyManager();
    planManager = new FakePlanManager();
    configLoader = new FakeConfigLoader();
    manager = new ScheduledTaskManager(
      sessionManager as any,
      ptyManager as any,
      planManager as any,
      configLoader as any,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.stop();
    saveScheduledTasks([]);
  });

  describe('when a linked plan completes', () => {
    const timer = (planIds: string[]): CreateScheduledTaskParams => ({
      title: 'Check', planIds, initialPrompt: 'check task', cliType: 'claude-code',
      scheduledTime: new Date(Date.now() + 60_000), scheduleKind: 'interval', intervalMs: 60_000,
      dirPath: 'X:\\coding\\test',
    });

    it('cancels a timer once every plan it watches is done', () => {
      planManager.plans.set('p1', { id: 'p1', title: 'task' });
      const { id } = manager.createTask(timer(['p1']));

      planManager.complete('p1');

      expect(manager.getTask(id)?.status).toBe('cancelled');
    });

    it('keeps a timer that still watches an open plan', () => {
      planManager.plans.set('p1', { id: 'p1', title: 'a' });
      planManager.plans.set('p2', { id: 'p2', title: 'b' });
      const { id } = manager.createTask(timer(['p1', 'p2']));

      planManager.complete('p1');

      expect(manager.getTask(id)?.status).toBe('pending');
    });
  });

  describe('createTask()', () => {
    it('should generate UUID and set defaults for new task', () => {
      const params: CreateScheduledTaskParams = {
        title: 'Test Task',
        description: 'Test description',
        planIds: [],
        initialPrompt: 'Test prompt',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);

      expect(task.id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
      expect(task.title).toBe('Test Task');
      expect(task.status).toBe('pending');
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.sessionId).toBeUndefined();
      expect(task.completedAt).toBeUndefined();
    });

    it('requires a real cadence when creating a task', () => {
      expect(() => manager.createTask({
        title: 'Unscheduled',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        scheduleKind: 'none' as any,
        dirPath: TEST_DIR,
      })).toThrow(/require a schedule/);
      expect(manager.listTasks()).toHaveLength(0);
    });

    it('rejects an unknown cliType instead of persisting a task that cannot run', () => {
      configLoader.unknownCliTypes.add('deleted-cli');

      expect(() => manager.createTask({
        title: 'Doomed',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'deleted-cli',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: TEST_DIR,
      })).toThrow(/Unknown CLI type/);

      expect(manager.listTasks()).toHaveLength(0);
    });

    it('rejects a spawn task with no cliType', () => {
      expect(() => manager.createTask({
        title: 'No CLI',
        planIds: [],
        initialPrompt: 'Test',
        cliType: '   ',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: TEST_DIR,
      })).toThrow(/require a cliType/);
    });

    it('surfaces an ambiguous display name to the caller rather than at fire time', () => {
      configLoader.ambiguousCliTypes.add('Claude Code');

      expect(() => manager.createTask({
        title: 'Ambiguous',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'Claude Code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: TEST_DIR,
      })).toThrow(/Ambiguous/);
    });

    it('normalizes dirPath so it matches how sessions store workingDir', () => {
      const task = manager.createTask({
        title: 'Messy Path',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: TEST_DIR_MESSY,
      });

      expect(task.dirPath).toBe(TEST_DIR_NORMALIZED);
    });

    it('should emit task:changed event after creation', () => {
      const listener = vi.fn();
      manager.on('task:changed', listener);

      const params: CreateScheduledTaskParams = {
        title: 'Test Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      manager.createTask(params);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('project dream rows', () => {
    const project = {
      id: 'project-1',
      name: 'test',
      canonicalPath: TEST_DIR,
      createdAt: 1,
      updatedAt: 1,
    } satisfies ProjectRecord;

    it('reconciles one disabled row per project and persists user controls', () => {
      manager.reconcileProjects([project]);
      const dream = manager.listTasks()[0];
      expect(dream).toMatchObject({
        projectId: project.id,
        systemKind: 'dream',
        enabled: false,
        userPrompt: '',
        scheduleKind: 'cron',
        cronExpression: expect.stringMatching(/^\d+ \d+ \* \* \*$/),
        status: 'pending',
      });

      manager.reconcileProjects([project]);
      expect(manager.listTasks()).toHaveLength(1);
      expect(() => manager.updateTask(dream.id, { enabled: true })).toThrow(/cliType/);
      expect(() => manager.updateTask(dream.id, { scheduleKind: 'none' })).toThrow(/enabled to control their schedule/);
      expect(manager.updateTask(dream.id, { cliType: 'claude', enabled: true, userPrompt: 'Focus on API decisions.' })).toMatchObject({
        enabled: true,
        cliType: 'claude',
        userPrompt: 'Focus on API decisions.',
      });
      expect(manager.cancelTask(dream.id)).toBe(true);
      expect(manager.getTask(dream.id)).toMatchObject({ enabled: false, status: 'pending' });
      expect(manager.deleteTask(dream.id)).toBe(false);
      (manager.getTask(dream.id) as ScheduledTask).status = 'failed';
      manager.reconcileProjects([project]);
      expect(manager.getTask(dream.id)).toMatchObject({ status: 'pending', enabled: false });
    });

    it('removes deleted-project rows and keeps user prompt separate from the base prompt', () => {
      const other = { ...project, id: 'project-2', canonicalPath: `${TEST_DIR}\\other` } satisfies ProjectRecord;
      manager.reconcileProjects([project, other]);
      const dream = manager.listTasks().find((task) => task.projectId === project.id)!;
      manager.updateTask(dream.id, { userPrompt: 'Keep this addition.' });
      manager.reconcileProjects([other]);
      expect(manager.getTask(dream.id)).toBeNull();
      const otherDream = manager.listTasks()[0];
      expect(otherDream.projectId).toBe(other.id);
      expect((manager as any).buildTaskPrompt({ ...otherDream, userPrompt: 'Keep this addition.' })).toContain('User additions');
      expect((manager as any).buildTaskPrompt({ ...otherDream, userPrompt: 'Keep this addition.' })).toContain('Keep this addition.');
    });
  });

  describe('updateTask()', () => {
    it('should update and reschedule pending tasks', () => {
      const listener = vi.fn();
      manager.on('task:changed', listener);
      const task = manager.createTask({
        title: 'Original',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      });

      const nextTime = new Date(Date.now() + 20000);
      const updated = manager.updateTask(task.id, {
        title: 'Updated',
        initialPrompt: 'Updated prompt',
        cliType: 'codex',
        scheduledTime: nextTime,
      });

      expect(updated).toMatchObject({
        id: task.id,
        title: 'Updated',
        initialPrompt: 'Updated prompt',
        cliType: 'codex',
        scheduledTime: nextTime,
        status: 'pending',
      });
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps a task unscheduled across restart until a fresh future schedule is provided', async () => {
      const oldDue = new Date(Date.now() + 60_000);
      const task = manager.createTask({
        title: 'Recurring task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: oldDue,
        scheduleKind: 'interval',
        intervalMs: 60_000,
        dirPath: TEST_DIR,
      });
      manager.start();

      const unscheduled = manager.updateTask(task.id, { scheduleKind: 'none' });
      expect(unscheduled).toMatchObject({
        status: 'pending',
        scheduleKind: 'none',
      });
      expect(unscheduled).not.toHaveProperty('intervalMs');
      expect(unscheduled).not.toHaveProperty('cronExpression');
      expect(unscheduled).not.toHaveProperty('endDate');
      expect(unscheduled).not.toHaveProperty('nextRunAt');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getTask(task.id)?.status).toBe('pending');

      manager.stop();
      manager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
      );
      manager.start();

      expect(manager.getTask(task.id)).toMatchObject({ status: 'pending', scheduleKind: 'none' });
      expect(manager.getTask(task.id)).not.toHaveProperty('nextRunAt');
      expect(() => manager.updateTask(task.id, { scheduleKind: 'once' })).toThrow(/scheduledTime/i);
      expect(() => manager.updateTask(task.id, {
        scheduleKind: 'once',
        scheduledTime: new Date(Date.now() - 1),
      })).toThrow(/future/i);
      expect(manager.getTask(task.id)?.scheduleKind).toBe('none');

      const freshDue = new Date(Date.now() + 10_000);
      manager.updateTask(task.id, { scheduleKind: 'once', scheduledTime: freshDue });
      expect(manager.getTask(task.id)?.nextRunAt).toEqual(freshDue);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(manager.getTask(task.id)?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();
      const executing = manager.getTask(task.id);
      expect(executing?.status).toBe('executing');
      ptyManager.emitExit(executing!.sessionId!);
      expect(manager.getTask(task.id)?.status).toBe('completed');
    });

    it('refuses to run an unscheduled task through the manual run-now path', async () => {
      const task = manager.createTask({
        title: 'Paused task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 60_000),
        scheduleKind: 'once',
        dirPath: TEST_DIR,
      });
      manager.updateTask(task.id, { scheduleKind: 'none' });

      await expect(manager.runTaskNow(task.id)).resolves.toBe(false);
      expect(manager.getTask(task.id)).toMatchObject({ status: 'pending', scheduleKind: 'none' });
    });

    it('should reject updates for non-pending tasks', () => {
      const task = manager.createTask({
        title: 'Original',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      });
      manager.cancelTask(task.id);

      expect(manager.updateTask(task.id, { title: 'Nope' })).toBeNull();
      expect(manager.getTask(task.id)?.title).toBe('Original');
    });
  });

  describe('scheduleTask()', () => {
    it('should set timeout that fires at scheduledTime', async () => {
      const params: CreateScheduledTaskParams = {
        title: 'Future Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 5000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.start();

      // Fast-forward to just before scheduled time - task should still be pending
      vi.advanceTimersByTime(4000);
      // No timers run yet - status should still be pending
      expect(manager.getTask(task.id)?.status).toBe('pending');

      // Fast-forward past scheduled time
      vi.advanceTimersByTime(2000);
      await vi.runOnlyPendingTimersAsync();
      const executing = manager.getTask(task.id);
      expect(executing?.status).toBe('executing');
      ptyManager.emitExit(executing!.sessionId!);
      expect(manager.getTask(task.id)?.status).toBe('completed');
    });

    it('should not fire a task scheduled beyond the 32-bit timer limit until it is due', async () => {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const params: CreateScheduledTaskParams = {
        title: 'Distant Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + thirtyDays),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.start();

      // A raw setTimeout of 30 days is clamped to 1ms by Node, so this is the
      // window where the bug fired the task ~30 days early.
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.getTask(task.id)?.status).toBe('pending');

      // Cross the bounded wake: the timer fires, finds the task not yet due, re-arms.
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
      expect(manager.getTask(task.id)?.status).toBe('pending');

      // Reach the real due time — exactly one execution.
      await vi.advanceTimersByTimeAsync(thirtyDays - MAX_TIMER_DELAY_MS);
      const executing = manager.getTask(task.id);
      expect(executing?.status).toBe('executing');
      ptyManager.emitExit(executing!.sessionId!);
      expect(manager.getTask(task.id)?.status).toBe('completed');
    });

    it('should never fire a distant task that was cancelled during a bounded wake', () => {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const task = manager.createTask({
        title: 'Distant Cancelled Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + thirtyDays),
        dirPath: 'X:\\\\coding\\\\test',
      });
      manager.start();

      vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
      expect(manager.cancelTask(task.id)).toBe(true);

      vi.advanceTimersByTime(thirtyDays);
      expect(manager.getTask(task.id)?.status).toBe('cancelled');
    });

    it('should clear timer if task is cancelled before firing', () => {
      const params: CreateScheduledTaskParams = {
        title: 'Future Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.start();

      const cancelled = manager.cancelTask(task.id);
      expect(cancelled).toBe(true);

      // Fast-forward past scheduled time
      vi.advanceTimersByTime(15000);
      expect(manager.getTask(task.id)?.status).toBe('cancelled');
    });
  });

  describe('cancelTask()', () => {
    it('should return false after a one-shot task has already executed', async () => {
      const params: CreateScheduledTaskParams = {
        title: 'Test',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000), // Past
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.start();
      vi.advanceTimersByTime(2000); // Trigger execution
      await vi.runOnlyPendingTimersAsync();

      const executing = manager.getTask(task.id);
      expect(executing?.status).toBe('executing');
      ptyManager.emitExit(executing!.sessionId!);
      expect(manager.getTask(task.id)?.status).toBe('completed');
      expect(manager.cancelTask(task.id)).toBe(false);
    });

    it('should emit task:changed event', () => {
      const listener = vi.fn();
      manager.on('task:changed', listener);

      const params: CreateScheduledTaskParams = {
        title: 'Test',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.cancelTask(task.id);

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('should load pending tasks from persistence', () => {
      // Create task, stop manager (which persists), then restart
      const params: CreateScheduledTaskParams = {
        title: 'Persisted Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      manager.createTask(params);
      manager.stop();

      const newManager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
      );
      newManager.start();

      expect(newManager.listTasks()).toHaveLength(1);
      expect(newManager.listTasks()[0].title).toBe('Persisted Task');

      newManager.stop();
    });

    it('should preserve cron fields when loading pending tasks from persistence', () => {
      manager.createTask({
        title: 'Persisted Cron',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(2026, 4, 4, 8, 0, 0),
        scheduleKind: 'cron',
        cronExpression: '0 9 * * 1-5',
        endDate: new Date(2026, 11, 31, 23, 59, 59),
        dirPath: 'X:\\\\coding\\\\test',
      });
      manager.stop();

      const newManager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
      );
      newManager.start();

      const loaded = newManager.listTasks()[0];
      expect(loaded.scheduleKind).toBe('cron');
      expect(loaded.cronExpression).toBe('0 9 * * 1-5');
      expect(loaded.endDate).toBeInstanceOf(Date);
      expect(loaded.nextRunAt).toBeInstanceOf(Date);

      newManager.stop();
    });

    it('heals a legacy task whose dirPath and cliType predate normalization', () => {
      // Written straight to the store in the pre-migration shape, bypassing
      // createTask — that is exactly how these tasks exist on disk today.
      saveScheduledTasks([{
        id: 'legacy-1',
        title: 'Legacy',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'Claude Code',
        scheduledTime: new Date(Date.now() + 10000),
        scheduleKind: 'once',
        dirPath: TEST_DIR_MESSY,
        status: 'pending',
        createdAt: Date.now(),
      } as ScheduledTask]);

      const newManager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
      );
      newManager.start();

      const loaded = newManager.listTasks()[0];
      expect(loaded.dirPath).toBe(TEST_DIR_NORMALIZED);
      expect(loaded.cliType).toBe('Claude Code'); // resolved id; the fake echoes the ref back

      newManager.stop();
    });

    it('keeps a legacy task loadable when its CLI type no longer resolves', () => {
      configLoader.unknownCliTypes.add('deleted-cli');
      saveScheduledTasks([{
        id: 'legacy-2',
        title: 'Legacy Broken',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'deleted-cli',
        scheduledTime: new Date(Date.now() + 10000),
        scheduleKind: 'once',
        dirPath: TEST_DIR,
        status: 'pending',
        createdAt: Date.now(),
      } as ScheduledTask]);

      const newManager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
      );
      newManager.start();

      expect(newManager.listTasks()).toHaveLength(1);
      expect(newManager.listTasks()[0].cliType).toBe('deleted-cli');

      newManager.stop();
    });

    it('should execute tasks with past scheduledTime immediately', async () => {
      const params: CreateScheduledTaskParams = {
        title: 'Past Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 5000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      manager.createTask(params);
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const executing = manager.getTask(manager.listTasks()[0].id);
      expect(executing?.status).toBe('executing');
      ptyManager.emitExit(executing!.sessionId!);
      expect(manager.getTask(executing!.id)?.status).toBe('completed');
    });
  });

  describe('stop()', () => {
    it('should cancel all pending timers', () => {
      const params: CreateScheduledTaskParams = {
        title: 'Future Task',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      manager.createTask(params);
      manager.start();
      manager.stop();

      // Fast-forward - task should NOT execute since stop was called
      vi.advanceTimersByTime(15000);
      expect(manager.getTask(manager.listTasks()[0].id)?.status).toBe('pending');
    });
  });

  describe('executeTask()', () => {
    it('should spawn CLI session with correct cwd and cliType', async () => {
      const spawnSpy = vi.spyOn(ptyManager, 'spawn');

      const params: CreateScheduledTaskParams = {
        title: 'Test',
        planIds: [],
        initialPrompt: 'Test prompt',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      manager.createTask(params);
      manager.start();

      await vi.runOnlyPendingTimersAsync();

      expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({
        rawCommand: 'echo claude-code',
        cwd: TEST_DIR_NORMALIZED,
      }));
    });

    it('appends cliParams to rawCommand when spawnCommand is set', async () => {
      const spawnSpy = vi.spyOn(ptyManager, 'spawn');

      manager.createTask({
        title: 'Resume Test',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
        cliParams: '--resume',
      });
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({
        rawCommand: expect.stringContaining('--resume'),
      }));
    });

    it('does not append empty cliParams to rawCommand', async () => {
      const spawnSpy = vi.spyOn(ptyManager, 'spawn');

      manager.createTask({
        title: 'No Params',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
        cliParams: '',
      });
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const rawCmd = (spawnSpy.mock.calls[0][0] as { rawCommand?: string }).rawCommand;
      expect(rawCmd).toBe('echo claude-code');
    });

    it('sets HELM_SESSION_ID to actual sessionId, not a random UUID', async () => {
      const spawned: Array<{ sessionId?: string; env?: Record<string, string> }> = [];
      const origSpawn = ptyManager.spawn.bind(ptyManager);
      vi.spyOn(ptyManager, 'spawn').mockImplementation((opts) => {
        spawned.push(opts as typeof spawned[0]);
        return origSpawn(opts);
      });

      manager.createTask({
        title: 'Env Test',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
      });
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const sessionId = manager.listTasks().find(t => t.status === 'executing')?.sessionId;
      expect(spawned[0].env?.HELM_SESSION_ID).toBe(sessionId);
    });

    it('applies the CLI type\'s configured env to the spawned session', async () => {
      configLoader.envByCli.set('claude-code', [{ name: 'MY_CLI_FLAG', value: 'on' }]);
      const spawnSpy = vi.spyOn(ptyManager, 'spawn');

      manager.createTask({
        title: 'Configured Env',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: TEST_DIR,
      });
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const env = (spawnSpy.mock.calls[0][0] as { env?: Record<string, string> }).env;
      expect(env?.MY_CLI_FLAG).toBe('on');
      expect(env?.HELM_MCP_TOKEN).toBeTruthy();
    });

    it('delivers task prompt as onComplete callback after CLI init sequences', async () => {
      const delivered: string[] = [];
      const origDeliver = ptyManager.deliverText.bind(ptyManager);
      vi.spyOn(ptyManager, 'deliverText').mockImplementation(async (sid, text) => {
        delivered.push(text);
        return origDeliver(sid, text);
      });

      manager.createTask({
        title: 'Prompt Test',
        planIds: [],
        initialPrompt: 'do the thing',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
      });
      manager.start();
      await vi.runOnlyPendingTimersAsync();

      expect(delivered.some(t => t.includes('do the thing'))).toBe(true);
    });

    it('should complete one-shot tasks and close the background session', async () => {
      const params: CreateScheduledTaskParams = {
        title: 'Test',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
      };

      const task = manager.createTask(params);
      manager.start();

      await vi.runOnlyPendingTimersAsync();

      const updated = manager.getTask(task.id);
      expect(updated?.status).toBe('executing');
      expect(updated?.sessionId).toBeTruthy();
      ptyManager.emitExit(updated!.sessionId!);
      expect(manager.getTask(task.id)?.status).toBe('completed');
      expect(sessionManager.getSession(updated!.sessionId!)).toBeUndefined();
      expect(ptyManager.kill).not.toHaveBeenCalled();
    });

    it('should reschedule interval tasks after execution', async () => {
      const task = manager.createTask({
        title: 'Recurring',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        scheduleKind: 'interval',
        intervalMs: 60000,
        dirPath: 'X:\\\\coding\\\\test',
      });

      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const running = manager.getTask(task.id);
      expect(running?.status).toBe('executing');
      ptyManager.emitExit(running!.sessionId!);
      const updated = manager.getTask(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reschedule cron tasks after execution', async () => {
      vi.setSystemTime(new Date(2026, 4, 4, 8, 59, 0));
      const task = manager.createTask({
        title: 'Cron Report',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(2026, 4, 4, 8, 59, 0),
        scheduleKind: 'cron',
        cronExpression: '0 9 * * 1-5',
        dirPath: 'X:\\\\coding\\\\test',
      });

      expect(task.nextRunAt?.getHours()).toBe(9);
      expect(task.nextRunAt?.getMinutes()).toBe(0);
      manager.start();
      vi.advanceTimersByTime(61_000);
      await vi.runOnlyPendingTimersAsync();

      const running = manager.getTask(task.id);
      expect(running?.status).toBe('executing');
      vi.setSystemTime(new Date(2026, 4, 4, 9, 1, 0));
      ptyManager.emitExit(running!.sessionId!);
      const updated = manager.getTask(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.nextRunAt?.getDate()).toBe(5);
      expect(updated?.nextRunAt?.getHours()).toBe(9);
      expect(updated?.nextRunAt?.getMinutes()).toBe(0);
    });

    it('should complete cron tasks when the next run is past endDate', async () => {
      vi.setSystemTime(new Date(2026, 4, 4, 8, 59, 0));
      const task = manager.createTask({
        title: 'Cron Ends',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(2026, 4, 4, 8, 59, 0),
        scheduleKind: 'cron',
        cronExpression: '0 9 * * *',
        endDate: new Date(2026, 4, 4, 9, 30, 0),
        dirPath: 'X:\\\\coding\\\\test',
      });

      manager.start();
      vi.advanceTimersByTime(61_000);
      await vi.runOnlyPendingTimersAsync();

      const running = manager.getTask(task.id);
      expect(running?.status).toBe('executing');
      vi.setSystemTime(new Date(2026, 4, 4, 9, 1, 0));
      ptyManager.emitExit(running!.sessionId!);
      const completed = manager.getTask(task.id);
      expect(completed?.status).toBe('completed');
      expect(completed?.sessionId).toBeUndefined();
    });
  });

  describe('direct mode', () => {
    it('rejects a direct task with no targetSessionId at create time', () => {
      expect(() => manager.createTask({
        title: 'Orphan Direct',
        planIds: [],
        initialPrompt: 'hello',
        cliType: '',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: TEST_DIR,
        mode: 'direct',
      })).toThrow(/targetSessionId/);

      expect(manager.listTasks()).toHaveLength(0);
    });

    it('rejects a direct task pointed at a session that does not exist', () => {
      expect(() => manager.createTask({
        title: 'Ghost Direct',
        planIds: [],
        initialPrompt: 'hello',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: TEST_DIR,
        mode: 'direct',
        targetSessionId: 'session-dead-gone',
      })).toThrow(/Target session not found/);

      expect(manager.listTasks()).toHaveLength(0);
    });

    it('derives cliType from the target session when none is supplied', () => {
      const targetId = 'session-derive-cli';
      sessionManager.addSession({ id: targetId, cliType: 'codex', workingDir: TEST_DIR });

      const task = manager.createTask({
        title: 'Derived',
        planIds: [],
        initialPrompt: 'hello',
        cliType: '',
        scheduledTime: new Date(Date.now() + 10000),
        dirPath: TEST_DIR,
        mode: 'direct',
        targetSessionId: targetId,
      });

      expect(task.cliType).toBe('codex');
    });

    it('still fails at fire time when the target session dies after creation', async () => {
      const targetId = 'session-dies-later';
      sessionManager.addSession({ id: targetId, cliType: 'claude-code', workingDir: TEST_DIR });
      ptyManager.spawn({ sessionId: targetId });

      manager.createTask({
        title: 'Dies Later',
        planIds: [],
        initialPrompt: 'hello',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: TEST_DIR,
        mode: 'direct',
        targetSessionId: targetId,
      });
      sessionManager.removeSession(targetId);

      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const failed = manager.listTasks()[0];
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('not found');
    });

    it('should deliver prompt to existing session and complete', async () => {
      const targetId = 'session-direct-target';
      sessionManager.addSession({ id: targetId, cliType: 'claude-code', workingDir: 'X:\\\\coding\\\\test' });
      ptyManager.spawn({ sessionId: targetId });

      manager.createTask({
        title: 'Direct Hit',
        planIds: [],
        initialPrompt: 'do the thing',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
        mode: 'direct',
        targetSessionId: targetId,
      });

      manager.start();
      await vi.runOnlyPendingTimersAsync();

      const completed = manager.listTasks()[0];
      expect(completed.status).toBe('completed');
      expect(ptyManager.getWrites(targetId)).toEqual(
        expect.arrayContaining([expect.stringContaining('do the thing')]),
      );
    });

    it('preserves scheduled prompt spaces and uses the target CLI submit suffix', async () => {
      const targetId = 'session-direct-spaces';
      sessionManager.addSession({ id: targetId, cliType: 'claude-code', workingDir: 'X:\\\\coding\\\\test' });
      ptyManager.spawn({ sessionId: targetId });
      configLoader.submitSuffixByCli.set('claude-code', '\\n');

      manager.createTask({
        title: 'Space Prompt',
        planIds: [],
        initialPrompt: '  keep spaces  ',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
        mode: 'direct',
        targetSessionId: targetId,
      });

      manager.start();
      await vi.runOnlyPendingTimersAsync();

      expect(ptyManager.getWrites(targetId)).toEqual(['  keep spaces  ', '\n']);
    });

    it('parses scheduler sequence tokens before applying the target CLI submit suffix', async () => {
      const targetId = 'session-direct-sequence';
      sessionManager.addSession({ id: targetId, cliType: 'claude-code', workingDir: 'X:\\\\coding\\\\test' });
      ptyManager.spawn({ sessionId: targetId });
      configLoader.submitSuffixByCli.set('claude-code', '\\r\\n');

      manager.createTask({
        title: 'Sequence Prompt',
        planIds: [],
        initialPrompt: 'hello{Enter}there{Space}',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
        mode: 'direct',
        targetSessionId: targetId,
      });

      manager.start();
      await vi.runOnlyPendingTimersAsync();

      expect(ptyManager.getWrites(targetId)).toEqual(['hello', '\r\n', 'there', ' ']);
    });
  });

  describe('history recording', () => {
    let history: FakeHistoryManager;
    let historyManager: ScheduledTaskManager;

    beforeEach(() => {
      history = new FakeHistoryManager();
      historyManager = new ScheduledTaskManager(
        sessionManager as any,
        ptyManager as any,
        planManager as any,
        configLoader as any,
        history as any,
      );
    });

    afterEach(() => {
      historyManager.stop();
      saveScheduledTasks([]);
    });

    it('appends one done entry (with setup fields, no stdout) when a spawn task completes', async () => {
      historyManager.createTask({
        title: 'Spawn Run',
        planIds: ['plan-a'],
        initialPrompt: 'do the thing',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: 'X:\\\\coding\\\\test',
      });
      historyManager.start();
      await vi.runOnlyPendingTimersAsync();

      const running = historyManager.listTasks()[0];
      ptyManager.emitExit(running.sessionId!);

      expect(history.entries).toHaveLength(1);
      const entry = history.entries[0];
      expect(entry.outcome).toBe('done');
      expect(entry.title).toBe('Spawn Run');
      expect(entry.initialPrompt).toBe('do the thing');
      expect(entry.cliType).toBe('claude-code');
      expect(entry.dirPath).toBe(TEST_DIR_NORMALIZED);
      expect(entry.planIds).toEqual(['plan-a']);
      expect(entry.ranAt).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty('stdout');
    });

    it('appends a failed entry when a direct task target disappears before firing', async () => {
      const targetId = 'session-history-gone';
      sessionManager.addSession({ id: targetId, cliType: 'claude-code', workingDir: TEST_DIR });

      historyManager.createTask({
        title: 'Orphan Direct',
        planIds: [],
        initialPrompt: 'hello',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        dirPath: TEST_DIR,
        mode: 'direct',
        targetSessionId: targetId,
      });
      sessionManager.removeSession(targetId);
      historyManager.start();
      await vi.runOnlyPendingTimersAsync();

      expect(history.entries).toHaveLength(1);
      expect(history.entries[0].outcome).toBe('failed');
      expect(history.entries[0].error).toContain('not found');
    });

    it('appends one entry per fire for a recurring interval task', async () => {
      historyManager.createTask({
        title: 'Recurring',
        planIds: [],
        initialPrompt: 'Test',
        cliType: 'claude-code',
        scheduledTime: new Date(Date.now() - 1000),
        scheduleKind: 'interval',
        intervalMs: 60000,
        dirPath: 'X:\\\\coding\\\\test',
      });
      historyManager.start();

      // First fire
      await vi.runOnlyPendingTimersAsync();
      let running = historyManager.listTasks()[0];
      ptyManager.emitExit(running.sessionId!);
      expect(history.entries).toHaveLength(1);

      // Advance past the interval to trigger the second fire
      vi.advanceTimersByTime(61_000);
      await vi.runOnlyPendingTimersAsync();
      running = historyManager.listTasks()[0];
      ptyManager.emitExit(running.sessionId!);

      expect(history.entries).toHaveLength(2);
      expect(history.entries.every(e => e.outcome === 'done')).toBe(true);
    });
  });
});
