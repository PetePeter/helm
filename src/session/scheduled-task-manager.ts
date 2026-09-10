/**
 * ScheduledTaskManager — Task scheduling system for CLI sessions with plan references.
 *
 * Manages scheduled tasks that spawn CLI sessions at specific times with
 * initial prompts and plan references. Supports persistence, timer management,
 * and execution tracking.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { saveScheduledTasks, loadScheduledTasks } from './persistence.js';
import type { ScheduledTask, ScheduledTaskMode, ScheduledTaskStatus, ScheduledTaskHistoryEntry, CreateScheduledTaskParams, UpdateScheduledTaskParams } from '../types/scheduled-task.js';
import type { ScheduledTaskHistoryManager } from './scheduled-task-history-manager.js';
import type { SessionManager } from './manager.js';
import type { PtyManager } from './pty-manager.js';
import type { PlanManager } from './plan-manager.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ProjectRecord } from '../types/project.js';
import type { ProjectStore } from './project-store.js';
import { CronEngine } from '../utils/cron-engine.js';
import { spawnConfiguredSession } from './configured-session-spawn.js';
import { normalizeProjectPath } from './project-identity.js';
import { deliverPromptSequenceToSession } from './sequence-delivery.js';

const PENDING_STATUSES = new Set<ScheduledTaskStatus>(['pending', 'executing']);
const MIN_INTERVAL_MS = 60_000;
/**
 * Node stores a timer delay in a signed 32-bit int; anything larger silently
 * becomes 1ms and the timer fires immediately. Long schedules must therefore
 * sleep in bounded hops and re-check the due date on each wake.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DREAM_DEFAULT_HOUR = 9;
const DREAM_DEFAULT_MINUTE = 0;
/**
 * The delivered dream prompt is assembled from these four parts, in order:
 * base → skill cue → user addendum (when non-empty) → mess cue. Detailed
 * pruning and consolidation guidance lives in the `dreaming` system skill, so
 * the prompt itself stays short and the guidance stays amendable in one place.
 */
export const DREAM_BASE_PROMPT = 'Time to dream: review and maintain this project\'s durable memories.';
export const DREAM_SKILL_CUE = 'Call skill_get(type:"dreaming") first and follow it — it carries the pruning and consolidation procedure.';
export const DREAM_MESS_CUE = 'When you are done, call mess_check to pick up anything other sessions left for this project.';

export class ScheduledTaskManager extends EventEmitter {
  private tasks = new Map<string, ScheduledTask>();
  private timers = new Map<string, NodeJS.Timeout>();
  private promptCancellers = new Map<string, () => void>();
  private started = false;

  constructor(
    private sessionManager: SessionManager,
    private ptyManager: PtyManager,
    private planManager: PlanManager,
    private configLoader: ConfigLoader,
    private historyManager?: ScheduledTaskHistoryManager,
    private readonly projectStore?: ProjectStore,
  ) {
    super();
    this.projectStore?.onChanged((projects) => {
      // ProjectStore can resolve an implicit project during application
      // construction. Do not reconcile until persisted tasks have been loaded.
      if (this.started) this.reconcileProjects(projects);
    });
  }

  /**
   * Snapshot the task's setup fields at fire time and append a history entry.
   *
   * Builds an explicit object (not a live task reference) because recurring
   * tasks are reset to pending by completeOrReschedule before history records.
   */
  private recordHistory(task: ScheduledTask, outcome: ScheduledTaskHistoryEntry['outcome'], error?: string): void {
    if (!this.historyManager) return;
    this.historyManager.append({
      taskId: task.id,
      title: task.title,
      ...(task.description !== undefined ? { description: task.description } : {}),
      initialPrompt: task.initialPrompt,
      cliType: task.cliType,
      ...(task.cliParams !== undefined ? { cliParams: task.cliParams } : {}),
      dirPath: task.dirPath,
      ...(task.mode !== undefined ? { mode: task.mode } : {}),
      ...(task.targetSessionId !== undefined ? { targetSessionId: task.targetSessionId } : {}),
      ...(task.scheduleKind !== undefined ? { scheduleKind: task.scheduleKind } : {}),
      ...(task.intervalMs !== undefined ? { intervalMs: task.intervalMs } : {}),
      ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
      ...(task.endDate !== undefined ? { endDate: task.endDate } : {}),
      planIds: [...task.planIds],
      ranAt: Date.now(),
      outcome,
      ...(error !== undefined ? { error } : {}),
      ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
    });
  }

  /**
   * Resolve and validate the CLI type a task will run under, at create/update
   * time rather than at fire time — a schedule that cannot possibly run should
   * fail the person setting it up, not silently fail at 3am.
   *
   * Spawn tasks store the canonical uuid. Direct tasks inherit their target
   * session's type, so the caller need not supply one at all.
   */
  private resolveTaskCliType(
    mode: ScheduledTaskMode | undefined,
    cliType: string | undefined,
    targetSessionId: string | undefined,
  ): string {
    if (mode === 'direct') {
      if (!targetSessionId?.trim()) {
        throw new Error('Direct-mode scheduled tasks require a targetSessionId');
      }
      const session = this.sessionManager.getSession(targetSessionId);
      if (!session) {
        throw new Error(`Target session not found: ${targetSessionId}`);
      }
      return session.cliType ?? '';
    }

    const ref = cliType?.trim();
    if (!ref) throw new Error('Spawn-mode scheduled tasks require a cliType');
    // resolveCliType throws on an ambiguous display name — let that surface.
    const resolved = this.configLoader.resolveCliType(ref);
    if (!resolved) throw new Error(`Unknown CLI type: ${ref}`);
    return resolved.id;
  }

  /**
   * Best-effort canonicalisation for tasks loaded from disk. A legacy entry that
   * no longer resolves (deleted or ambiguous CLI type) is left untouched so a
   * single bad task cannot break startup; it fails loudly when it next fires.
   */
  private canonicalCliTypeOrKeep(cliType: string): string {
    try {
      return this.configLoader.resolveCliType(cliType)?.id ?? cliType;
    } catch {
      return cliType;
    }
  }

  /** Create a new scheduled task. */
  createTask(params: CreateScheduledTaskParams): ScheduledTask {
    const now = Date.now();
    const cliType = this.resolveTaskCliType(params.mode, params.cliType, params.targetSessionId);
    const scheduleKind = params.scheduleKind ?? 'once';
    const nextRunAt = this.computeInitialNextRunAt(scheduleKind, params.scheduledTime, params.cronExpression, params.endDate);
    const task: ScheduledTask = {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      planIds: params.planIds,
      initialPrompt: params.initialPrompt,
      cliType,
      cliParams: params.cliParams,
      scheduledTime: params.scheduledTime,
      scheduleKind,
      ...(params.intervalMs !== undefined ? { intervalMs: params.intervalMs } : {}),
      ...(params.cronExpression !== undefined ? { cronExpression: params.cronExpression } : {}),
      ...(params.endDate !== undefined ? { endDate: params.endDate } : {}),
      nextRunAt,
      // Stored normalized so it compares equal to a session's workingDir, which
      // SessionManager also stores normalized.
      dirPath: normalizeProjectPath(params.dirPath),
      mode: params.mode,
      targetSessionId: params.targetSessionId,
      status: 'pending',
      createdAt: now,
    };

    this.tasks.set(task.id, task);
    this.saveTasks();
    this.scheduleTask(task);
    this.emit('task:changed', task);
    logger.info(`[ScheduledTaskManager] Created task "${task.title}" (${task.id}) for ${task.scheduledTime.toISOString()}`);
    return task;
  }

  /**
   * Reconcile Helm-owned system rows with the current project registry. The
   * project id is persisted on the task so alternate paths and renames cannot
   * create duplicates or orphan a row.
   */
  reconcileProjects(projects?: readonly ProjectRecord[]): void {
    // An optional project list is commonly forwarded from callers. Undefined
    // is not an authoritative empty registry; start() passes the loaded store
    // snapshot explicitly, and lifecycle events pass their concrete snapshot.
    if (projects === undefined) return;
    const currentProjects = projects;
    const projectsById = new Map(currentProjects.map((project) => [project.id, project]));
    const projectsByPath = new Map<string, ProjectRecord>();
    for (const project of currentProjects) {
      projectsByPath.set(normalizeProjectPath(project.canonicalPath), project);
      for (const path of project.alternatePaths ?? []) projectsByPath.set(normalizeProjectPath(path), project);
    }
    const primaryByProject = new Map<string, ScheduledTask>();
    let changed = false;

    for (const task of [...this.tasks.values()]) {
      if (task.systemKind !== 'dream') continue;
      const project = (task.projectId ? projectsById.get(task.projectId) : undefined)
        ?? projectsByPath.get(normalizeProjectPath(task.dirPath));
      const primary = project ? primaryByProject.get(project.id) : undefined;
      if (!project || primary) {
        if (primary && task.enabled === true && primary.enabled !== true) {
          primary.enabled = true;
          primary.cliType = task.cliType;
          primary.userPrompt = task.userPrompt ?? '';
          primary.nextRunAt = task.nextRunAt;
          this.scheduleTask(primary);
          this.emit('task:changed', primary);
        }
        this.clearTimer(task.id);
        this.tasks.delete(task.id);
        this.emit('task:deleted', task.id);
        changed = true;
        continue;
      }
      primaryByProject.set(project.id, task);
      const taskChanged = task.projectId !== project.id
        || task.dirPath !== project.canonicalPath
        || task.enabled === undefined
        || task.userPrompt === undefined
        || task.status === 'failed'
        || task.scheduleKind !== 'cron'
        || !task.cronExpression;
      if (taskChanged) {
        task.projectId = project.id;
        task.dirPath = project.canonicalPath;
        task.enabled ??= false;
        task.userPrompt ??= '';
        if (task.scheduleKind !== 'cron' || !task.cronExpression) {
          const anchor = task.nextRunAt ?? task.scheduledTime;
          task.scheduleKind = 'cron';
          task.cronExpression = dailyCronFor(anchor);
          task.nextRunAt = anchor.getTime() > Date.now()
            ? anchor
            : nextDailyTime(anchor.getHours(), anchor.getMinutes());
          task.scheduledTime = task.nextRunAt;
        }
        if (task.status === 'failed') {
          task.status = 'pending';
          delete task.completedAt;
          // Healing must not cost the row its configured hour — a dream that
          // failed at 09:00 belongs at 09:00 tomorrow, not at whatever o'clock
          // the app happened to start.
          task.nextRunAt = this.nextDreamRun(task);
        }
        changed = true;
        this.emit('task:changed', task);
      }
      if (task.enabled === false) this.clearTimer(task.id);
      else if (taskChanged) this.scheduleTask(task);
    }

    for (const project of currentProjects) {
      if (primaryByProject.has(project.id)) continue;
      const firstRun = nextDailyTime(DREAM_DEFAULT_HOUR, DREAM_DEFAULT_MINUTE);
      const task: ScheduledTask = {
        id: randomUUID(),
        title: 'Memory Dreaming',
        description: 'Review and maintain this project\'s durable memories.',
        planIds: [],
        initialPrompt: DREAM_BASE_PROMPT,
        cliType: '',
        scheduledTime: firstRun,
        scheduleKind: 'cron',
        cronExpression: dailyCronFor(firstRun),
        nextRunAt: firstRun,
        dirPath: project.canonicalPath,
        projectId: project.id,
        systemKind: 'dream',
        enabled: false,
        userPrompt: '',
        status: 'pending',
        createdAt: Date.now(),
      };
      this.tasks.set(task.id, task);
      this.emit('task:changed', task);
      changed = true;
    }
    if (changed) this.saveTasks();
  }

  /** Get all tasks. */
  listTasks(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  /** Get a task by ID. */
  getTask(id: string): ScheduledTask | null {
    return this.tasks.get(id) ?? null;
  }

  /** Update a pending scheduled task and reschedule its timer. */
  updateTask(id: string, updates: UpdateScheduledTaskParams): ScheduledTask | null {
    const task = this.tasks.get(id);
    const isDream = task?.systemKind === 'dream';
    if (!task || (task.status !== 'pending' && !(isDream && task.status === 'failed'))) return null;
    if (isDream && updates.initialPrompt !== undefined) {
      throw new Error('System dream tasks use userPrompt; initialPrompt is Helm-owned');
    }

    // Validate against the post-merge shape before mutating, so a rejected
    // update leaves the task exactly as it was.
    const mode = updates.mode ?? task.mode;
    const targetSessionId = Object.prototype.hasOwnProperty.call(updates, 'targetSessionId')
      ? updates.targetSessionId
      : task.targetSessionId;
    const nextEnabled = updates.enabled ?? task.enabled ?? true;
    const requestedCliType = updates.cliType ?? task.cliType;
    const cliType = isDream && !nextEnabled
      ? requestedCliType
      : this.resolveTaskCliType(mode, requestedCliType, targetSessionId);

    if (isDream && task.status === 'failed') {
      task.status = 'pending';
      delete task.completedAt;
    }
    if (updates.title !== undefined) task.title = updates.title;
    if (Object.prototype.hasOwnProperty.call(updates, 'description')) task.description = updates.description;
    if (updates.planIds !== undefined) task.planIds = updates.planIds;
    if (updates.initialPrompt !== undefined) task.initialPrompt = updates.initialPrompt;
    task.cliType = cliType;
    if (Object.prototype.hasOwnProperty.call(updates, 'cliParams')) task.cliParams = updates.cliParams;
    if (updates.scheduledTime !== undefined) task.scheduledTime = updates.scheduledTime;
    if (updates.scheduleKind !== undefined) task.scheduleKind = updates.scheduleKind;
    if (Object.prototype.hasOwnProperty.call(updates, 'intervalMs')) task.intervalMs = updates.intervalMs;
    if (Object.prototype.hasOwnProperty.call(updates, 'cronExpression')) task.cronExpression = updates.cronExpression;
    if (Object.prototype.hasOwnProperty.call(updates, 'endDate')) task.endDate = updates.endDate;
    if (updates.dirPath !== undefined) task.dirPath = normalizeProjectPath(updates.dirPath);
    if (updates.mode !== undefined) task.mode = updates.mode;
    if (Object.prototype.hasOwnProperty.call(updates, 'targetSessionId')) task.targetSessionId = updates.targetSessionId;
    if (updates.enabled !== undefined) task.enabled = updates.enabled;
    if (Object.prototype.hasOwnProperty.call(updates, 'userPrompt')) task.userPrompt = updates.userPrompt;
    // Only a change to the schedule may move the next run. Recomputing on every
    // patch pushed a daily task out another whole day per edit — three prompt
    // tweaks used to mean three days of silence.
    const scheduleChanged = updates.scheduledTime !== undefined
      || updates.scheduleKind !== undefined
      || Object.prototype.hasOwnProperty.call(updates, 'cronExpression')
      || Object.prototype.hasOwnProperty.call(updates, 'endDate');
    if (scheduleChanged || !task.nextRunAt) {
      task.nextRunAt = this.computeInitialNextRunAt(task.scheduleKind ?? 'once', task.scheduledTime, task.cronExpression, task.endDate);
    }

    this.saveTasks();
    if (task.enabled === false) this.clearTimer(task.id);
    else this.scheduleTask(task);
    this.emit('task:changed', task);
    logger.info(`[ScheduledTaskManager] Updated task "${task.title}" (${id})`);
    return task;
  }

  /**
   * Fire a pending task right now as an extra, manual occurrence.
   *
   * The schedule is deliberately untouched: nextRunAt is restored after the
   * run starts, so "run now" never doubles as "postpone". A disabled dream can
   * still be run on demand — the toggle governs the timer, not the button.
   */
  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') return false;

    const nextRunAt = task.nextRunAt;
    const scheduledTime = task.scheduledTime;
    logger.info(`[ScheduledTaskManager] Manual run of task "${task.title}" (${id})`);
    await this.executeTask(task, { force: true });

    // A one-shot task that ran to completion has legitimately finished; only
    // restore the schedule of a task that is still on the books.
    if (task.status === 'pending' || task.status === 'executing') {
      task.nextRunAt = nextRunAt;
      task.scheduledTime = scheduledTime;
      this.saveTasks();
      this.scheduleTask(task);
    }
    return true;
  }

  /** Cancel a pending task. Returns false if task already executing. */
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.systemKind) return this.updateTask(id, { enabled: false }) !== null;
    if (task.status !== 'pending') return false;

    this.clearTimer(id);
    task.status = 'cancelled';
    task.completedAt = Date.now();

    this.saveTasks();
    this.emit('task:changed', task);
    logger.info(`[ScheduledTaskManager] Cancelled task "${task.title}" (${id})`);
    return true;
  }

  /** Delete a task and cancel any pending timer. Returns false if already executing. */
  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.systemKind) return false;
    if (task.status === 'executing') return false;

    this.clearTimer(id);
    this.tasks.delete(id);
    this.saveTasks();
    this.emit('task:deleted', id);
    logger.info(`[ScheduledTaskManager] Deleted task "${task.title}" (${id})`);
    return true;
  }

  /** Start the manager: load pending tasks and restore timers. */
  start(): void {
    const loaded = loadScheduledTasks();
    this.tasks.clear();

    for (const task of loaded) {
      // Only restore tasks that were still pending
      if (PENDING_STATUSES.has(task.status) || (task.systemKind === 'dream' && task.status === 'failed')) {
        task.scheduleKind ??= 'once';
        // Tasks written before dirPath normalization / the cliType UUID
        // migration are healed here, once, instead of every comparison site.
        if (task.dirPath) task.dirPath = normalizeProjectPath(task.dirPath);
        if (task.mode !== 'direct' && task.cliType) {
          task.cliType = this.canonicalCliTypeOrKeep(task.cliType);
        }
        task.nextRunAt ??= this.computeInitialNextRunAt(task.scheduleKind, task.scheduledTime, task.cronExpression, task.endDate);
        this.tasks.set(task.id, task);
      }
    }

    logger.info(`[ScheduledTaskManager] Loaded ${this.tasks.size} task(s) from disk`);

    this.started = true;
    this.reconcileProjects(this.projectStore?.list());

    // Reset any crashed executing tasks back to pending for retry
    for (const task of this.tasks.values()) {
      if (task.status === 'executing') {
        task.status = 'pending';
        logger.info(`[ScheduledTaskManager] Reset crashed task "${task.title}" (${task.id}) from executing to pending`);
      }
    }

    // Schedule all pending tasks
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.enabled !== false) {
        if (this.getNextRunTime(task).getTime() <= now) {
          // Past scheduled time - execute immediately
          void this.executeTask(task);
        } else {
          this.scheduleTask(task);
        }
      }
    }
  }

  /** Stop the manager: cancel all timers and save state. */
  stop(): void {
    this.started = false;
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }
    this.saveTasks();
    logger.info('[ScheduledTaskManager] Stopped');
  }

  /**
   * Schedule a task by setting a timeout, capped at the maximum delay Node can
   * hold. A task further out than the cap wakes early, finds itself not yet due
   * and re-arms, so it executes exactly once — at its real due time.
   */
  private scheduleTask(task: ScheduledTask): void {
    if (task.status !== 'pending' || task.enabled === false) return;

    this.clearTimer(task.id);

    const remaining = Math.max(0, this.getNextRunTime(task).getTime() - Date.now());
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      if (Date.now() >= this.getNextRunTime(task).getTime()) {
        void this.executeTask(task);
      } else {
        this.scheduleTask(task);
      }
    }, delay);

    this.timers.set(task.id, timer);
    logger.debug(
      `[ScheduledTaskManager] Scheduled task "${task.title}" (${task.id}) in ${delay}ms` +
      (delay < remaining ? ` (partial wake; ${remaining}ms until due)` : ''),
    );
  }

  /** Execute a scheduled task: spawn CLI or send to existing session, set working plan, deliver prompt. */
  private async executeTask(task: ScheduledTask, options?: { force?: boolean }): Promise<void> {
    this.clearTimer(task.id);

    if (task.status !== 'pending' || (task.enabled === false && !options?.force)) {
      logger.warn(`[ScheduledTaskManager] Skipping execution of task ${task.id} - status is ${task.status}`);
      return;
    }

    logger.info(`[ScheduledTaskManager] Executing task "${task.title}" (${task.id}) mode=${task.mode ?? 'spawn'}`);

    if (task.mode === 'direct') {
      await this.executeDirectTask(task);
    } else {
      await this.executeSpawnTask(task);
    }
  }

  /** Direct mode: send prompt to an existing session. */
  private async executeDirectTask(task: ScheduledTask): Promise<void> {
    try {
      // Validated at create time, but a task persisted before that existed —
      // or whose target has since closed — must still fail cleanly here.
      const targetId = task.targetSessionId;
      if (!targetId) {
        throw new Error('Target session ID is missing');
      }
      const session = this.sessionManager.getSession(targetId);
      if (!session) {
        throw new Error(`Target session ${targetId} not found`);
      }
      if (!this.ptyManager.has(targetId)) {
        throw new Error(`Target session ${targetId} PTY is not running`);
      }

      task.status = 'executing';
      task.sessionId = targetId;
      this.saveTasks();
      this.emit('task:changed', task);

      this.startWorkingPlan(task, targetId);

      const prompt = this.buildTaskPrompt(task);
      if (prompt.length > 0) {
        await this.deliverScheduledPrompt(targetId, prompt);
      }

      task.lastRunAt = Date.now();
      this.recordHistory(task, 'done');
      this.completeOrReschedule(task);
      this.saveTasks();
      this.emit('task:changed', task);
      logger.info(`[ScheduledTaskManager] Direct task "${task.title}" sent to session ${targetId}`);

    } catch (err) {
      logger.error(`[ScheduledTaskManager] Failed to execute direct task "${task.title}": ${err}`);
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
      this.recordHistory(task, 'failed', task.error);
      this.recoverDreamAfterFailure(task);
      this.saveTasks();
      this.emit('task:changed', task);
    }
  }

  /** Spawn mode: create a new PTY session and deliver prompt. */
  private async executeSpawnTask(task: ScheduledTask): Promise<void> {
    let exitListener: ((sessionId: string) => void) | null = null;
    const sessionId = randomUUID();
    try {
      const previousActiveSessionId = this.sessionManager.getActiveSession()?.id ?? null;

      this.configLoader.reloadActiveProfileIfChanged();
      // A task's stored cliType may predate the UUID migration, or be a display
      // name the user picked in the scheduler UI — resolve it through the one
      // choke point so a renamed CLI type still spawns the right thing.
      const cli = this.configLoader.resolveCliType(task.cliType);
      if (!cli) {
        throw new Error(`Unknown CLI type: ${task.cliType}`);
      }

      exitListener = (exitedSessionId: string) => {
        if (exitedSessionId !== sessionId) return;
        this.ptyManager.off('exit', exitListener!);
        this.finishScheduledRun(task, sessionId);
      };
      this.ptyManager.on('exit', exitListener);

      const prompt = this.buildTaskPrompt(task);
      // The scheduler spawns through the same path as every other session, so
      // per-CLI env, the spawn/resume command chain, submit suffixes and
      // activity-dot seeding all behave identically here.
      spawnConfiguredSession({
        ptyManager: this.ptyManager,
        sessionManager: this.sessionManager,
        configLoader: this.configLoader,
        sessionId,
        cliType: cli.id,
        sessionName: `[scheduled] ${task.title}`,
        cwd: task.dirPath,
        extraArgs: task.cliParams,
        // Delivered as contextText — the same mechanism a user-created session
        // uses for its initial prompt. Handing the prompt to the spawn helper
        // means the helper owns delivery, including its own fallback when a CLI
        // has no init sequence; the scheduler no longer depends on a completion
        // callback it cannot guarantee will fire.
        ...(prompt.length > 0 ? { contextText: prompt } : {}),
        // Scheduled runs are background work, exactly as direct mode is.
        contextDeliveryContext: 'background' as const,
        onPromptCancel: (cancel) => this.promptCancellers.set(sessionId, cancel),
        fallbackCompleteDelayMs: cli.config.initialPromptDelay ?? 2000,
      });

      if (previousActiveSessionId && this.sessionManager.getSession(previousActiveSessionId)) {
        this.sessionManager.setActiveSession(previousActiveSessionId);
      }
      task.status = 'executing';
      task.sessionId = sessionId;
      this.saveTasks();
      this.emit('task:changed', task);

      this.startWorkingPlan(task, sessionId);

      task.lastRunAt = Date.now();
      this.saveTasks();
      this.emit('task:changed', task);
      logger.info(`[ScheduledTaskManager] Task "${task.title}" running in background session ${sessionId}`);

    } catch (err) {
      if (exitListener) {
        this.ptyManager.off('exit', exitListener);
      }
      logger.error(`[ScheduledTaskManager] Failed to execute task "${task.title}" (${task.id}): ${err}`);
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();

      this.recordHistory(task, 'failed', task.error);
      this.recoverDreamAfterFailure(task);
      this.saveTasks();
      this.emit('task:changed', task);
    }
  }

  /** The task prompt, with plan references appended when the task carries any. */
  private buildTaskPrompt(task: ScheduledTask): string {
    const initialPrompt = task.systemKind === 'dream'
      ? buildDreamPrompt(task.userPrompt)
      : task.initialPrompt;
    if (task.planIds.length === 0) return initialPrompt;
    const planRefs = task.planIds.map(id => `- ${id}`).join('\n');
    return `${initialPrompt}\n\nPlan references:\n${planRefs}`;
  }

  private recoverDreamAfterFailure(task: ScheduledTask): void {
    if (task.systemKind !== 'dream') return;
    task.status = 'pending';
    delete task.completedAt;
    task.nextRunAt = this.nextDreamRun(task);
    if (task.enabled !== false) this.scheduleTask(task);
  }

  /**
   * The next occurrence of a dream's own daily time. A failed or healed row is
   * put back on its configured hour; adding a flat 24h to "now" instead would
   * walk the dream a little further off its hour after every hiccup.
   */
  private nextDreamRun(task: ScheduledTask): Date {
    if (task.scheduleKind === 'cron' && task.cronExpression?.trim()) {
      const next = CronEngine.nextRunTimeBeforeDate(task.cronExpression, new Date(), task.endDate);
      if (next) return next;
    }
    const anchor = task.nextRunAt ?? task.scheduledTime;
    return nextDailyTime(anchor.getHours(), anchor.getMinutes());
  }

  /** Move the task's first plan into 'coding' as the session's working plan. */
  private startWorkingPlan(task: ScheduledTask, sessionId: string): void {
    const firstPlanId = task.planIds[0];
    if (!firstPlanId || !this.planManager) return;
    if (!this.planManager.getItem(firstPlanId)) return;
    this.planManager.setState(firstPlanId, 'coding', '');
    logger.info(`[ScheduledTaskManager] Set working plan ${firstPlanId} for session ${sessionId}`);
  }

  /** Clear the timer for a task if it exists. */
  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /** Save all tasks to disk. */
  private saveTasks(): void {
    const tasksToSave = this.listTasks().filter(t => PENDING_STATUSES.has(t.status) || t.status === 'cancelled');
    saveScheduledTasks(tasksToSave);
  }

  private getNextRunTime(task: ScheduledTask): Date {
    return task.nextRunAt ?? task.scheduledTime;
  }

  private computeInitialNextRunAt(
    scheduleKind: ScheduledTask['scheduleKind'],
    scheduledTime: Date,
    cronExpression?: string,
    endDate?: Date,
  ): Date {
    if (scheduleKind !== 'cron') return scheduledTime;
    if (!cronExpression?.trim()) {
      throw new Error('Cron schedules require cronExpression');
    }
    const nextRunAt = CronEngine.nextRunTimeBeforeDate(cronExpression, scheduledTime, endDate);
    if (!nextRunAt) {
      throw new Error('Cron schedule has no next run before endDate');
    }
    return nextRunAt;
  }

  private completeOrReschedule(task: ScheduledTask): void {
    if (task.scheduleKind === 'interval') {
      const intervalMs = task.intervalMs ?? 0;
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        task.status = 'failed';
        task.error = 'Interval schedules must be at least 1 minute';
        task.completedAt = Date.now();
        return;
      }
      const nextRunAt = new Date(Date.now() + intervalMs);
      task.status = 'pending';
      task.scheduledTime = nextRunAt;
      task.nextRunAt = nextRunAt;
      task.sessionId = undefined;
      task.error = undefined;
      this.scheduleTask(task);
      return;
    }
    if (task.scheduleKind === 'cron') {
      if (!task.cronExpression?.trim()) {
        task.status = 'failed';
        task.error = 'Cron schedules require cronExpression';
        task.completedAt = Date.now();
        return;
      }
      const nextRunAt = CronEngine.nextRunTimeBeforeDate(task.cronExpression, new Date(), task.endDate);
      if (!nextRunAt) {
        task.status = 'completed';
        task.completedAt = Date.now();
        task.sessionId = undefined;
        return;
      }
      task.status = 'pending';
      task.scheduledTime = nextRunAt;
      task.nextRunAt = nextRunAt;
      task.sessionId = undefined;
      task.error = undefined;
      this.scheduleTask(task);
      return;
    }
    task.status = 'completed';
    task.completedAt = Date.now();
  }

  private finishScheduledRun(task: ScheduledTask, sessionId: string): void {
    const cancel = this.promptCancellers.get(sessionId);
    if (cancel) { cancel(); this.promptCancellers.delete(sessionId); }
    // Snapshot before completeOrReschedule resets a recurring task to pending
    // and before sessionId is cleared below.
    this.recordHistory(task, 'done');
    this.completeOrReschedule(task);
    if (task.sessionId === sessionId && task.status !== 'pending') {
      task.sessionId = undefined;
    }
    try {
      if (this.sessionManager.getSession(sessionId)) {
        this.sessionManager.removeSession(sessionId, { force: true });
      }
    } catch (error) {
      logger.warn(`[ScheduledTaskManager] Failed to remove scheduled session ${sessionId}: ${error}`);
    }
    this.saveTasks();
    this.emit('task:changed', task);
    logger.info(`[ScheduledTaskManager] Task "${task.title}" finished in background session ${sessionId}`);
  }

  private async deliverScheduledPrompt(sessionId: string, prompt: string): Promise<void> {
    await deliverPromptSequenceToSession({
      sessionId,
      text: prompt,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      deliveryContext: 'background',
    });
  }
}

/**
 * Assemble the delivered dream prompt. An empty addendum contributes nothing —
 * a dangling "User additions:" heading reads as a truncated instruction.
 */
export function buildDreamPrompt(userPrompt?: string): string {
  const addendum = userPrompt?.trim();
  const sections = [DREAM_BASE_PROMPT, DREAM_SKILL_CUE];
  if (addendum) sections.push(`User additions:\n${addendum}`);
  sections.push(DREAM_MESS_CUE);
  return sections.join('\n\n');
}

function dailyCronFor(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} * * *`;
}

function nextDailyTime(hour: number, minute: number, now = new Date()): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}
