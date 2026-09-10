/**
 * Dream scheduled-task behaviour.
 *
 * Covers the three ways a dream used to go wrong: edits deferring the run,
 * a failure drifting the run off its configured hour, and the prompt never
 * reaching the spawned session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Scheduled-task persistence resolves to one process-wide config path — the
 * real user config dir. Keep the store in memory so these tests neither read
 * nor race whatever the running app has scheduled.
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

/**
 * Record the params the manager hands to the shared spawn helper while still
 * running the real helper — the point of these tests is which delivery
 * mechanism is used, not whether spawning works.
 */
const spawnCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/session/configured-session-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.spawnConfiguredSession as (params: unknown) => unknown;
  return {
    ...actual,
    spawnConfiguredSession: (params: Record<string, unknown>) => {
      spawnCalls.push(params);
      return real(params);
    },
  };
});

import {
  ScheduledTaskManager,
  DREAM_BASE_PROMPT,
  DREAM_SKILL_CUE,
  DREAM_MESS_CUE,
} from '../src/session/scheduled-task-manager.js';
import { saveScheduledTasks } from '../src/session/persistence.js';
import type { ScheduledTask } from '../src/types/scheduled-task.js';
import type { ProjectRecord } from '../src/types/project.js';

const TEST_DIR = 'X:\\coding\\dream-test';

class FakeSessionManager {
  private sessions = new Map<string, Record<string, unknown> & { id: string; cliType: string }>();
  private activeSessionId: string | null = null;
  hasSession(id: string) { return this.sessions.has(id); }
  updateSession(id: string, patch: Record<string, unknown>) { Object.assign(this.sessions.get(id)!, patch); }
  getSession(id: string) { return this.sessions.get(id); }
  getActiveSession() { return this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null; }
  addSession(session: Record<string, unknown> & { id: string; cliType: string }) {
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
  private active = new Set<string>();
  spawn(options: { sessionId: string }): { pid: number } {
    this.active.add(options.sessionId);
    return { pid: 1234 };
  }
  has(sessionId: string): boolean { return this.active.has(sessionId); }
  async deliverText(sessionId: string, text: string, options?: { submitSuffix?: string }): Promise<void> {
    if (!this.writes.has(sessionId)) this.writes.set(sessionId, []);
    this.writes.get(sessionId)!.push(text + (options?.submitSuffix ?? ''));
  }
  write(sessionId: string, data: string): void {
    if (!this.writes.has(sessionId)) this.writes.set(sessionId, []);
    this.writes.get(sessionId)!.push(data);
  }
  async nudgeResize(): Promise<void> {}
  getWrites(sessionId: string): string[] { return this.writes.get(sessionId) ?? []; }
  kill = vi.fn();
}

class FakePlanManager {
  getItem() { return undefined; }
}

class FakeConfigLoader {
  unknownCliTypes = new Set<string>();
  getCliTypeEntry(cliType: string) {
    return {
      env: [],
      cliType,
      displayName: cliType,
      spawnCommand: `echo ${cliType}`,
      resumeCommand: '',
      continueCommand: '',
      command: '{rawCommand}',
      submitSuffix: undefined,
      initialPrompt: [],
      initialPromptDelay: 10,
    };
  }
  resolveCliType(ref: string) {
    if (!ref || this.unknownCliTypes.has(ref)) return null;
    return { id: ref, config: this.getCliTypeEntry(ref) };
  }
  getMcpConfig() { return { authToken: 'test-token', port: 47373, enabled: true }; }
  reloadActiveProfileIfChanged() {}
}

const project: ProjectRecord = {
  id: 'project-dream',
  name: 'dream-test',
  canonicalPath: TEST_DIR,
  createdAt: 1,
  updatedAt: 1,
};

describe('dream scheduled task', () => {
  let manager: ScheduledTaskManager;
  let sessionManager: FakeSessionManager;
  let ptyManager: FakePtyManager;
  let configLoader: FakeConfigLoader;

  /** Seed the single dream row for the project and arm it with a CLI. */
  function seedEnabledDream(): ScheduledTask {
    manager.reconcileProjects([project]);
    const dream = manager.listTasks()[0];
    manager.updateTask(dream.id, { cliType: 'claude', enabled: true });
    return manager.getTask(dream.id)!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Midday, so a dream configured for 09:00 is always "tomorrow" and an
    // hour-preserving reschedule is distinguishable from now + 24h.
    vi.setSystemTime(new Date(2026, 4, 4, 12, 0, 0));
    spawnCalls.length = 0;
    sessionManager = new FakeSessionManager();
    ptyManager = new FakePtyManager();
    configLoader = new FakeConfigLoader();
    manager = new ScheduledTaskManager(
      sessionManager as never,
      ptyManager as never,
      new FakePlanManager() as never,
      configLoader as never,
    );
  });

  afterEach(() => {
    manager.stop();
    saveScheduledTasks([]);
    vi.useRealTimers();
  });

  describe('edits must not defer the run', () => {
    it('keeps nextRunAt when only the user prompt changes', () => {
      const dream = seedEnabledDream();
      const before = dream.nextRunAt!.getTime();

      manager.updateTask(dream.id, { userPrompt: 'one' });
      manager.updateTask(dream.id, { userPrompt: 'two' });
      manager.updateTask(dream.id, { userPrompt: 'three' });

      expect(manager.getTask(dream.id)!.nextRunAt!.getTime()).toBe(before);
    });

    it('keeps nextRunAt when only enabled or cliType changes', () => {
      const dream = seedEnabledDream();
      const before = dream.nextRunAt!.getTime();

      manager.updateTask(dream.id, { enabled: false });
      manager.updateTask(dream.id, { cliType: 'codex' });
      manager.updateTask(dream.id, { enabled: true });

      expect(manager.getTask(dream.id)!.nextRunAt!.getTime()).toBe(before);
    });

    it('recomputes nextRunAt when the schedule itself changes', () => {
      const dream = seedEnabledDream();
      expect(dream.nextRunAt!.getHours()).toBe(9);

      const next = new Date(2026, 4, 4, 22, 30, 0);
      manager.updateTask(dream.id, {
        scheduledTime: next,
        scheduleKind: 'cron',
        cronExpression: '30 22 * * *',
      });

      const updated = manager.getTask(dream.id)!;
      expect(updated.nextRunAt!.getHours()).toBe(22);
      expect(updated.nextRunAt!.getMinutes()).toBe(30);
    });
  });

  describe('runTaskNow()', () => {
    it('fires immediately and leaves the scheduled run in place', async () => {
      const dream = seedEnabledDream();
      const before = dream.nextRunAt!.getTime();

      expect(await manager.runTaskNow(dream.id)).toBe(true);
      await vi.runOnlyPendingTimersAsync();

      const fired = manager.getTask(dream.id)!;
      expect(fired.status).toBe('executing');
      expect(fired.sessionId).toBeTruthy();
      expect(fired.nextRunAt!.getTime()).toBe(before);
    });

    it('returns false for an unknown task', async () => {
      expect(await manager.runTaskNow('no-such-task')).toBe(false);
    });
  });

  describe('failure recovery', () => {
    it('reschedules at the configured hour rather than now + 24h', async () => {
      const dream = seedEnabledDream();
      expect(dream.nextRunAt).toEqual(new Date(2026, 4, 5, 9, 0, 0));

      // The CLI type disappears between arming and firing — the realistic way
      // a dream fails at 9am.
      configLoader.unknownCliTypes.add('claude');
      await vi.advanceTimersByTimeAsync(22 * 60 * 60 * 1000);

      const recovered = manager.getTask(dream.id)!;
      expect(recovered.status).toBe('pending');
      expect(recovered.nextRunAt!.getHours()).toBe(9);
      expect(recovered.nextRunAt!.getMinutes()).toBe(0);
    });

    it('reschedules a healed failed row at the configured hour', () => {
      const dream = seedEnabledDream();
      const task = manager.getTask(dream.id)!;
      task.status = 'failed';
      task.nextRunAt = new Date(2026, 4, 1, 9, 0, 0); // stale, in the past

      manager.reconcileProjects([project]);

      const healed = manager.getTask(dream.id)!;
      expect(healed.status).toBe('pending');
      expect(healed.nextRunAt!.getHours()).toBe(9);
    });
  });

  describe('prompt delivery', () => {
    it('delivers the dream prompt through the initial-prompt path, not a completion callback', async () => {
      const dream = seedEnabledDream();
      await manager.runTaskNow(dream.id);
      await vi.runOnlyPendingTimersAsync();

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].onPromptComplete).toBeUndefined();
      expect(spawnCalls[0].contextText).toContain(DREAM_BASE_PROMPT);

      const sessionId = manager.getTask(dream.id)!.sessionId!;
      expect(ptyManager.getWrites(sessionId).join('')).toContain(DREAM_BASE_PROMPT);
    });

    it('orders the prompt as base, skill cue, user addendum, mess cue', () => {
      const dream = seedEnabledDream();
      manager.updateTask(dream.id, { userPrompt: 'Prioritise architecture notes.' });

      const prompt = (manager as unknown as { buildTaskPrompt(task: ScheduledTask): string })
        .buildTaskPrompt(manager.getTask(dream.id)!);

      const positions = [
        prompt.indexOf(DREAM_BASE_PROMPT),
        prompt.indexOf(DREAM_SKILL_CUE),
        prompt.indexOf('Prioritise architecture notes.'),
        prompt.indexOf(DREAM_MESS_CUE),
      ];
      expect(positions.every((index) => index >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(DREAM_SKILL_CUE).toContain('skill_get(type:"dreaming")');
      expect(DREAM_MESS_CUE).toContain('mess_check');
    });

    it('omits the user additions section when the addendum is empty', () => {
      const dream = seedEnabledDream();
      manager.updateTask(dream.id, { userPrompt: '   ' });

      const prompt = (manager as unknown as { buildTaskPrompt(task: ScheduledTask): string })
        .buildTaskPrompt(manager.getTask(dream.id)!);

      expect(prompt).not.toContain('User additions');
      expect(prompt).toContain(DREAM_MESS_CUE);
    });
  });
});
