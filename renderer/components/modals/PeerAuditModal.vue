<script setup lang="ts">
/**
 * PeerAuditModal.vue — read-only 7-day trail of proxied peer calls.
 *
 * Mirrors ScheduledTaskHistoryModal: entries grouped by day (Today/Yesterday/
 * date), newest-first, with an outcome badge. SECURITY: the audit log carries NO
 * payload values — only method, top-level arg key names (argSummary) and an
 * outcome/error string — so everything shown here is safe to display.
 */
import { computed, onUnmounted, watch } from 'vue';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { usePeers, type PeerAuditEntry } from '../../composables/usePeers.js';
import { formatLocalDayLabel, startOfLocalDay } from '../../utils/local-day.js';

const MODAL_ID = 'peer-audit';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const { audit, refreshAudit } = usePeers();
const modalStack = useModalStack();

interface DayGroup {
  key: string;
  label: string;
  entries: PeerAuditEntry[];
}

const dayGroups = computed<DayGroup[]>(() => {
  const groups = new Map<string, DayGroup>();
  for (const entry of audit.value) {
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

function outcomeBadge(outcome: PeerAuditEntry['outcome']): { label: string; cssClass: string } {
  switch (outcome) {
    case 'ok': return { label: 'OK', cssClass: 'pa-badge--ok' };
    case 'denied': return { label: 'Denied', cssClass: 'pa-badge--warn' };
    case 'rate-limited': return { label: 'Rate limited', cssClass: 'pa-badge--warn' };
    case 'error': return { label: 'Error', cssClass: 'pa-badge--error' };
    default: return { label: outcome, cssClass: '' };
  }
}

function ranAtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function close(): void {
  emit('update:visible', false);
}

function handleButton(): boolean {
  return true;
}

function onOverlayKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

watch(() => props.visible, (visible) => {
  if (visible) {
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: FORM_KEYS });
    void refreshAudit();
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

onUnmounted(() => {
  modalStack.pop(MODAL_ID);
});

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Peer audit log"
      tabindex="-1"
      @click.self="close"
      @keydown="onOverlayKeydown"
    >
      <div class="modal pa-modal">
        <div class="pa-head">
          <h3 class="pa-title">Peer Audit</h3>
          <span class="pa-count">{{ audit.length }} call{{ audit.length !== 1 ? 's' : '' }} · last 7 days</span>
          <span class="pa-spacer"></span>
          <button class="pa-x focusable" type="button" aria-label="Close" @click="close">✕</button>
        </div>

        <div class="pa-body">
          <div v-if="audit.length === 0" class="pa-empty">No proxied peer calls in the last 7 days</div>

          <template v-for="group in dayGroups" :key="group.key">
            <div class="pa-day-label">{{ group.label }}</div>
            <div v-for="entry in group.entries" :key="entry.id" class="pa-run">
              <div class="pa-run-top">
                <span class="pa-badge" :class="outcomeBadge(entry.outcome).cssClass">{{ outcomeBadge(entry.outcome).label }}</span>
                <span class="pa-method">{{ entry.method }}</span>
                <span class="pa-ran-at">{{ ranAtTime(entry.ranAt) }}</span>
              </div>
              <div class="pa-chips">
                <span class="pa-chip">peer {{ entry.peerId }}</span>
                <span v-if="entry.argSummary" class="pa-chip">{{ entry.argSummary }}</span>
              </div>
              <div v-if="entry.outcome === 'error' && entry.error" class="pa-err">{{ entry.error }}</div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pa-modal {
  border: 2px solid var(--accent);
  border-radius: 10px;
  background: var(--bg-secondary);
  width: min(680px, 92vw);
  display: flex;
  flex-direction: column;
}
.pa-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.pa-title { margin: 0; font-size: 1.1rem; color: var(--text-primary); }
.pa-count { color: var(--text-secondary); font-size: 0.8rem; }
.pa-spacer { margin-left: auto; }
.pa-x { background: none; border: none; color: var(--text-secondary); font-size: 1.2rem; cursor: pointer; }
.pa-x:hover { color: var(--text-primary); }
.pa-body { padding: 12px 18px 18px; max-height: 60vh; overflow: auto; }
.pa-empty { text-align: center; padding: 40px; color: var(--text-secondary); }

.pa-day-label {
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text-secondary); margin: 14px 0 8px; position: sticky; top: 0;
  background: var(--bg-secondary); padding: 4px 0; z-index: 1;
}
.pa-day-label:first-child { margin-top: 0; }

.pa-run {
  border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--bg-primary);
}
.pa-run-top { display: flex; align-items: center; gap: 8px; }
.pa-method {
  font-family: ui-monospace, "Cascadia Code", monospace; font-weight: 600;
  font-size: 0.9rem; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pa-ran-at { margin-left: auto; color: var(--text-secondary); font-size: 0.8rem; font-variant-numeric: tabular-nums; flex-shrink: 0; }

.pa-badge { font-size: 0.72rem; padding: 2px 8px; border-radius: 3px; font-weight: 500; flex-shrink: 0; }
.pa-badge--ok { background: rgba(68,204,68,0.15); color: #44cc44; }
.pa-badge--warn { background: rgba(255,159,26,0.18); color: #ff9f1a; }
.pa-badge--error { background: rgba(255,68,68,0.15); color: #ff6666; }

.pa-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.pa-chip { background: var(--bg-tertiary); padding: 2px 8px; border-radius: 3px; font-size: 0.74rem; color: var(--text-secondary); }
.pa-err { margin-top: 6px; padding: 6px 9px; background: rgba(255,68,68,0.1); color: #ff6666; border-radius: 4px; font-size: 0.8rem; }
</style>
