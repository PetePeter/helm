<script setup lang="ts">
import { nextTick, type Component } from 'vue';
import type { DockSide, PaneId } from '../../dock-types.js';
import { getPaneDescriptor } from '../../dock-types.js';
import DockPane from './DockPane.vue';
import NewItemPulse from './NewItemPulse.vue';

const props = defineProps<{
  tabs: readonly PaneId[];
  activeTab: PaneId;
  focusedPaneId: PaneId | null;
  paneComponents: Readonly<Record<PaneId, Component>>;
  draggedPaneId?: PaneId | null;
}>();

const emit = defineEmits<{
  focus: [paneId: PaneId, focusedItemId?: string];
  activate: [paneId: PaneId];
  close: [paneId: PaneId];
  'drag-start': [paneId: PaneId, event: PointerEvent];
  'dock-edge': [paneId: PaneId, side: DockSide];
  reorder: [paneId: PaneId, index: number];
}>();

/** Keyboard equivalents of an outer-edge drag, for users who cannot drag. */
const EDGE_KEYS: Record<string, DockSide> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom',
};

const tabRefs = new Map<PaneId, HTMLElement>();

function titleFor(paneId: PaneId): string {
  return getPaneDescriptor(paneId)?.title ?? paneId;
}

function iconFor(paneId: PaneId): string {
  return getPaneDescriptor(paneId)?.icon ?? '';
}

/** Keyboard hints live on the descriptor and surface only as a tooltip. */
function tooltipFor(paneId: PaneId): string {
  const descriptor = getPaneDescriptor(paneId);
  if (!descriptor) return paneId;
  return descriptor.hint ? `${descriptor.title} — ${descriptor.hint}` : descriptor.title;
}

/** Middle-click closes a tab, matching every other tabbed surface. */
function onTabPointerDown(event: PointerEvent, paneId: PaneId): void {
  if (event.button === 1) {
    event.preventDefault();
    emit('close', paneId);
    return;
  }
  emit('drag-start', paneId, event);
}

function setTabRef(paneId: PaneId, element: Element | null): void {
  if (element instanceof HTMLElement) tabRefs.set(paneId, element);
  else tabRefs.delete(paneId);
}

function focusTab(paneId: PaneId): void {
  nextTick(() => tabRefs.get(paneId)?.focus());
}

function selectTab(paneId: PaneId): void {
  emit('activate', paneId);
  emit('focus', paneId, `tab:${paneId}`);
}

function onTabKey(event: KeyboardEvent, paneId: PaneId): void {
  const index = props.tabs.indexOf(paneId);

  // Ctrl+Shift+Arrow docks the pane to a workspace edge and Ctrl+Shift+PageUp/Down
  // reorders it — the keyboard equivalents of the two drag gestures. Checked
  // before plain arrow navigation so the modifier changes the meaning, not the target.
  if (event.ctrlKey && event.shiftKey) {
    const side = EDGE_KEYS[event.key];
    if (side) {
      event.preventDefault();
      emit('dock-edge', paneId, side);
      return;
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      emit('reorder', paneId, index + (event.key === 'PageDown' ? 1 : -1));
      focusTab(paneId);
      return;
    }
  }

  let nextIndex = -1;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % props.tabs.length;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + props.tabs.length) % props.tabs.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = props.tabs.length - 1;
  if (nextIndex >= 0) {
    event.preventDefault();
    const next = props.tabs[nextIndex];
    selectTab(next);
    focusTab(next);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectTab(paneId);
  }
}

function onPaneFocus(paneId: PaneId, focusedItemId?: string): void {
  emit('focus', paneId, focusedItemId);
}
</script>

<template>
  <section class="dock-tab-group" :data-dock-group-active="activeTab">
    <div class="dock-tabs" role="tablist" data-dock-tabs :aria-label="`${activeTab} tab group`">
      <div v-for="paneId in tabs" :key="paneId" class="dock-tab-entry" :data-dock-tab-id="paneId">
        <button
          :ref="(element) => setTabRef(paneId, element)"
          class="dock-tab"
          :class="{
            'dock-tab--active': paneId === activeTab,
            'dock-tab--focused': paneId === focusedPaneId,
            'dock-tab--dragging': paneId === draggedPaneId,
          }"
          type="button"
          role="tab"
          :id="`dock-tab-${paneId}`"
          :aria-controls="`dock-pane-${paneId}`"
          :aria-selected="paneId === activeTab"
          :tabindex="paneId === activeTab ? 0 : -1"
          :title="tooltipFor(paneId)"
          @pointerdown="onTabPointerDown($event, paneId)"
          @click="selectTab(paneId)"
          @keydown="onTabKey($event, paneId)"
        >
          <span class="dock-tab__icon" aria-hidden="true">{{ iconFor(paneId) }}</span>
          <span class="dock-tab__label">{{ titleFor(paneId) }}</span>
          <NewItemPulse :pane-id="paneId" />
        </button>
        <button
          class="dock-tab-close"
          type="button"
          :aria-label="`Close ${titleFor(paneId)} pane`"
          @click="emit('close', paneId)"
        >
          ×
        </button>
      </div>
    </div>
    <DockPane
      v-for="paneId in tabs"
      :key="`pane-${paneId}`"
      :pane-id="paneId"
      :active="paneId === activeTab"
      :focused="paneId === focusedPaneId"
      :component="paneComponents[paneId]"
      @focus="onPaneFocus"
    />
  </section>
</template>
