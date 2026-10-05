<script setup lang="ts">
/**
 * ScheduledTaskHistoryModal.vue — read-only 7-day log of scheduled task runs.
 *
 * Shows a grouped-by-day list of past task executions captured at fire time.
 * Each entry is an immutable metadata snapshot (no PTY/stdout). Users can
 * recreate an entry as a fresh task or clear the whole history.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { eventsClient, schedulerClient } from '../../ipc/clients.js';
import type { ScheduledTaskHistoryEntry } from '../../../src/types/scheduled-task.js';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { getCliDisplayName } from '../../utils.js';
import { formatLocalDayLabel, startOfLocalDay } from '../../utils/local-day.js';

const MODAL_ID = 'scheduler-history';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  recreate: [entry: ScheduledTaskHistoryEntry];
}>();

const entries = ref<ScheduledTaskHistoryEntry[]>([]);
const expandedIds = ref<Set<string>>(new Set());

const overlayRef = ref<HTMLElement | null>(null);
const { onKeydown: trapOnKeydown } = useFocusTrap('.sth-modal');
const modalStack = useModalStack();
let offChanged: (() => void) | null = null;

interface DayGroup {
  key: string;
  label: string;
  entries: ScheduledTaskHistoryEntry[];
}

const dayGroups = computed<DayGroup[]>(() => {
  const groups = new Map<string, DayGroup>();
  // entries arrive newest-first; preserve that order within each group.
  for (const entry of entries.value) {
    const key = String(startOfLocalDay(entry.ranAt));
    let group = groups.get(key);
    if (!group) {
      group = { key, label: formatLocalDayLabel(entry.ranAt), entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
});

function outcomeBadge(outcome: ScheduledTaskHistoryEntry['outcome']): { label: string; cssClass: string } {
  switch (outcome) {
    case 'done': return { label: 'Done', cssClass: 'sth-badge--done' };
    case 'failed': return { label: 'Failed', cssClass: 'sth-badge--failed' };
    case 'cancelled': return { label: 'Cancelled', cssClass: 'sth-badge--cancelled' };
    default: return { label: outcome, cssClass: '' };
  }
}

function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return '.../' + parts.slice(-2).join('/');
}

function scheduleLabel(entry: ScheduledTaskHistoryEntry): string {
  if (entry.scheduleKind === 'interval' && entry.intervalMs) return `Interval · every ${Math.round(entry.intervalMs / 60000)} min`;
  if (entry.scheduleKind === 'cron' && entry.cronExpression) return `Cron · ${entry.cronExpression}`;
  return 'Once';
}

function modeLabel(entry: ScheduledTaskHistoryEntry): string {
  return entry.mode === 'direct' ? 'direct' : 'spawn';
}

function ranAtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
}

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id);
}

function toggleDetails(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

async function reload(): Promise<void> {
  try {
    entries.value = await schedulerClient.listHistory() ?? [];
  } catch {
    entries.value = [];
  }
}

function close(): void {
  emit('update:visible', false);
}

function onRecreate(entry: ScheduledTaskHistoryEntry): void {
  emit('recreate', entry);
  close();
}

async function clearHistory(): Promise<void> {
  try {
    await schedulerClient.clearHistory();
  } catch { /* ignore */ }
  await reload();
}

function handleButton(): boolean {
  // Esc/B handled via overlay keydown + modal stack; nothing extra to route.
  return true;
}

function onOverlayKeydown(event: KeyboardEvent): void {
  trapOnKeydown(event);
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

watch(() => props.visible, (visible) => {
  if (visible) {
    expandedIds.value = new Set();
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: FORM_KEYS });
    void reload();
    offChanged = eventsClient.onScheduledTaskHistoryChanged?.(() => { void reload(); }) ?? null;
  } else {
    modalStack.pop(MODAL_ID);
    offChanged?.();
    offChanged = null;
  }
}, { immediate: true });

onUnmounted(() => {
  modalStack.pop(MODAL_ID);
  offChanged?.();
});

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Past Schedules"
      tabindex="-1"
      @click.self="close"
      @keydown="onOverlayKeydown"
    >
      <div class="modal sth-modal">
        <div class="sth-head">
          <h3 class="sth-title">Past Schedules</h3>
          <span class="sth-count">{{ entries.length }} run{{ entries.length !== 1 ? 's' : '' }} · last 7 days</span>
          <span class="sth-spacer"></span>
          <button class="sth-clear focusable" type="button" :disabled="entries.length === 0" @click="clearHistory">Clear history</button>
          <button class="sth-x focusable" type="button" aria-label="Close" @click="close">✕</button>
        </div>

        <div class="sth-body">
          <div v-if="entries.length === 0" class="sth-empty">No past schedules in the last 7 days</div>

          <template v-for="group in dayGroups" :key="group.key">
            <div class="sth-day-label">{{ group.label }}</div>
            <div
              v-for="entry in group.entries"
              :key="entry.id"
              class="sth-run"
            >
              <div class="sth-run-top">
                <span class="st-task-badge sth-badge" :class="outcomeBadge(entry.outcome).cssClass">{{ outcomeBadge(entry.outcome).label }}</span>
                <span class="sth-run-title">{{ entry.title }}</span>
                <span class="sth-ran-at">{{ ranAtTime(entry.ranAt) }}</span>
              </div>

              <div class="sth-chips">
                <span class="st-task-chip">{{ getCliDisplayName(entry.cliType) }}</span>
                <span class="st-task-chip">{{ shortenPath(entry.dirPath) }}</span>
                <span class="st-task-chip">{{ scheduleLabel(entry) }}</span>
                <span class="st-task-chip">{{ modeLabel(entry) }}</span>
              </div>

              <div class="sth-prompt" :title="entry.initialPrompt">{{ promptPreview(entry.initialPrompt) }}</div>

              <div v-if="entry.outcome === 'failed' && entry.error" class="sth-err">{{ entry.error }}</div>

              <div v-if="isExpanded(entry.id)" class="sth-details">
                <div class="sth-detail-row"><span class="sth-detail-label">Prompt</span><pre class="sth-detail-pre">{{ entry.initialPrompt }}</pre></div>
                <div v-if="entry.description" class="sth-detail-row"><span class="sth-detail-label">Description</span><div class="sth-detail-val">{{ entry.description }}</div></div>
                <div v-if="entry.planIds.length" class="sth-detail-row"><span class="sth-detail-label">Plans</span><div class="sth-detail-val">{{ entry.planIds.join(', ') }}</div></div>
                <div v-if="entry.sessionId" class="sth-detail-row"><span class="sth-detail-label">Session</span><div class="sth-detail-val">{{ entry.sessionId }}</div></div>
              </div>

              <div class="sth-actions">
                <button class="sth-btn sth-btn--primary focusable" type="button" @click="onRecreate(entry)">↻ Recreate as new</button>
                <button class="sth-btn focusable" type="button" @click="toggleDetails(entry.id)">{{ isExpanded(entry.id) ? 'Hide details' : 'View details' }}</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sth-modal {
  border: 2px solid var(--accent);
  border-radius: 10px;
  background: var(--bg-secondary);
  width: min(760px, 92vw);
  display: flex;
  flex-direction: column;
}
.sth-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.sth-title { margin: 0; font-size: 1.1rem; color: var(--text-primary); }
.sth-count { color: var(--text-secondary); font-size: 0.8rem; }
.sth-spacer { margin-left: auto; }
.sth-clear {
  background: none; border: 1px solid var(--border); color: var(--text-secondary);
  border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 0.78rem;
}
.sth-clear:hover:not(:disabled) { border-color: var(--accent); color: var(--text-primary); }
.sth-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.sth-x { background: none; border: none; color: var(--text-secondary); font-size: 1.2rem; cursor: pointer; }
.sth-x:hover { color: var(--text-primary); }
.sth-body { padding: 12px 18px 18px; max-height: 60vh; overflow: auto; }
.sth-empty { text-align: center; padding: 40px; color: var(--text-secondary); }

.sth-day-label {
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text-secondary); margin: 14px 0 8px; position: sticky; top: 0;
  background: var(--bg-secondary); padding: 4px 0; z-index: 1;
}
.sth-day-label:first-child { margin-top: 0; }

.sth-run {
  border: 1px solid var(--border);
  border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; background: var(--bg-primary);
}
.sth-run-top { display: flex; align-items: center; gap: 8px; }
.sth-run-title { font-weight: 600; font-size: 1rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sth-ran-at { margin-left: auto; color: var(--text-secondary); font-size: 0.8rem; font-variant-numeric: tabular-nums; flex-shrink: 0; }

.st-task-badge { font-size: 0.72rem; padding: 2px 8px; border-radius: 3px; font-weight: 500; flex-shrink: 0; }
.sth-badge--done { background: rgba(68,204,68,0.15); color: #44cc44; }
.sth-badge--failed { background: rgba(255,68,68,0.15); color: #ff6666; }
.sth-badge--cancelled { background: rgba(120,120,120,0.18); color: #aaa; }

.sth-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.st-task-chip { background: var(--bg-tertiary); padding: 2px 8px; border-radius: 3px; font-size: 0.76rem; color: var(--text-secondary); }

.sth-prompt {
  background: var(--bg-tertiary); border-radius: 4px; padding: 8px 10px;
  font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.8rem;
  color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sth-err { margin-top: 8px; padding: 7px 10px; background: rgba(255,68,68,0.1); color: #ff6666; border-radius: 4px; font-size: 0.82rem; }

.sth-details { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.sth-detail-row { display: flex; flex-direction: column; gap: 2px; }
.sth-detail-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.3px; color: var(--text-secondary); }
.sth-detail-val { font-size: 0.85rem; color: var(--text-primary); word-break: break-word; }
.sth-detail-pre {
  margin: 0; font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.8rem;
  color: var(--text-primary); white-space: pre-wrap; word-break: break-word;
  background: var(--bg-tertiary); border-radius: 4px; padding: 8px 10px;
}

.sth-actions { margin-top: 10px; display: flex; gap: 8px; }
.sth-btn {
  padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--bg-tertiary); color: var(--text-primary); cursor: pointer; font-size: 0.82rem;
}
.sth-btn:hover { border-color: var(--accent); }
.sth-btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sth-btn--primary:hover { opacity: 0.9; }
</style>
