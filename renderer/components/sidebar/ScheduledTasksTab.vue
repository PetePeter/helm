<script setup lang="ts">
import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, draftsClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient } from '../../ipc/clients.js';
/**
 * ScheduledTasksTab.vue -- UI for creating and managing scheduled tasks.
 */
import { ref, computed, onMounted, onUnmounted, watch, ref as templateRef } from 'vue';
import type { ScheduledTask, ScheduledTaskHistoryEntry, ScheduledTaskMode, ScheduledTaskScheduleSelection } from '../../../src/types/scheduled-task.js';
import { CronEngine } from '../../../src/utils/cron-engine.js';
import QuickSpawnModal from '../modals/QuickSpawnModal.vue';
import DirPickerModal from '../modals/DirPickerModal.vue';
import PromptTextarea from '../common/PromptTextarea.vue';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { loadStoredSessions } from '../../session-store.js';
import { getCliDisplayName, normalizeDirPath } from '../../utils.js';

const emit = defineEmits<{
  'task-created': [task: ScheduledTask];
  'task-updated': [task: ScheduledTask];
  'task-cancelled': [taskId: string];
  'close': [];
}>();

const props = withDefaults(defineProps<{
  initialEditTaskId?: string | null;
  initialCreate?: boolean;
  initialPrefill?: Partial<ScheduledTaskHistoryEntry> | null;
  popup?: boolean;
}>(), { initialEditTaskId: null, initialCreate: false, initialPrefill: null, popup: false });

const tasks = ref<ScheduledTask[]>([]);
const creating = ref(false);
const formError = ref('');
const showCreateForm = ref(false);
const editingTaskId = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const formTitle = ref('');
const formDescription = ref('');
const formInitialPrompt = ref('');
const formMode = ref<ScheduledTaskMode>('spawn');
const selectedCliType = ref('');
const selectedDirPath = ref('');
const formCliParams = ref('');
const selectedTargetSessionId = ref('');
const formTime = ref('');
const scheduleKind = ref<ScheduledTaskScheduleSelection>('once');
const intervalMinutes = ref(60);
const cronExpression = ref('0 9 * * 1-5');
const endDate = ref('');

const cronPresets = [
  { label: 'Weekdays 9am', expression: '0 9 * * 1-5' },
  { label: 'Daily 9am', expression: '0 9 * * *' },
  { label: 'Weekly Monday', expression: '0 9 * * 1' },
  { label: 'Monthly 1st', expression: '0 0 1 * *' },
] as const;

const cliPickerVisible = ref(false);
const dirPickerVisible = ref(false);
const availableCliTypes = ref<string[]>([]);
const availableDirs = ref<{ name: string; path: string }[]>([]);
const availableSessions = ref<Array<{ id: string; name: string; cliType: string; workingDir?: string }>>([]);

const popupRoot = templateRef<HTMLElement | null>('popupRoot');
const { onKeydown: trapOnKeydown } = useFocusTrap('.scheduled-tasks-tab--popup');
const modalStack = useModalStack();

const sessionsForDir = computed(() => {
  if (formMode.value !== 'direct' || !selectedDirPath.value) return [];
  const wantedDir = normalizeDirPath(selectedDirPath.value);
  const inDirectory = availableSessions.value.filter(s => normalizeDirPath(s.workingDir ?? '') === wantedDir);
  // A stored direct target is authoritative. Keep it visible in the editor even
  // if its directory metadata later differs, so the schedule info/edit popup
  // always shows the session this task will actually target.
  const selected = availableSessions.value.find(s => s.id === selectedTargetSessionId.value);
  return selected && !inDirectory.some(s => s.id === selected.id) ? [selected, ...inDirectory] : inDirectory;
});

const canCreate = computed(() => {
  const unscheduledEdit = Boolean(editingTaskId.value) && scheduleKind.value === 'none';
  const hasValidSchedule = unscheduledEdit || ((scheduleKind.value !== 'interval' || intervalMinutes.value >= 1)
    && (scheduleKind.value !== 'cron' || cronValidation.value.valid));
  const hasBasics = formTitle.value.trim() !== '' && formInitialPrompt.value.length > 0
    && (unscheduledEdit || formTime.value !== '') && selectedDirPath.value.trim() !== '' && hasValidSchedule;
  if (formMode.value === 'direct') return hasBasics && selectedTargetSessionId.value !== '';
  return hasBasics && selectedCliType.value.trim() !== '';
});

const sortedTasks = computed(() => [...tasks.value].sort((a, b) => {
  if ((a.scheduleKind === 'none') !== (b.scheduleKind === 'none')) return a.scheduleKind === 'none' ? 1 : -1;
  return new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime();
}));
const formVisible = computed(() => props.popup || showCreateForm.value);
const cronValidation = computed(() => {
  if (scheduleKind.value !== 'cron') return { valid: true };
  const validation = CronEngine.validate(cronExpression.value);
  if (!validation.valid || !formTime.value) return validation;
  try {
    const next = CronEngine.nextRunTimeBeforeDate(cronExpression.value, new Date(formTime.value), parseEndDate());
    if (!next) return { valid: false, error: 'No run before end date' };
    return { valid: true, nextRunAt: next };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return '.../' + parts.slice(-2).join('/');
}

function formatCountdown(scheduledTime: Date | string): string {
  const target = new Date(scheduledTime).getTime();
  const diff = target - Date.now();
  if (diff <= 0) return 'overdue';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function getStatusBadge(task: ScheduledTask): { label: string; cssClass: string } {
  if (task.status === 'pending' && task.scheduleKind === 'none') {
    return { label: 'Unscheduled', cssClass: 'badge--pending' };
  }
  switch (task.status) {
    case 'pending': return { label: 'Pending', cssClass: 'badge--pending' };
    case 'executing': return { label: 'Running', cssClass: 'badge--executing' };
    case 'completed': return { label: 'Done', cssClass: 'badge--completed' };
    case 'cancelled': return { label: 'Cancelled', cssClass: 'badge--cancelled' };
    case 'failed': return { label: 'Failed', cssClass: 'badge--failed' };
    default: return { label: status, cssClass: '' };
  }
}

function formatTime(date: Date | string): string { return (typeof date === 'string' ? new Date(date) : date).toLocaleString(); }
function formatNextRun(task: ScheduledTask): string { return formatCountdown(task.nextRunAt ?? task.scheduledTime); }
function formatSchedule(task: ScheduledTask): string {
  if (task.scheduleKind === 'none') return 'None';
  if (task.scheduleKind === 'interval' && task.intervalMs) return `Every ${Math.round(task.intervalMs / 60000)} min`;
  if (task.scheduleKind === 'cron' && task.cronExpression) return task.cronExpression;
  return 'Once';
}
function toLocalDateTimeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function toLocalDateInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}
function parseEndDate(): Date | undefined {
  if (!endDate.value) return undefined;
  return new Date(`${endDate.value}T23:59:59.999`);
}

async function loadTasks(): Promise<void> {
  try { tasks.value = await schedulerClient.scheduledTaskList() || []; } catch {}
}

function toggleCreateForm(): void {
  showCreateForm.value = !showCreateForm.value;
  if (showCreateForm.value) startCreateForm();
  else resetForm();
}

function startCreateForm(): void {
  resetForm();
  const nextHour = new Date();
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  formTime.value = toLocalDateTimeInputValue(nextHour);
}

function resetForm(): void {
  editingTaskId.value = null;
  formTitle.value = '';
  formDescription.value = '';
  formInitialPrompt.value = '';
  formMode.value = 'spawn';
  selectedCliType.value = '';
  selectedDirPath.value = '';
  formCliParams.value = '';
  selectedTargetSessionId.value = '';
  formTime.value = '';
  scheduleKind.value = 'once';
  intervalMinutes.value = 60;
  cronExpression.value = '0 9 * * 1-5';
  endDate.value = '';
}

function onScheduleKindChange(): void {
  if (scheduleKind.value !== 'none') return;
  formTime.value = '';
  intervalMinutes.value = 60;
  cronExpression.value = '0 9 * * 1-5';
  endDate.value = '';
  formError.value = '';
}

async function openCliPicker(): Promise<void> {
  try { availableCliTypes.value = await configClient.configGetCliTypes() as string[]; cliPickerVisible.value = true; } catch {}
}
function onCliSelected(cliType: string): void { selectedCliType.value = cliType; cliPickerVisible.value = false; }
function onModeChange(): void { selectedTargetSessionId.value = ''; if (formMode.value === 'direct') loadSessions(); }
async function openDirPickerModal(): Promise<void> {
  try {
    const dirs = await configClient.configGetWorkingDirs() as Array<{ path: string; name?: string }>;
    availableDirs.value = dirs.map((d) => ({ name: d.name ?? d.path, path: d.path }));
    dirPickerVisible.value = true;
  } catch {}
}
function onDirSelected(path: string): void { selectedDirPath.value = path; selectedTargetSessionId.value = ''; dirPickerVisible.value = false; if (formMode.value === 'direct') loadSessions(); }
async function loadSessions(): Promise<void> {
  try { availableSessions.value = await loadStoredSessions() as Array<{ id: string; name: string; cliType: string; workingDir?: string }>; }
  catch { availableSessions.value = []; }
}
async function createTask(): Promise<void> {
  if (!canCreate.value) return;
  formError.value = '';
  const currentTask = tasks.value.find((task) => task.id === editingTaskId.value);
  if (currentTask?.scheduleKind === 'none' && scheduleKind.value !== 'none') {
    const scheduledTime = new Date(formTime.value);
    if (!Number.isFinite(scheduledTime.getTime()) || scheduledTime.getTime() <= Date.now()) {
      formError.value = 'Choose a future time to resume this schedule.';
      return;
    }
  }
  creating.value = true;
  try {
    const common = {
      title: formTitle.value.trim(),
      description: formDescription.value.trim() || undefined,
      planIds: [],
      initialPrompt: formInitialPrompt.value,
      cliType: formMode.value === 'direct' ? (availableSessions.value.find(s => s.id === selectedTargetSessionId.value)?.cliType ?? selectedCliType.value) : selectedCliType.value,
      cliParams: formCliParams.value.trim() || undefined,
      dirPath: selectedDirPath.value.trim(),
      mode: formMode.value,
      targetSessionId: formMode.value === 'direct' ? selectedTargetSessionId.value : undefined,
    };
    let result;
    if (scheduleKind.value === 'none') {
      if (!editingTaskId.value) return;
      result = await schedulerClient.scheduledTaskUpdate(editingTaskId.value, { ...common, scheduleKind: 'none' });
    } else {
      const schedule = {
        scheduledTime: new Date(formTime.value),
        scheduleKind: scheduleKind.value,
        intervalMs: scheduleKind.value === 'interval' ? intervalMinutes.value * 60_000 : undefined,
        cronExpression: scheduleKind.value === 'cron' ? cronExpression.value.trim() : undefined,
        endDate: scheduleKind.value === 'cron' ? parseEndDate() : undefined,
      };
      result = editingTaskId.value
        ? await schedulerClient.scheduledTaskUpdate(editingTaskId.value, { ...common, ...schedule })
        : await schedulerClient.scheduledTaskCreate({ ...common, ...schedule });
    }
    if (result) {
      emit(editingTaskId.value ? 'task-updated' : 'task-created', result);
      if (props.popup) emit('close');
      else { showCreateForm.value = false; resetForm(); await loadTasks(); }
    } else {
      formError.value = 'The schedule could not be saved. Check the schedule and try again.';
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : 'The schedule could not be saved.';
  } finally { creating.value = false; }
}

function editTask(task: ScheduledTask): void {
  editingTaskId.value = task.id;
  formTitle.value = task.title;
  formDescription.value = task.description ?? '';
  formInitialPrompt.value = task.initialPrompt;
  formMode.value = task.mode ?? 'spawn';
  selectedCliType.value = task.cliType;
  selectedDirPath.value = task.dirPath;
  formCliParams.value = task.cliParams ?? '';
  selectedTargetSessionId.value = task.targetSessionId ?? '';
  scheduleKind.value = task.scheduleKind ?? 'once';
  formTime.value = scheduleKind.value === 'none' ? '' : toLocalDateTimeInputValue(new Date(task.scheduledTime));
  intervalMinutes.value = Math.max(1, Math.round((task.intervalMs ?? 3600000) / 60000));
  cronExpression.value = task.cronExpression ?? '0 9 * * 1-5';
  endDate.value = task.endDate && scheduleKind.value === 'cron' ? toLocalDateInputValue(new Date(task.endDate)) : '';
  showCreateForm.value = true;
  if (formMode.value === 'direct') loadSessions();
}

/**
 * Prefill the create form from a history snapshot. Unlike editTask(), this
 * leaves editingTaskId null so saving creates a brand-new task, and resets the
 * scheduled time to now + 1 hour so the user always picks a fresh time.
 */
function prefillFromSnapshot(entry: Partial<ScheduledTaskHistoryEntry>): void {
  editingTaskId.value = null;
  formTitle.value = entry.title ?? '';
  formDescription.value = entry.description ?? '';
  formInitialPrompt.value = entry.initialPrompt ?? '';
  formMode.value = entry.mode ?? 'spawn';
  selectedCliType.value = entry.cliType ?? '';
  selectedDirPath.value = entry.dirPath ?? '';
  formCliParams.value = entry.cliParams ?? '';
  selectedTargetSessionId.value = entry.targetSessionId ?? '';
  scheduleKind.value = entry.scheduleKind ?? 'once';
  intervalMinutes.value = Math.max(1, Math.round((entry.intervalMs ?? 3600000) / 60000));
  cronExpression.value = entry.cronExpression ?? '0 9 * * 1-5';
  endDate.value = entry.endDate ? toLocalDateInputValue(new Date(entry.endDate)) : '';
  const nextHour = new Date();
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  formTime.value = toLocalDateTimeInputValue(nextHour);
  showCreateForm.value = true;
  if (formMode.value === 'direct') loadSessions();
}

function cloneTask(): void {
  if (!editingTaskId.value) return;
  editingTaskId.value = null;
  formTitle.value = formTitle.value.trim() ? `${formTitle.value.trim()} (copy)` : '';
  if (scheduleKind.value === 'none') {
    scheduleKind.value = 'once';
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    formTime.value = toLocalDateTimeInputValue(nextHour);
  }
  formError.value = '';
  showCreateForm.value = true;
}

async function cancelTask(taskId: string): Promise<void> {
  try { if (await schedulerClient.scheduledTaskCancel(taskId)) { emit('task-cancelled', taskId); await loadTasks(); } } catch {}
}

onMounted(async () => {
  await Promise.all([loadTasks(), loadSessions()]);
  if (props.initialEditTaskId) {
    const task = tasks.value.find((item) => item.id === props.initialEditTaskId);
    if (task) editTask(task);
  } else if (props.initialPrefill) {
    prefillFromSnapshot(props.initialPrefill);
  } else if (props.initialCreate || props.popup) {
    showCreateForm.value = true;
    startCreateForm();
  }
  // Sessions refresh alongside tasks: a direct-mode target that closes while the
  // form is open must stop being selectable.
  refreshTimer = setInterval(() => { void loadTasks(); void loadSessions(); }, 10000);
  if (props.popup) modalStack.push({ id: 'scheduler-popup', handler: () => true, interceptKeys: FORM_KEYS });
});

watch(() => props.initialCreate, (initialCreate) => { if (!initialCreate || props.initialEditTaskId || props.initialPrefill) return; showCreateForm.value = true; startCreateForm(); });
watch(() => props.initialPrefill, (prefill) => { if (!prefill || props.initialEditTaskId) return; prefillFromSnapshot(prefill); });
watch(() => props.initialEditTaskId, async (taskId) => { if (!taskId) return; await loadTasks(); const task = tasks.value.find((item) => item.id === taskId); if (task) editTask(task); });
watch([scheduleKind, formTime], () => { formError.value = ''; });
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer); modalStack.pop('scheduler-popup'); });
</script>

<template>
  <div ref="popupRoot" class="scheduled-tasks-tab" :class="{ 'scheduled-tasks-tab--popup': popup }" @keydown="popup ? trapOnKeydown($event) : undefined">
    <div v-if="!popup" class="st-header">
      <h2 class="st-title">Scheduled Tasks</h2>
      <span class="st-count">{{ tasks.length }} task{{ tasks.length !== 1 ? 's' : '' }}</span>
      <button class="st-create-btn focusable" :disabled="creating" @click="toggleCreateForm">{{ showCreateForm ? 'Cancel' : '+ Create Task' }}</button>
    </div>

    <div v-if="formVisible" class="st-form">
      <div class="st-form-row"><label class="st-label">Title *</label><input v-model="formTitle" type="text" class="st-input focusable" placeholder="Task name" maxlength="100" /></div>
      <div class="st-form-row"><label class="st-label">Description (optional)</label><textarea v-model="formDescription" class="st-textarea focusable" placeholder="What this task does" rows="2" /></div>
      <div class="st-form-row">
        <PromptTextarea v-model="formInitialPrompt" label="Prompt *" placeholder="What to send to the CLI" :rows="3" :min-rows="3" :max-rows="14" />
      </div>
      <div class="st-form-row st-form-row--picker"><label class="st-label">Working Directory *</label><button class="st-picker-btn focusable" @click="openDirPickerModal">{{ selectedDirPath ? shortenPath(selectedDirPath) : 'Select Directory...' }}</button></div>
      <div class="st-form-row"><label class="st-label">Mode</label><select v-model="formMode" class="st-input focusable" @change="onModeChange"><option value="spawn">Spawn new session</option><option value="direct">Send to existing session</option></select></div>
      <div v-if="formMode !== 'direct'" class="st-form-row st-form-row--picker"><label class="st-label">CLI Type *</label><button class="st-picker-btn focusable" @click="openCliPicker">{{ selectedCliType ? getCliDisplayName(selectedCliType) : 'Select CLI...' }}</button></div>
      <div v-if="formMode === 'direct'" class="st-form-row"><label class="st-label">Target Session *</label><select v-model="selectedTargetSessionId" class="st-input focusable" :disabled="sessionsForDir.length === 0"><option value="" disabled>{{ sessionsForDir.length === 0 ? 'No sessions in this directory' : 'Select session...' }}</option><option v-for="s in sessionsForDir" :key="s.id" :value="s.id">{{ s.name }} ({{ getCliDisplayName(s.cliType) }})</option></select></div>
      <div v-if="formMode !== 'direct'" class="st-form-row"><label class="st-label">CLI Params (optional)</label><input v-model="formCliParams" type="text" class="st-input focusable" placeholder="Additional CLI arguments" /></div>
      <div v-if="scheduleKind !== 'none'" class="st-form-row"><label class="st-label">Scheduled Time *</label><input v-model="formTime" type="datetime-local" class="st-input focusable" /></div>
      <div class="st-form-row st-form-row--inline"><div class="st-form-row"><label class="st-label">Schedule</label><select v-model="scheduleKind" class="st-input focusable" @change="onScheduleKindChange"><option v-if="editingTaskId" value="none">None</option><option value="once">Once</option><option value="interval">Recurring interval</option><option value="cron">Cron calendar</option></select></div><div v-if="scheduleKind === 'interval'" class="st-form-row"><label class="st-label">Repeat Every (min) *</label><input v-model.number="intervalMinutes" type="number" min="1" class="st-input focusable" /></div></div>
      <p v-if="scheduleKind === 'none'" class="st-unscheduled-hint">No cadence is set. Choose a schedule and future time to resume.</p>
      <p v-if="formError" class="st-form-error" role="alert">{{ formError }}</p>
      <div v-if="scheduleKind === 'cron'" class="st-form-row st-cron-box">
        <label class="st-label">Cron Expression *</label>
        <input v-model="cronExpression" type="text" class="st-input focusable" placeholder="0 9 * * 1-5" />
        <div class="st-cron-presets">
          <button v-for="preset in cronPresets" :key="preset.expression" type="button" class="st-preset-btn focusable" @click="cronExpression = preset.expression">{{ preset.label }}</button>
        </div>
        <p class="st-cron-status" :class="{ 'st-cron-status--invalid': !cronValidation.valid }">
          {{ cronValidation.valid ? (cronValidation.nextRunAt ? `Next: ${formatTime(cronValidation.nextRunAt)}` : 'Valid expression') : cronValidation.error }}
        </p>
        <div class="st-form-row"><label class="st-label">End Date (optional)</label><input v-model="endDate" type="date" class="st-input focusable" /></div>
      </div>
      <div class="st-form-footer"><button v-if="!popup" class="st-btn st-btn--secondary focusable" @click="toggleCreateForm">Cancel</button><button v-if="popup" class="st-btn st-btn--secondary focusable" @click="emit('close')">Cancel</button><button v-if="editingTaskId" class="st-btn st-btn--secondary focusable" :disabled="creating" @click="cloneTask">Clone</button><button class="st-btn st-btn--primary focusable" :disabled="!canCreate || creating" @click="createTask">{{ creating ? (editingTaskId ? 'Saving...' : 'Creating...') : (editingTaskId ? 'Save' : 'Create') }}</button></div>
    </div>

    <div v-if="!popup" class="st-task-list">
      <div v-if="sortedTasks.length === 0 && !showCreateForm" class="st-empty">No scheduled tasks yet. Click "+ Create Task" to add one.</div>
      <div v-for="task in sortedTasks" :key="task.id" class="st-task-card" :class="'st-task-card--' + task.status">
        <div class="st-task-header"><h4 class="st-task-title">{{ task.title }}</h4><span class="st-task-badge" :class="getStatusBadge(task).cssClass">{{ getStatusBadge(task).label }}</span></div>
        <p v-if="task.description" class="st-task-description">{{ task.description }}</p>
        <div class="st-task-meta"><span class="st-task-chip">{{ getCliDisplayName(task.cliType) }}</span><span class="st-task-chip">{{ shortenPath(task.dirPath) }}</span><span class="st-task-chip">{{ formatSchedule(task) }}</span><span v-if="task.status === 'pending' && task.scheduleKind === 'none'" class="st-task-time">not scheduled</span><span v-else-if="task.status === 'pending'" class="st-task-countdown">{{ formatNextRun(task) }}</span><span v-else-if="task.status === 'executing'" class="st-task-countdown st-task-countdown--running">running...</span><span v-else class="st-task-time">{{ formatTime(task.scheduledTime) }}</span></div>
        <div v-if="task.error" class="st-task-error">{{ task.error }}</div>
        <div v-if="task.status === 'pending' && !task.systemKind" class="st-task-actions"><button class="st-btn st-btn--secondary focusable" :disabled="creating" @click="editTask(task)">Edit</button><button class="st-btn st-btn--danger focusable" :disabled="creating" @click="cancelTask(task.id)">Cancel Task</button></div>
      </div>
    </div>

    <QuickSpawnModal :visible="cliPickerVisible" :cli-types="availableCliTypes" @select="onCliSelected" @cancel="cliPickerVisible = false" @update:visible="cliPickerVisible = $event" />
    <DirPickerModal :visible="dirPickerVisible" :cli-type="selectedCliType || ''" :items="availableDirs" @select="onDirSelected" @cancel="dirPickerVisible = false" @update:visible="dirPickerVisible = $event" />
  </div>
</template>

<style scoped>
.scheduled-tasks-tab { padding: 16px; max-width: 800px; margin: 0 auto; }
.scheduled-tasks-tab--popup { max-width: none; max-height: 78vh; overflow: auto; border: 2px solid #44cc44; border-radius: 8px; }
.st-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.st-title { margin: 0; font-size: 1.5rem; color: var(--text-primary); }
.st-count { color: var(--text-secondary); font-size: 0.85rem; }
.st-create-btn { margin-left: auto; padding: 8px 16px; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500; font-size: 0.9rem; }
.st-create-btn:hover { opacity: 0.9; }
.st-create-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.st-form { background: var(--bg-secondary); padding: 20px; border-radius: 8px; margin-bottom: 20px; display: flex; flex-direction: column; gap: 14px; }
.st-form-row { display: flex; flex-direction: column; gap: 4px; }
.st-form-row--inline { flex-direction: row; gap: 12px; }
.st-form-row--inline > .st-form-row { flex: 1; }
.st-label { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
.st-input, .st-textarea { padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-size: 0.95rem; box-sizing: border-box; }
.st-textarea { resize: vertical; min-height: 60px; font-family: inherit; }
.st-form-row--picker { margin-bottom: 2px; }
.st-picker-btn { display: flex; align-items: center; min-height: 40px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.9rem; text-align: left; cursor: pointer; transition: border-color 0.2s; }
.st-picker-btn--disabled { opacity: 0.5; cursor: default; }
.st-picker-btn:hover:not(.st-picker-btn--disabled) { border-color: var(--accent); }
.st-cron-box { padding: 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 6px; }
.st-cron-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.st-preset-btn { padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-tertiary); color: var(--text-primary); font-size: 0.8rem; cursor: pointer; }
.st-preset-btn:hover { border-color: var(--accent); }
.st-cron-status { margin: 0; font-size: 0.82rem; color: #44cc44; }
.st-cron-status--invalid { color: #ff6666; }
.st-unscheduled-hint { margin: 0; color: var(--text-secondary); font-size: 0.85rem; }
.st-form-error { margin: 0; color: #ff6666; font-size: 0.85rem; }
.st-form-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--border); }
.st-btn { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500; font-size: 0.95rem; }
.st-btn--primary { background: var(--accent); color: white; }
.st-btn--primary:hover:not(:disabled) { opacity: 0.9; }
.st-btn--primary:disabled { opacity: 0.5; cursor: not-allowed; }
.st-btn--secondary { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); padding: 10px 20px; }
.st-btn--secondary:hover:not(:disabled) { border-color: var(--accent); }
.st-btn--danger { background: #ff4444; color: white; padding: 6px 12px; font-size: 0.85rem; }
.st-btn--danger:hover:not(:disabled) { background: #cc0000; }
.st-empty { text-align: center; padding: 40px; color: var(--text-secondary); }
.st-task-list { display: flex; flex-direction: column; gap: 12px; }
.st-task-card { background: var(--bg-secondary); border-radius: 8px; padding: 16px; border-left: 4px solid var(--text-secondary); }
.st-task-card--pending { border-left-color: #4488ff; }
.st-task-card--executing { border-left-color: #ff9f1a; }
.st-task-card--completed { border-left-color: #44cc44; opacity: 0.6; }
.st-task-card--cancelled { border-left-color: #555; opacity: 0.5; }
.st-task-card--failed { border-left-color: #ff4444; }
.st-task-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
.st-task-title { margin: 0; font-size: 1.1rem; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-task-badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; font-weight: 500; flex-shrink: 0; }
.badge--pending { background: rgba(68,136,255,0.15); color: #4488ff; }
.badge--executing { background: rgba(255,159,26,0.15); color: #ff9f1a; }
.badge--completed { background: rgba(68,204,68,0.15); color: #44cc44; }
.badge--cancelled { background: rgba(85,85,85,0.15); color: #555; }
.badge--failed { background: rgba(255,68,68,0.15); color: #ff4444; }
.st-task-description { margin: 0 0 4px; font-size: 0.9rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-task-meta { display: flex; gap: 8px; font-size: 0.8rem; color: var(--text-secondary); flex-wrap: wrap; align-items: center; }
.st-task-chip { background: var(--bg-tertiary); padding: 1px 6px; border-radius: 3px; }
.st-task-countdown { margin-left: auto; font-weight: 500; color: var(--accent); }
.st-task-countdown--running { color: #ff9f1a; }
.st-task-time { margin-left: auto; color: var(--text-secondary); }
.st-task-error { margin-top: 8px; padding: 8px; background: rgba(255, 68, 68, 0.1); border-radius: 4px; color: #ff4444; font-size: 0.9rem; }
.st-task-actions { margin-top: 12px; display: flex; gap: 8px; }
</style>
