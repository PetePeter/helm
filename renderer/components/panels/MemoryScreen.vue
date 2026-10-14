<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ConfirmDialog from '../modals/ConfirmDialog.vue';
import MemoryDetailPopOutWindow from '../MemoryDetailPopOutWindow.vue';
import EmptyState from '../common/EmptyState.vue';
import PanelHeader from '../common/PanelHeader.vue';
import SearchField from '../common/SearchField.vue';
import { useAppStore } from '../../stores/app.js';
import { buildMemoryForestLayout } from '../../memories/memory-graph-layout.js';
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
  setGraphDepth,
} from '../../memories/memory-screen.js';

const appState = useAppStore().state;
const zoom = ref(1);
const pan = ref({ x: 0, y: 0 });
const pressed = ref(false);
const dragging = ref(false);
const dragStart = ref({ x: 0, y: 0, panX: 0, panY: 0 });
const exportScope = ref<'selected' | 'all'>('selected');

const layout = computed(() => memoryScreenState.forest
  ? buildMemoryForestLayout(memoryScreenState.forest, { zoom: zoom.value })
  : null);

const matchedIds = computed(() => new Set(memoryScreenState.matchedIds));

/**
 * While the filter box has text, only matches are drawn — and only links whose
 * both ends are drawn. Fading non-matches left the graph as noisy as before.
 */
const filtering = computed(() => memoryScreenState.searchQuery.trim().length > 0);
const visibleNodes = computed(() => (layout.value?.nodes ?? [])
  .filter((node) => !filtering.value || matchedIds.value.has(node.id)));
const visibleEdges = computed(() => {
  const all = layout.value?.edges ?? [];
  if (!filtering.value) return all;
  const shown = new Set(visibleNodes.value.map((node) => node.key));
  return all.filter((edge) => shown.has(edge.from) && shown.has(edge.to));
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

function nodeByKey(key: string) {
  return layout.value?.nodes.find((node) => node.key === key);
}

function onWheel(event: WheelEvent): void {
  zoom.value = Math.min(2.5, Math.max(.5, zoom.value * (event.deltaY < 0 ? 1.1 : .9)));
}

/**
 * Pan without eating clicks.
 *
 * The pointer is captured only once it has actually travelled past
 * DRAG_THRESHOLD, and the capture is released on pointerup. Capturing on every
 * pointerdown made the browser retarget the following click to the canvas, so
 * the node click/dblclick handlers never fired and nothing could be selected.
 */
const DRAG_THRESHOLD = 4;

function onPointerDown(event: PointerEvent): void {
  pressed.value = true;
  dragging.value = false;
  dragStart.value = { x: event.clientX, y: event.clientY, panX: pan.value.x, panY: pan.value.y };
}

function onPointerMove(event: PointerEvent): void {
  if (!pressed.value) return;
  const dx = event.clientX - dragStart.value.x;
  const dy = event.clientY - dragStart.value.y;
  if (!dragging.value) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragging.value = true;
    const target = event.currentTarget as HTMLElement;
    if (target.setPointerCapture) target.setPointerCapture(event.pointerId);
  }
  pan.value = { x: dragStart.value.panX + dx, y: dragStart.value.panY + dy };
}

function onPointerUp(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement | null;
  if (dragging.value && target?.releasePointerCapture) {
    try {
      target.releasePointerCapture(event.pointerId);
    } catch {
      // The capture may already be gone if the pointer left the window.
    }
  }
  pressed.value = false;
  dragging.value = false;
}
function resetViewport(): void { zoom.value = 1; pan.value = { x: 0, y: 0 }; }

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
          <label title="Depth used when exporting and expanding search results">Export depth
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
      <div class="memory-graph-panel">
        <div class="memory-graph-toolbar">
          <span>Read-only graph — click a node to read it</span>
          <span v-if="memoryScreenState.searchQuery" class="memory-search-count">{{ memoryScreenState.matchedIds.length }} match(es)</span>
          <button type="button" class="btn btn--secondary btn--sm" @click="resetViewport">Reset view</button>
          <button v-if="memoryScreenState.detail" type="button" class="btn btn--secondary btn--sm" @click="openDetail">Open detail</button>
        </div>
        <div
          class="memory-graph-canvas"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <svg v-if="layout && layout.nodes.length" :viewBox="`0 0 ${Math.max(900, (layout.graphDepth + 2) * 230)} 700`" role="img" aria-label="Memory graph">
            <defs>
              <!-- Edges are directed; without a head the picture reads as
                   undirected and hides which memory points at which. -->
              <marker
                id="memory-edge-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" class="memory-graph-arrow" />
              </marker>
            </defs>
            <g :transform="`translate(${pan.x} ${pan.y}) scale(${layout.zoom})`">
              <line
                v-for="edge in visibleEdges"
                :key="edge.from + '>' + edge.to"
                class="memory-graph-edge"
                marker-end="url(#memory-edge-arrow)"
                :x1="(nodeByKey(edge.from)?.x ?? 0) + 170"
                :y1="(nodeByKey(edge.from)?.y ?? 0) + 42"
                :x2="nodeByKey(edge.to)?.x ?? 0"
                :y2="(nodeByKey(edge.to)?.y ?? 0) + 42"
              />
              <g
                v-for="node in visibleNodes"
                :key="node.key"
                class="memory-graph-node"
                :class="{
                  selected: node.id === memoryScreenState.selectedId,
                  match: matchedIds.has(node.id),
                }"
                :transform="`translate(${node.x} ${node.y})`"
                @click.stop="void selectMemory(node.id)"
                @dblclick.stop="void selectMemory(node.id).then(openDetail)"
              >
                <rect width="170" height="84" rx="6" />
                <text x="10" y="26">{{ node.label.slice(0, 25) }}</text>
                <text x="10" y="52" class="memory-node-path">{{ node.id.slice(0, 8) }}</text>
              </g>
            </g>
          </svg>
          <EmptyState
            v-else-if="memoryScreenState.loading"
            title="Loading memories"
            hint="Retrieving session context…"
            loading
          />
          <EmptyState v-else title="No memories for this session." />
        </div>
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
        <EmptyState v-else title="Select a memory." hint="Click a node to read it here." />
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
.memory-controls, .memory-graph-toolbar { display: flex; align-items: center; gap: 10px; }
.memory-controls { width: 100%; }
.memory-graph-toolbar { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.memory-export-scope { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 12px; }
.memory-controls .search-field { flex: 1; min-width: 180px; }
.memory-controls input[type='number'] { width: 60px; }
.memory-workspace { display: grid; grid-template-columns: 1fr minmax(220px, 28%); min-height: 0; flex: 1; }
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
.memory-graph-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.memory-graph-toolbar { justify-content: space-between; color: var(--text-secondary); font-size: 12px; }
.memory-search-count { color: var(--text-secondary); }
.memory-graph-canvas { flex: 1; min-height: 260px; overflow: hidden; cursor: grab; touch-action: none; }
.memory-graph-canvas:active { cursor: grabbing; }
.memory-graph-canvas svg { display: block; width: 100%; height: 100%; min-height: 420px; }
.memory-graph-edge { stroke: var(--text-secondary); stroke-width: 2; opacity: .7; }
.memory-graph-node { cursor: pointer; }
.memory-graph-node rect { fill: var(--bg-secondary); stroke: var(--border); stroke-width: 2; }
.memory-graph-node.selected rect { stroke: var(--accent); }
.memory-graph-node.match rect { stroke: var(--accent); stroke-width: 3; }
.memory-graph-arrow { fill: var(--text-secondary); }
.memory-graph-node text { fill: var(--text-primary); font-size: 12px; pointer-events: none; }
.memory-graph-node .memory-node-status, .memory-graph-node .memory-node-path { fill: var(--text-secondary); font-size: 10px; }
.memory-notice { margin: 0; padding: 8px 14px; color: var(--accent); border-top: 1px solid var(--border); }
.memory-confirm-copy { padding: 0 18px; color: var(--text-secondary); }
</style>
