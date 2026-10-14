<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ConfirmDialog from '../modals/ConfirmDialog.vue';
import MemoryDetailPopOutWindow from '../MemoryDetailPopOutWindow.vue';
import EmptyState from '../common/EmptyState.vue';
import PanelHeader from '../common/PanelHeader.vue';
import SearchField from '../common/SearchField.vue';
import { useAppStore } from '../../stores/app.js';
import {
  buildMemoryHistogram,
  memoriesInTimelineRange,
  memoryTimelineBounds,
  sortMemoriesNewestFirst,
  type MemoryTimelineBucket,
  type MemoryTimelinePreset,
} from '../../memories/memory-timeline.js';
import {
  confirmDelete,
  deleteAttachment,
  disposeMemoryChangedSubscription,
  ensureMemoryChangedSubscription,
  exportMemories,
  memoryScreenState,
  openAttachment,
  openDetail,
  refreshMemories,
  requestDelete,
  searchMemories,
  selectMemory,
  setMemoryTimelinePreset,
  setMemoryTimelineRange,
  setGraphDepth,
} from '../../memories/memory-screen.js';

const appState = useAppStore().state;
const exportScope = ref<'selected' | 'all'>('selected');
const timelinePresets: Array<{ label: string; value: Exclude<MemoryTimelinePreset, 'custom'> }> = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
  { label: 'All time', value: 'all' },
];
const matchedIds = computed(() => new Set(memoryScreenState.matchedIds));
const filtering = computed(() => memoryScreenState.searchQuery.trim().length > 0);
const newestFirst = computed(() => sortMemoriesNewestFirst(memoryScreenState.summaries));
const timelineBounds = computed(() => memoryTimelineBounds(memoryScreenState.summaries));
const timelineRange = computed(() => {
  const bounds = timelineBounds.value;
  if (!bounds) return null;
  return {
    start: memoryScreenState.timelineStart ?? bounds.start,
    end: memoryScreenState.timelineEnd ?? bounds.end,
  };
});
const inDateRange = computed(() => timelineRange.value
  ? memoriesInTimelineRange(newestFirst.value, timelineRange.value)
  : newestFirst.value);
const visibleMemories = computed(() => inDateRange.value
  .filter((memory) => !filtering.value || matchedIds.value.has(memory.id)));
const histogram = computed(() => timelineRange.value
  ? buildMemoryHistogram(visibleMemories.value, timelineRange.value)
  : []);
const histogramMax = computed(() => Math.max(1, ...histogram.value.map((bucket) => bucket.count)));
const histogramTicks = computed(() => {
  if (histogram.value.length === 0) return [];
  const last = histogram.value.length - 1;
  return [...new Set([0, Math.floor(last / 4), Math.floor(last / 2), Math.floor(last * 3 / 4), last])]
    .map((index) => histogram.value[index].label);
});
const rangeStep = computed(() => {
  const bounds = timelineBounds.value;
  return bounds ? Math.max(1, Math.ceil((bounds.end - bounds.start) / 1000)) : 1;
});
const rangeDisabled = computed(() => !timelineBounds.value || timelineBounds.value.start === timelineBounds.value.end);
const rangeTrackStyle = computed(() => {
  const bounds = timelineBounds.value;
  const range = timelineRange.value;
  if (!bounds || !range || bounds.start === bounds.end) return { left: '0%', width: '100%' };
  const duration = bounds.end - bounds.start;
  const start = ((range.start - bounds.start) / duration) * 100;
  const end = ((range.end - bounds.start) / duration) * 100;
  return { left: `${start}%`, width: `${Math.max(0, end - start)}%` };
});
const rangeSummary = computed(() => {
  const range = timelineRange.value;
  const count = visibleMemories.value.length;
  if (!range) return `${count} memories`;
  return `Showing ${count} · ${formatRangeDate(range.start)} – ${formatRangeDate(range.end)}`;
});

/**
 * Direct neighbours of the selection, read off the forest rather than a rooted
 * traversal. Both directions are included and labelled, because an incoming
 * link is just as much a relationship as an outgoing one.
 */
const neighbors = computed(() => {
  const selected = memoryScreenState.selectedId;
  const forest = memoryScreenState.forest;
  if (!selected || !forest) return [];
  const labelOf = (id: string) => forest.records.find((record) => record.id === id)?.tldr ?? id;
  return forest.edges
    .filter((edge) => edge.fromId === selected || edge.toId === selected)
    .map((edge) => edge.fromId === selected
      ? { id: edge.toId, label: labelOf(edge.toId), status: 'outgoing' }
      : { id: edge.fromId, label: labelOf(edge.fromId), status: 'incoming' });
});

function formatRangeDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMemoryDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function onRangeStart(event: Event): void {
  const range = timelineRange.value;
  if (!range) return;
  const start = Number((event.target as HTMLInputElement).value);
  setMemoryTimelineRange(Math.min(start, range.end), range.end);
}

function onRangeEnd(event: Event): void {
  const range = timelineRange.value;
  if (!range) return;
  const end = Number((event.target as HTMLInputElement).value);
  setMemoryTimelineRange(range.start, Math.max(end, range.start));
}

function selectBucket(bucket: MemoryTimelineBucket): void {
  setMemoryTimelineRange(bucket.start, bucket.end);
}

watch(() => appState.activeSessionId, () => { void refreshMemories(); });
onMounted(() => { ensureMemoryChangedSubscription(); void refreshMemories(); });
onUnmounted(disposeMemoryChangedSubscription);
</script>

<template>
  <section class="memory-screen">
    <PanelHeader title="Memories" :subtitle="`${memoryScreenState.summaries.length} memories`">
      <template #actions>
        <label class="memory-export-scope">Export
          <select v-model="exportScope" aria-label="Export scope">
            <option value="selected">selected root</option>
            <option value="all">all memories</option>
          </select>
        </label>
        <button type="button" class="btn btn--secondary btn--sm" @click="void exportMemories('markdown', exportScope === 'selected' ? memoryScreenState.selectedId : null)">Markdown</button>
        <button type="button" class="btn btn--secondary btn--sm" @click="void exportMemories('json', exportScope === 'selected' ? memoryScreenState.selectedId : null)">JSON</button>
        <button type="button" class="btn btn--secondary btn--sm" @click="void refreshMemories()">Refresh</button>
      </template>
      <template #toolbar>
        <div class="memory-controls">
          <SearchField
            v-model="memoryScreenState.searchQuery"
            placeholder="Search memories"
            aria-label="Search memories"
            @keyup.enter="void searchMemories()"
          />
          <label><input v-model="memoryScreenState.regex" type="checkbox"> Regex</label>
          <label title="Depth used when exporting connected memories">Export depth
            <input
              :value="memoryScreenState.graphDepth"
              type="number"
              min="0"
              max="100"
              @change="setGraphDepth(Number(($event.target as HTMLInputElement).value))"
            >
          </label>
          <button type="button" class="btn btn--secondary btn--sm" @click="void searchMemories()">Search</button>
        </div>
      </template>
    </PanelHeader>

    <div class="memory-workspace">
      <div class="memory-timeline-panel">
        <section class="memory-timeline-card" aria-label="Memory creation timeline">
          <div class="memory-timeline-heading">
            <div>
              <div class="memory-timeline-title">Memory activity</div>
              <div class="memory-range-summary">{{ rangeSummary }}</div>
            </div>
            <div class="memory-quick-ranges" role="group" aria-label="Choose date range">
              <button
                v-for="preset in timelinePresets"
                :key="preset.value"
                type="button"
                :class="{ active: memoryScreenState.timelinePreset === preset.value }"
                :aria-pressed="memoryScreenState.timelinePreset === preset.value"
                @click="setMemoryTimelinePreset(preset.value)"
              >{{ preset.label }}</button>
            </div>
          </div>

          <div v-if="histogram.length" class="memory-chart-wrap">
            <div class="memory-chart-grid" aria-hidden="true">
              <div class="memory-grid-line" />
              <div class="memory-grid-line" />
              <div class="memory-grid-line" />
            </div>
            <div
              class="memory-bars"
              role="group"
              aria-label="Memories created in each time interval"
              :style="{ gridTemplateColumns: `repeat(${histogram.length}, minmax(2px, 1fr))` }"
            >
              <button
                v-for="bucket in histogram"
                :key="`${bucket.start}:${bucket.end}`"
                type="button"
                class="memory-bar"
                :style="{ height: `${bucket.count ? Math.max(8, bucket.count / histogramMax * 100) : 2}%` }"
                :aria-label="`${bucket.label}: ${bucket.count} ${bucket.count === 1 ? 'memory' : 'memories'}`"
                :title="`${bucket.label}: ${bucket.count} ${bucket.count === 1 ? 'memory' : 'memories'}`"
                :disabled="bucket.count === 0"
                @click="selectBucket(bucket)"
              />
            </div>
            <div class="memory-date-labels" aria-hidden="true">
              <span v-for="(label, index) in histogramTicks" :key="`${index}:${label}`">{{ label }}</span>
            </div>
          </div>

          <div v-if="timelineBounds && timelineRange" class="memory-range-control">
            <div class="memory-range-track" role="group" aria-label="Adjust visible date range">
              <div class="memory-track-base" />
              <div class="memory-track-selected" :style="rangeTrackStyle" />
              <input
                type="range"
                :min="timelineBounds.start"
                :max="timelineRange.end"
                :step="rangeStep"
                :value="timelineRange.start"
                :disabled="rangeDisabled"
                :aria-valuetext="formatRangeDate(timelineRange.start)"
                aria-label="Start of visible date range"
                @input="onRangeStart"
              >
              <input
                type="range"
                :min="timelineRange.start"
                :max="timelineBounds.end"
                :step="rangeStep"
                :value="timelineRange.end"
                :disabled="rangeDisabled"
                :aria-valuetext="formatRangeDate(timelineRange.end)"
                aria-label="End of visible date range"
                @input="onRangeEnd"
              >
            </div>
            <div class="memory-range-hint">Drag the handles to focus on a time window. Select a bar to focus on its interval.</div>
          </div>
        </section>

        <section class="memory-list-card" aria-label="Memories in selected date range">
          <div class="memory-list-heading">
            <strong>Newest first</strong>
            <span>{{ visibleMemories.length }} in this range</span>
          </div>
          <div class="memory-list">
            <EmptyState
              v-if="memoryScreenState.loading && memoryScreenState.summaries.length === 0"
              title="Loading memories"
              hint="Retrieving session context…"
              loading
            />
            <EmptyState
              v-else-if="visibleMemories.length === 0"
              title="No memories in this range."
              hint="Try a wider date range or clear the search."
            />
            <button
              v-for="memory in visibleMemories"
              :key="memory.id"
              type="button"
              class="memory-row"
              :class="{ selected: memory.id === memoryScreenState.selectedId }"
              @click="void selectMemory(memory.id)"
            >
              <span class="memory-row-date">{{ formatMemoryDate(memory.createdAt) }}</span>
              <span class="memory-row-title">{{ memory.tldr }}</span>
              <span class="memory-row-kind">{{ memory.agentRun ? 'run' : memory.sessionBound ? 'session' : memory.summary ? 'summary' : 'project' }}</span>
            </button>
          </div>
        </section>

        <p v-if="memoryScreenState.notice" class="memory-notice" role="status">{{ memoryScreenState.notice }}</p>
      </div>

      <aside class="memory-detail-pane" aria-label="Memory detail">
        <template v-if="memoryScreenState.detail">
          <h3 class="memory-detail-title">{{ memoryScreenState.detail.tldr }}</h3>
          <dl class="memory-detail-meta">
            <div><dt>Created</dt><dd>{{ new Date(memoryScreenState.detail.createdAt).toLocaleString() }}</dd></div>
            <div><dt>Updated</dt><dd>{{ new Date(memoryScreenState.detail.updatedAt).toLocaleString() }}</dd></div>
            <div><dt>Last read</dt><dd>{{ memoryScreenState.detail.lastAccessedAt ? new Date(memoryScreenState.detail.lastAccessedAt).toLocaleString() : 'never' }}</dd></div>
          </dl>
          <p class="memory-detail-body">{{ memoryScreenState.detail.content }}</p>
          <ul v-if="memoryScreenState.detail.attachments.length" class="memory-detail-attachments">
            <li v-for="attachment in memoryScreenState.detail.attachments" :key="attachment.id">
              <button type="button" class="btn btn--secondary btn--sm" @click="void openAttachment(attachment.id)">{{ attachment.filename }}</button>
              <button type="button" class="btn btn--secondary btn--sm" @click="void deleteAttachment(attachment.id)">Remove</button>
            </li>
          </ul>
          <div class="memory-detail-actions">
            <button type="button" class="btn btn--secondary btn--sm" @click="openDetail">Pop out</button>
            <button type="button" class="btn btn--secondary btn--sm" @click="requestDelete()">Delete</button>
          </div>
        </template>
        <EmptyState v-else title="Select a memory." hint="Choose an item from the list." />
      </aside>
    </div>

    <MemoryDetailPopOutWindow
      :visible="memoryScreenState.detailVisible"
      :record="memoryScreenState.detail"
      :neighbors="neighbors"
      @close="memoryScreenState.detailVisible = false"
      @delete="requestDelete()"
      @open-attachment="openAttachment"
      @delete-attachment="deleteAttachment"
    />
    <ConfirmDialog
      v-if="memoryScreenState.deleteTargetId"
      :visible="true"
      modal-id="memory-delete-confirm"
      title="Delete memory?"
      aria-label="Confirm memory deletion"
      :buttons="[{ id: 'delete', label: 'Delete', variant: 'danger' }, { id: 'cancel', label: 'Cancel', variant: 'secondary' }]"
      :selected-index="0"
      cancel-action-id="cancel"
      @action="(action) => action === 'delete' ? void confirmDelete() : (memoryScreenState.deleteTargetId = null)"
      @cancel="memoryScreenState.deleteTargetId = null"
    >
      <p class="memory-confirm-copy">This removes the memory and reroutes its session-owned graph edges.</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.memory-screen { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--text-primary); background: var(--bg-primary); }
.memory-controls, .memory-quick-ranges { display: flex; align-items: center; gap: 8px; }
.memory-controls { width: 100%; flex-wrap: wrap; }
.memory-export-scope { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 12px; }
.memory-controls .search-field { flex: 1; min-width: 180px; }
.memory-controls input[type='number'] { width: 60px; }
.memory-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 28%); min-height: 0; flex: 1; }
.memory-timeline-panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; overflow: hidden; padding: 16px 20px 20px; }
.memory-timeline-card, .memory-list-card { border: 1px solid var(--border); border-radius: 9px; background: var(--bg-secondary); }
.memory-timeline-card { flex: 0 0 auto; padding: 15px 18px 12px; }
.memory-timeline-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.memory-timeline-title { font-weight: 650; }
.memory-range-summary { color: var(--text-secondary); font-size: 12px; }
.memory-quick-ranges button { min-height: 26px; padding: 3px 8px; color: var(--text-secondary); font-size: 11px; }
.memory-quick-ranges button.active { border-color: var(--accent); color: var(--text-primary); background: color-mix(in srgb, var(--accent) 16%, var(--bg-secondary)); }
.memory-chart-wrap { position: relative; height: 148px; margin-top: 14px; padding: 0 2px; }
.memory-chart-grid, .memory-bars { position: absolute; inset: 8px 0 24px; }
.memory-chart-grid { display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; }
.memory-grid-line { border-top: 1px solid color-mix(in srgb, var(--text-secondary) 16%, transparent); }
.memory-bars { display: grid; align-items: end; gap: 4px; }
.memory-bar { min-width: 2px; min-height: 2px; padding: 0; border: 0; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--accent) 55%, var(--bg-secondary)); }
.memory-bar:hover:not(:disabled) { background: var(--accent); }
.memory-bar:disabled { opacity: .28; cursor: default; }
.memory-date-labels { position: absolute; right: 0; bottom: 0; left: 0; display: flex; justify-content: space-between; color: var(--text-secondary); font-size: 10px; }
.memory-range-control { margin-top: 7px; padding-top: 6px; }
.memory-range-track { position: relative; height: 28px; }
.memory-track-base, .memory-track-selected { position: absolute; top: 12px; height: 4px; border-radius: 4px; }
.memory-track-base { right: 0; left: 0; background: var(--border); }
.memory-track-selected { background: var(--accent); }
.memory-range-track input { position: absolute; inset: 0; width: 100%; height: 28px; margin: 0; appearance: none; background: transparent; pointer-events: none; }
.memory-range-track input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
.memory-range-track input::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -5px; appearance: none; border: 2px solid var(--bg-primary); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 1px var(--accent); pointer-events: auto; cursor: ew-resize; }
.memory-range-track input::-moz-range-track { height: 4px; background: transparent; }
.memory-range-track input::-moz-range-thumb { width: 10px; height: 10px; border: 2px solid var(--bg-primary); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 1px var(--accent); pointer-events: auto; cursor: ew-resize; }
.memory-range-track input:disabled::-webkit-slider-thumb, .memory-range-track input:disabled::-moz-range-thumb { cursor: default; opacity: .5; }
.memory-range-hint { margin-top: 2px; color: var(--text-secondary); font-size: 10px; }
.memory-list-card { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; }
.memory-list-heading { display: flex; justify-content: space-between; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--border); }
.memory-list-heading strong { font-size: 12px; }
.memory-list-heading span { color: var(--text-secondary); font-size: 11px; }
.memory-list { min-height: 0; overflow: auto; }
.memory-row { display: grid; grid-template-columns: minmax(104px, 145px) minmax(0, 1fr) auto; align-items: center; gap: 13px; width: 100%; min-height: 58px; padding: 10px 15px; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer; }
.memory-row:last-child { border-bottom: 0; }
.memory-row:hover, .memory-row.selected { background: var(--bg-primary); }
.memory-row.selected { box-shadow: inset 2px 0 var(--accent); }
.memory-row-date { color: var(--text-secondary); font-size: 11px; }
.memory-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.memory-row-kind { padding: 2px 7px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-secondary); font-size: 10px; }
.memory-detail-pane { overflow: auto; border-left: 1px solid var(--border); padding: 14px; min-width: 0; }
.memory-detail-title { margin: 0 0 10px; font-size: 14px; color: var(--text-primary); }
.memory-detail-meta { margin: 0 0 12px; display: grid; gap: 4px; font-size: 11px; color: var(--text-secondary); }
.memory-detail-meta div { display: flex; gap: 6px; }
.memory-detail-meta dt { min-width: 84px; }
.memory-detail-meta dd { margin: 0; }
.memory-detail-body { margin: 0 0 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-primary); }
.memory-detail-attachments { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; }
.memory-detail-attachments li { display: flex; gap: 6px; align-items: center; }
.memory-detail-actions { display: flex; gap: 8px; }
.memory-notice { margin: 0; padding: 8px 14px; color: var(--accent); border-top: 1px solid var(--border); }
.memory-confirm-copy { padding: 0 18px; color: var(--text-secondary); }

@media (max-width: 760px) {
  .memory-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(320px, 1fr) minmax(180px, 35%); }
  .memory-timeline-panel { padding: 12px; }
  .memory-timeline-heading { align-items: flex-start; flex-direction: column; }
  .memory-quick-ranges { flex-wrap: wrap; }
  .memory-detail-pane { border-top: 1px solid var(--border); border-left: 0; }
}

@media (max-width: 480px) {
  .memory-row { grid-template-columns: minmax(70px, 90px) minmax(0, 1fr); gap: 8px; padding: 9px; }
  .memory-row-kind { display: none; }
}
</style>
