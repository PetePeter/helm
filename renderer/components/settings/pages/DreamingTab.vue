<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { configClient, eventsClient, projectsClient, schedulerClient, toolsClient } from '../../../ipc/clients.js';
import type { ProjectRecord } from '../../../../src/types/project.js';
import type { ScheduledTask, UpdateScheduledTaskParams } from '../../../../src/types/scheduled-task.js';
import { DEFAULT_DREAM_PROMPT, type DreamingConfigResult } from '../../../../src/types/dreaming.js';
import { normalizeDirPath } from '../../../utils.js';

const tasks = ref<ScheduledTask[]>([]);
const projects = ref<ProjectRecord[]>([]);
const cliTypes = ref<Array<{ id: string; label: string }>>([]);
const prompt = ref(DEFAULT_DREAM_PROMPT);
const globalCliType = ref('');
const globalTime = ref('09:00');
const promptStatus = ref('');
const applyStatus = ref('');
const error = ref('');
const savingPrompt = ref(false);
const applying = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let offTasksChanged: (() => void) | null = null;
let offProjectsChanged: (() => void) | null = null;
let globalDefaultsInitialized = false;

const promptEdited = computed(() => prompt.value !== DEFAULT_DREAM_PROMPT);
const dreamTasks = computed(() => tasks.value
  .filter((task) => task.systemKind === 'dream')
  .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b))));
const projectById = computed(() => new Map(projects.value.map((project) => [project.id, project])));
const canApplyToAll = computed(() => dreamTasks.value.length > 0 && Boolean(globalCliType.value) && Boolean(dailySchedule(globalTime.value)));

function projectFor(task: ScheduledTask): ProjectRecord | undefined {
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

function dreamTime(task: ScheduledTask): string {
  const nextRun = new Date(task.nextRunAt ?? task.scheduledTime);
  return `${String(nextRun.getHours()).padStart(2, '0')}:${String(nextRun.getMinutes()).padStart(2, '0')}`;
}

function nextDateAtTime(value: string): Date | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next;
}

function dailySchedule(value: string): Pick<UpdateScheduledTaskParams, 'scheduledTime' | 'scheduleKind' | 'cronExpression'> | null {
  const next = nextDateAtTime(value);
  if (!next) return null;
  return {
    scheduledTime: next,
    scheduleKind: 'cron',
    cronExpression: `${next.getMinutes()} ${next.getHours()} * * *`,
  };
}

async function loadPrompt(): Promise<void> {
  try {
    const result = await configClient.configGetDreaming();
    if (result.success) prompt.value = result.settings.prompt;
    else error.value = result.error;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

async function savePrompt(value = prompt.value): Promise<void> {
  savingPrompt.value = true;
  promptStatus.value = 'Saving…';
  error.value = '';
  try {
    const result: DreamingConfigResult = await configClient.configSetDreaming({ prompt: value });
    if (!result.success) {
      error.value = result.error;
      promptStatus.value = '';
      return;
    }
    prompt.value = result.settings.prompt;
    promptStatus.value = 'Saved.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    promptStatus.value = '';
  } finally {
    savingPrompt.value = false;
  }
}

function resetPrompt(): void {
  prompt.value = DEFAULT_DREAM_PROMPT;
  void savePrompt('');
}

function initializeGlobalDefaults(): void {
  if (globalDefaultsInitialized || dreamTasks.value.length === 0) return;
  globalDefaultsInitialized = true;
  const first = dreamTasks.value[0];
  if (!first) return;
  const cli = first.cliType;
  globalCliType.value = dreamTasks.value.every((task) => task.cliType === cli) ? cli : '';
  globalTime.value = dreamTime(first);
}

async function loadTasks(): Promise<void> {
  try {
    tasks.value = await schedulerClient.scheduledTaskList() ?? [];
    initializeGlobalDefaults();
  } catch (reason) {
    tasks.value = [];
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

async function loadProjects(): Promise<void> {
  try {
    projects.value = await projectsClient.projectList() ?? [];
  } catch {
    projects.value = [];
  }
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
      // Fall through to the legacy ids API.
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

async function updateDream(task: ScheduledTask, patch: UpdateScheduledTaskParams, refresh = true): Promise<boolean> {
  let updated = false;
  try {
    updated = (await schedulerClient.scheduledTaskUpdate(task.id, patch)) !== null;
  } catch {
    // A failed update leaves the server's value in place; refresh below restores it.
  } finally {
    if (refresh) await loadTasks();
  }
  return updated;
}

function onEnabledChange(task: ScheduledTask, event: Event): void {
  if (!task.cliType) return;
  void updateDream(task, { enabled: (event.target as HTMLInputElement).checked });
}

function onCliChange(task: ScheduledTask, event: Event): void {
  void updateDream(task, { cliType: (event.target as HTMLSelectElement).value });
}

function onAddendumChange(task: ScheduledTask, event: Event): void {
  void updateDream(task, { userPrompt: (event.target as HTMLTextAreaElement).value });
}

function onTimeChange(task: ScheduledTask, event: Event): void {
  const schedule = dailySchedule((event.target as HTMLInputElement).value);
  if (schedule) void updateDream(task, schedule);
}

async function applyToAll(): Promise<void> {
  const schedule = dailySchedule(globalTime.value);
  if (!globalCliType.value || !schedule || dreamTasks.value.length === 0) return;
  applying.value = true;
  applyStatus.value = '';
  const patch: UpdateScheduledTaskParams = { cliType: globalCliType.value, ...schedule };
  try {
    const results = await Promise.all(dreamTasks.value.map((task) => updateDream(task, patch, false)));
    await loadTasks();
    applyStatus.value = results.every(Boolean) ? 'Applied to all projects.' : 'Some project rows could not be updated.';
  } finally {
    applying.value = false;
  }
}

async function runDreamNow(task: ScheduledTask): Promise<void> {
  try {
    await schedulerClient.scheduledTaskRunNow?.(task.id);
  } catch {
    // The following load reflects the server's actual state.
  } finally {
    await loadTasks();
  }
}

onMounted(() => {
  void Promise.all([loadPrompt(), loadTasks(), loadProjects(), loadCliTypes()]);
  refreshTimer = setInterval(() => { void loadTasks(); void loadProjects(); }, 15000);
  offTasksChanged = eventsClient.onScheduledTaskChanged?.(() => { void loadTasks(); }) ?? null;
  offProjectsChanged = eventsClient.onProjectChanged?.(() => { void loadProjects(); void loadTasks(); }) ?? null;
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  offTasksChanged?.();
  offProjectsChanged?.();
});
</script>

<template>
  <div class="dreaming-tab settings-sections">
    <section class="dreaming-card settings-span">
      <header class="dreaming-card__header">
        <div>
          <h3>Global dreaming</h3>
          <p>The prompt applies to every project's daily memory dream. Project addenda are appended to this prompt.</p>
        </div>
      </header>

      <label class="dreaming-prompt">
        <span>Dream prompt</span>
        <textarea
          class="dreaming-prompt__text focusable"
          rows="10"
          spellcheck="false"
          aria-label="Global dreaming prompt"
          :value="prompt"
          :disabled="savingPrompt"
          @change="savePrompt(($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <div class="dreaming-card__actions">
        <button type="button" class="btn btn--secondary btn--sm focusable" :disabled="!promptEdited || savingPrompt" @click="resetPrompt">Reset to default</button>
        <span class="dreaming-status" role="status">{{ promptStatus }}</span>
      </div>

      <div class="dreaming-apply-all">
        <label>
          <span>CLI for all projects</span>
          <select v-model="globalCliType" class="btn btn--secondary btn--sm focusable" aria-label="Apply CLI to all projects">
            <option value="">Select CLI...</option>
            <option v-for="cliType in cliTypes" :key="cliType.id" :value="cliType.id">{{ cliType.label }}</option>
          </select>
        </label>
        <label>
          <span>Daily at</span>
          <input v-model="globalTime" class="focusable" type="time" aria-label="Apply daily time to all projects" />
        </label>
        <button type="button" class="btn btn--secondary btn--sm focusable" :disabled="!canApplyToAll || applying" @click="applyToAll">
          {{ applying ? 'Applying…' : 'Apply to all projects' }}
        </button>
        <span class="dreaming-status" role="status">{{ applyStatus }}</span>
      </div>
    </section>

    <section class="dreaming-projects settings-span">
      <header class="dreaming-projects__header">
        <div>
          <h3>Projects</h3>
          <p>Choose the CLI and daily schedule for each project's dream.</p>
        </div>
      </header>
      <p v-if="dreamTasks.length === 0" class="dreaming-empty">No projects are available for dreaming.</p>
      <div v-else class="dreaming-table-wrap">
        <table class="dreaming-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">CLI</th>
              <th scope="col">Daily at</th>
              <th scope="col">Enabled</th>
              <th scope="col">Prompt additions</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in dreamTasks" :key="task.id" class="dreaming-project-row">
              <th scope="row" class="dreaming-project">
                <span>{{ projectLabel(task) }}</span>
                <small :title="projectPath(task)">{{ projectPath(task) }}</small>
              </th>
              <td>
                <select
                  class="btn btn--secondary btn--sm focusable"
                  :data-focus-id="`dreaming:cli:${task.id}`"
                  :value="task.cliType"
                  :aria-label="`Select CLI for ${projectLabel(task)}`"
                  @change="onCliChange(task, $event)"
                >
                  <option value="">Select CLI...</option>
                  <option v-if="task.cliType && !cliTypes.some(({ id }) => id === task.cliType)" :value="task.cliType" disabled>Unavailable CLI</option>
                  <option v-for="cliType in cliTypes" :key="cliType.id" :value="cliType.id">{{ cliType.label }}</option>
                </select>
              </td>
              <td>
                <input
                  class="dreaming-time focusable"
                  :data-focus-id="`dreaming:time:${task.id}`"
                  type="time"
                  :value="dreamTime(task)"
                  :aria-label="`Set daily time for ${projectLabel(task)}`"
                  @change="onTimeChange(task, $event)"
                />
              </td>
              <td>
                <label class="dreaming-enabled">
                  <input
                    class="focusable"
                    :data-focus-id="`dreaming:enabled:${task.id}`"
                    type="checkbox"
                    :checked="task.enabled === true"
                    :disabled="!task.cliType"
                    :aria-label="`Enable dreaming for ${projectLabel(task)}`"
                    @change="onEnabledChange(task, $event)"
                  />
                </label>
              </td>
              <td>
                <textarea
                  class="dreaming-addendum focusable"
                  :data-focus-id="`dreaming:addendum:${task.id}`"
                  rows="2"
                  :value="task.userPrompt ?? ''"
                  :aria-label="`Prompt additions for ${projectLabel(task)}`"
                  placeholder="Optional project-specific additions"
                  @change="onAddendumChange(task, $event)"
                />
              </td>
              <td>
                <button
                  type="button"
                  class="btn btn--secondary btn--sm focusable"
                  :data-focus-id="`dreaming:run:${task.id}`"
                  :aria-label="`Run dream now for ${projectLabel(task)}`"
                  :disabled="!task.cliType || task.status === 'executing'"
                  @click="runDreamNow(task)"
                >Run now</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p v-if="error" class="dreaming-error settings-span" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.dreaming-tab {
  align-content: start;
  overflow: auto;
}

.dreaming-card,
.dreaming-projects {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
}

.dreaming-card__header,
.dreaming-projects__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-md);
}

.dreaming-card__header h3,
.dreaming-projects__header h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-md);
}

.dreaming-card__header p,
.dreaming-projects__header p {
  margin: var(--spacing-xs) 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.dreaming-prompt {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.dreaming-prompt__text,
.dreaming-addendum {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--spacing-sm);
  font: var(--font-size-sm) var(--font-mono);
}

.dreaming-prompt__text {
  min-height: 10rem;
}

.dreaming-card__actions,
.dreaming-apply-all {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.dreaming-apply-all {
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border);
}

.dreaming-apply-all label {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 10rem;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.dreaming-apply-all input[type='time'],
.dreaming-time {
  min-height: 2rem;
  padding: 0 var(--spacing-sm);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
}

.dreaming-status,
.dreaming-empty {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.dreaming-table-wrap {
  overflow-x: auto;
}

.dreaming-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.dreaming-table th,
.dreaming-table td {
  padding: var(--spacing-sm);
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: middle;
}

.dreaming-table thead th {
  color: var(--text-secondary);
  font-weight: 600;
}

.dreaming-project {
  min-width: 10rem;
  font-weight: 500;
}

.dreaming-project small {
  display: block;
  max-width: 14rem;
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--font-size-xs);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dreaming-addendum {
  min-width: 14rem;
}

.dreaming-enabled {
  display: flex;
  justify-content: center;
}

.dreaming-error {
  color: var(--danger);
  font-size: var(--font-size-sm);
}
</style>
