<script setup lang="ts">
import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, draftsClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from '../../ipc/clients.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ScheduledTask } from '../../../src/types/scheduled-task.js';
import { normalizeDirPath } from '../../utils.js';

interface ProjectSummary {
  id: string;
  name: string;
  canonicalPath: string;
  alternatePaths?: string[];
}

const emit = defineEmits<{
  open: [taskId: string | null];
  delete: [task: ScheduledTask];
  history: [];
}>();

const tasks = ref<ScheduledTask[]>([]);
const projects = ref<ProjectSummary[]>([]);
const cliTypes = ref<Array<{ id: string; label: string }>>([]);
const dreamingCollapsed = ref(false);
const schedulesCollapsed = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let offChanged: (() => void) | null = null;
let offProjectChanged: (() => void) | null = null;

const activeTasks = computed(() => tasks.value
  .filter((task) => task.status === 'pending' || task.status === 'executing')
  .sort((a, b) => nextRunMs(a) - nextRunMs(b)));
const dreamTasks = computed(() => activeTasks.value
  .filter((task) => task.systemKind === 'dream')
  .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b))));
const scheduleTasks = computed(() => activeTasks.value.filter((task) => !task.systemKind).slice(0, 4));
const projectById = computed(() => new Map(projects.value.map((project) => [project.id, project])));

function projectFor(task: ScheduledTask): ProjectSummary | undefined {
  if (task.projectId) {
    const byId = projectById.value.get(task.projectId);
    if (byId) return byId;
  }
  return projects.value.find((project) =>
    normalizeDirPath(project.canonicalPath) === normalizeDirPath(task.dirPath)
    || (project.alternatePaths ?? []).some((path) => normalizeDirPath(path) === normalizeDirPath(task.dirPath)),
  );
}

function projectLabel(task: ScheduledTask): string {
  return projectFor(task)?.name || task.dirPath;
}

function projectPath(task: ScheduledTask): string {
  return projectFor(task)?.canonicalPath || task.dirPath;
}

async function loadTasks(): Promise<void> {
  try {
    tasks.value = await schedulerClient.scheduledTaskList() ?? [];
  } catch {
    tasks.value = [];
  }
}

function nextRunMs(task: ScheduledTask): number {
  return new Date(task.nextRunAt ?? task.scheduledTime).getTime();
}

async function loadProjects(): Promise<void> {
  try {
    projects.value = await projectsClient.projectList() ?? [];
  } catch {
    projects.value = [];
  }
}

async function updateDream(task: ScheduledTask, patch: { enabled?: boolean; cliType?: string; userPrompt?: string; scheduledTime?: Date; scheduleKind?: 'cron'; cronExpression?: string }): Promise<void> {
  try {
    await schedulerClient.scheduledTaskUpdate(task.id, patch);
  } catch {
    // The next load restores the persisted value if the backend rejects it.
  } finally {
    await loadTasks();
  }
}

function onDreamEnabledChange(task: ScheduledTask, event: Event): void {
  void updateDream(task, { enabled: (event.target as HTMLInputElement).checked });
}

function onDreamCliChange(task: ScheduledTask, event: Event): void {
  void updateDream(task, { cliType: (event.target as HTMLSelectElement).value });
}

function onDreamPromptChange(task: ScheduledTask, event: Event): void {
  void updateDream(task, { userPrompt: (event.target as HTMLInputElement).value });
}

/**
 * Run a dream immediately as an extra occurrence. The backend leaves nextRunAt
 * alone, so this is never a way to postpone the scheduled run.
 */
async function runDreamNow(task: ScheduledTask): Promise<void> {
  try {
    await schedulerClient.scheduledTaskRunNow?.(task.id);
  } catch {
    // Nothing to roll back — the next load reflects whatever actually happened.
  } finally {
    await loadTasks();
  }
}

function dreamTime(task: ScheduledTask): string {
  const nextRun = new Date(task.nextRunAt ?? task.scheduledTime);
  return `${String(nextRun.getHours()).padStart(2, '0')}:${String(nextRun.getMinutes()).padStart(2, '0')}`;
}

function nextDateAtTime(value: string): Date | null {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next;
}

function onDreamTimeChange(task: ScheduledTask, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  const next = nextDateAtTime(value);
  if (!next) return;
  void updateDream(task, {
    scheduledTime: next,
    scheduleKind: 'cron',
    cronExpression: `${next.getMinutes()} ${next.getHours()} * * *`,
  });
}

async function loadCliTypes(): Promise<void> {
  const toolsLoader = toolsClient.toolsGetAll;
  if (typeof toolsLoader === 'function') {
    try {
      const tools = await toolsLoader() as { cliTypes?: Record<string, { displayName?: string; name?: string } | null> };
      const options = Object.entries(tools?.cliTypes ?? {}).map(([id, config]) => ({
        id,
        label: config?.displayName || config?.name || id,
      }));
      if (options.length > 0) {
        cliTypes.value = options;
        return;
      }
    } catch {
      // Fall through to the small legacy API below.
    }
  }

  const idsLoader = configClient.configGetCliTypes;
  if (typeof idsLoader !== 'function') return;
  try {
    const ids = (await idsLoader() as string[]) ?? [];
    cliTypes.value = ids.map((id) => ({ id, label: id }));
  } catch {
    cliTypes.value = [];
  }
}

function timeRemaining(task: ScheduledTask): string {
  if (task.status === 'executing') return 'running';
  const diff = nextRunMs(task) - Date.now();
  if (diff <= 0) return 'due';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return '<1m';
}

onMounted(() => {
  void loadTasks();
  void loadProjects();
  void loadCliTypes();
  refreshTimer = setInterval(() => { void loadTasks(); void loadProjects(); }, 15000);
  offChanged = eventsClient.onScheduledTaskChanged?.(() => {
    void loadTasks();
  }) ?? null;
  offProjectChanged = eventsClient.onProjectChanged?.(() => {
    void loadProjects();
    void loadTasks();
  }) ?? null;
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  offChanged?.();
  offProjectChanged?.();
});
</script>

<template>
  <div class="scheduler-section">
    <div class="scheduler-create-split">
      <button class="scheduler-create scheduler-create--main focusable" data-focus-id="scheduler:new" @click.stop="emit('open', null)">
        <span>New Schedule</span>
        <span class="scheduler-count-badge" aria-label="Total schedules">{{ tasks.filter((task) => !task.systemKind).length }}</span>
      </button>
      <button class="scheduler-create scheduler-create--hist focusable" data-focus-id="scheduler:history" type="button" title="Past Schedules" aria-label="Past Schedules" @click.stop="emit('history')">🕘</button>
    </div>
    <section class="scheduler-group">
      <button class="scheduler-group-heading focusable" data-focus-id="scheduler:dreaming" type="button" :aria-expanded="!dreamingCollapsed" @click="dreamingCollapsed = !dreamingCollapsed">
        <span class="scheduler-group-chevron">{{ dreamingCollapsed ? '›' : '⌄' }}</span>
        <span>Dreaming</span>
        <span class="scheduler-group-count">{{ dreamTasks.length }} project{{ dreamTasks.length === 1 ? '' : 's' }}</span>
      </button>
      <div v-if="!dreamingCollapsed" class="scheduler-group-body">
        <div v-if="dreamTasks.length === 0" class="scheduler-empty">No projects available for dreaming</div>
        <div
          v-for="task in dreamTasks"
          :key="task.id"
          class="scheduler-row scheduler-row--dream"
          :class="{ 'scheduler-row--running': task.status === 'executing' }"
        >
          <div class="scheduler-system-heading">
            <span class="scheduler-title">{{ task.title }}</span>
            <span class="scheduler-time">{{ task.enabled ? timeRemaining(task) : 'off' }}</span>
            <button
              class="scheduler-action focusable"
              :data-focus-id="`scheduler:dream-run:${task.id}`"
              type="button"
              title="Run dream now"
              aria-label="Run dream now"
              :disabled="!task.cliType || task.status === 'executing'"
              @click.stop="runDreamNow(task)"
            >▶</button>
          </div>
          <div class="scheduler-project-name">{{ projectLabel(task) }}</div>
          <div class="scheduler-project-path" :title="projectPath(task)">{{ projectPath(task) }}</div>
          <div class="scheduler-dream-controls">
            <label class="scheduler-dream-field">
              <span>CLI</span>
              <select class="scheduler-system-cli focusable" :data-focus-id="`scheduler:dream-cli:${task.id}`" :value="task.cliType" aria-label="Dream CLI type" @change="onDreamCliChange(task, $event)">
                <option value="">Select CLI...</option>
                <option v-for="cliType in cliTypes" :key="cliType.id" :value="cliType.id">{{ cliType.label }}</option>
              </select>
            </label>
            <label class="scheduler-dream-field">
              <span>Daily at</span>
              <input class="scheduler-system-time focusable" :data-focus-id="`scheduler:dream-time:${task.id}`" type="time" :value="dreamTime(task)" aria-label="Dream daily time" @change="onDreamTimeChange(task, $event)" />
            </label>
          </div>
          <label class="scheduler-system-toggle">
            <input class="focusable" :data-focus-id="`scheduler:dream-enabled:${task.id}`" type="checkbox" :checked="task.enabled === true" :disabled="!task.cliType" title="Choose a CLI before enabling" @change="onDreamEnabledChange(task, $event)" />
            <span>{{ task.enabled ? 'Enabled' : 'Disabled' }}</span>
          </label>
          <input class="scheduler-system-prompt focusable" :data-focus-id="`scheduler:dream-prompt:${task.id}`" :value="task.userPrompt ?? ''" type="text" placeholder="Prompt additions (optional)" aria-label="Dream prompt additions" @change="onDreamPromptChange(task, $event)" />
        </div>
      </div>
    </section>

    <section class="scheduler-group">
      <button class="scheduler-group-heading focusable" data-focus-id="scheduler:schedules" type="button" :aria-expanded="!schedulesCollapsed" @click="schedulesCollapsed = !schedulesCollapsed">
        <span class="scheduler-group-chevron">{{ schedulesCollapsed ? '›' : '⌄' }}</span>
        <span>Schedules</span>
        <span class="scheduler-group-count">{{ scheduleTasks.length }}</span>
      </button>
      <div v-if="!schedulesCollapsed" class="scheduler-group-body">
        <div v-if="scheduleTasks.length === 0" class="scheduler-empty"><strong>No schedules yet</strong><span>Create a schedule to run a prompt at a time or recurrence.</span></div>
        <div
          v-for="task in scheduleTasks"
          :key="task.id"
          class="scheduler-row"
          :class="{ 'scheduler-row--running': task.status === 'executing' }"
        >
          <span class="scheduler-title">{{ task.title }}</span>
          <span class="scheduler-time">{{ timeRemaining(task) }}</span>
          <!-- Only action buttons are focusable; the row body is inert. -->
          <div class="scheduler-actions">
            <button class="scheduler-action focusable" :data-focus-id="`scheduler:edit:${task.id}`" type="button" title="Edit schedule" aria-label="Edit schedule" @click.stop="emit('open', task.id)">i</button>
            <button class="scheduler-action scheduler-action--danger focusable" :data-focus-id="`scheduler:delete:${task.id}`" type="button" title="Delete schedule" aria-label="Delete schedule" @click.stop="emit('delete', task)">x</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.scheduler-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 8px 8px;
}
.scheduler-group {
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.scheduler-group-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 5px 7px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
  text-align: left;
}
.scheduler-group-heading:hover {
  background: var(--bg-secondary);
}
.scheduler-group-chevron {
  width: 12px;
  color: var(--accent);
  font-size: 0.95rem;
  line-height: 1;
}
.scheduler-group-count {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 400;
}
.scheduler-group-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
}
.scheduler-row {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.82rem;
}
.scheduler-create-split {
  display: flex;
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.scheduler-create {
  border: none;
  background: var(--bg-secondary);
  color: var(--accent);
  cursor: pointer;
  font-size: 0.82rem;
}
.scheduler-create--main {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  padding: 0 8px;
}
.scheduler-count-badge {
  min-width: 1.35em;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg-primary);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  text-align: center;
}
.scheduler-create--hist {
  width: 32px;
  flex: 0 0 32px;
  border-left: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.95rem;
}
.scheduler-create--main:hover {
  background: var(--bg-tertiary);
}
.scheduler-create--hist:hover {
  color: var(--text-primary);
}
.scheduler-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  text-align: left;
  cursor: default;
}
.scheduler-row--dream {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 8px;
  padding: 7px;
  background: color-mix(in srgb, var(--bg-secondary) 88%, var(--accent));
}
.scheduler-row:hover {
  border-color: var(--border);
}
.scheduler-row--running {
  border-color: #ff9f1a;
}
.scheduler-system-heading {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
}
.scheduler-system-heading .scheduler-action {
  margin-left: auto;
}
.scheduler-action:disabled {
  border-color: var(--border);
  color: var(--text-secondary);
  cursor: default;
  opacity: 0.45;
}
.scheduler-project-name {
  overflow: hidden;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scheduler-project-path {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scheduler-dream-controls {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(92px, 0.55fr);
  gap: 6px;
}
.scheduler-dream-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.scheduler-dream-field > span {
  color: var(--text-secondary);
  font-size: 0.68rem;
  text-transform: uppercase;
}
.scheduler-system-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-size: 0.75rem;
  white-space: nowrap;
}
.scheduler-system-cli,
.scheduler-system-time,
.scheduler-system-prompt {
  min-width: 0;
  height: 30px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.75rem;
}
.scheduler-system-time {
  color-scheme: dark;
}
.scheduler-system-prompt {
  grid-column: 1 / -1;
  width: 100%;
  padding: 0 5px;
}
.scheduler-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scheduler-time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.scheduler-actions {
  display: flex;
  gap: 4px;
}
.scheduler-action {
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.75rem;
  line-height: 1;
}
.scheduler-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text-primary);
}
.scheduler-action--danger:hover:not(:disabled) {
  border-color: #ff4444;
  color: #ff6666;
}
.scheduler-empty {
  padding: 8px;
  color: var(--text-secondary);
  font-size: 0.8rem;
  text-align: center;
}
.scheduler-empty strong,
.scheduler-empty span {
  display: block;
}
.scheduler-empty strong {
  margin-bottom: 2px;
  color: var(--text-primary);
}
</style>
