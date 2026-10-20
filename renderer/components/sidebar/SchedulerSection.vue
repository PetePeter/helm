<script setup lang="ts">
import { appClient, attachmentsClient, contextsClient, deliveryClient, dialogClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient } from '../../ipc/clients.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ScheduledTask } from '../../../src/types/scheduled-task.js';

const emit = defineEmits<{
  open: [taskId: string | null];
  delete: [task: ScheduledTask];
  history: [];
}>();

const tasks = ref<ScheduledTask[]>([]);
const schedulesCollapsed = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let offChanged: (() => void) | null = null;

const activeTasks = computed(() => tasks.value
  .filter((task) => task.status === 'pending' || task.status === 'executing')
  .sort((a, b) => {
    if ((a.scheduleKind === 'none') !== (b.scheduleKind === 'none')) return a.scheduleKind === 'none' ? 1 : -1;
    return nextRunMs(a) - nextRunMs(b);
  }));
const scheduleTasks = computed(() => activeTasks.value.filter((task) => !task.systemKind).slice(0, 4));

async function loadTasks(): Promise<void> {
  try {
    tasks.value = await schedulerClient.scheduledTaskList() ?? [];
  } catch {
    tasks.value = [];
  }
}

function nextRunMs(task: ScheduledTask): number {
  if (task.scheduleKind === 'none') return Number.POSITIVE_INFINITY;
  return new Date(task.nextRunAt ?? task.scheduledTime).getTime();
}

function timeRemaining(task: ScheduledTask): string {
  if (task.status === 'executing') return 'running';
  if (task.scheduleKind === 'none') return 'off';
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
  refreshTimer = setInterval(() => { void loadTasks(); }, 15000);
  offChanged = eventsClient.onScheduledTaskChanged?.(() => {
    void loadTasks();
  }) ?? null;
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  offChanged?.();
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
.scheduler-row:hover {
  border-color: var(--border);
}
.scheduler-row--running {
  border-color: #ff9f1a;
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
