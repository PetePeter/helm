<script setup lang="ts">
import { computed, markRaw, ref, toRaw, type Component } from 'vue';
import type { DockMode, DockNodePath, DockSide, DockWorkspaceLayout, DropTarget, PaneId } from '../../dock-types.js';
import { getPaneDescriptor } from '../../dock-types.js';
import { canDockPaneToEdge, canDropPane, canReorderTab, projectVisibleLayout, resizeVisibleSplit } from '../../dock-layout.js';
import { DOCK_PANE_COMPONENTS, DYNAMIC_DOCK_PANE_COMPONENTS, registeredDockPaneIds } from '../../dock-pane-registry.js';
import { useDockDrag } from '../../composables/useDockDrag.js';
import type { DockDragSurface, DockDropResolution, DockRect } from '../../dock-drag.js';
import DockNode from './DockNode.vue';
import DockPreview from './DockPreview.vue';

const props = defineProps<{
  layout: DockWorkspaceLayout;
  focusedPaneId: PaneId | null;
  paneComponents?: Readonly<Partial<Record<PaneId, Component>>>;
  revealedPaneIds?: readonly PaneId[];
}>();

const emit = defineEmits<{
  'focus-pane': [paneId: PaneId, focusedItemId?: string];
  'activate-pane': [paneId: PaneId];
  'close-pane': [paneId: PaneId];
  'resize-split': [path: DockNodePath, sizes: number[]];
  'reveal-pane': [paneId: PaneId];
  'autohide-close': [paneId: PaneId];
  'set-dock-mode': [paneId: PaneId, mode: DockMode];
  'move-pane': [paneId: PaneId, target: DropTarget];
  'reorder-tab': [paneId: PaneId, index: number];
  'dock-pane-edge': [paneId: PaneId, side: DockSide];
}>();

const rootRef = ref<HTMLElement | null>(null);

const resolvedPaneComponents = computed(() => {
  const components = Object.entries({
    ...DOCK_PANE_COMPONENTS,
    ...Object.fromEntries(DYNAMIC_DOCK_PANE_COMPONENTS),
    ...(props.paneComponents ?? {}),
  }).filter((entry): entry is [string, Component] => entry[1] !== undefined);
  return Object.fromEntries(components.map(([paneId, component]) => [paneId, markRaw(toRaw(component))]));
});

const visibleLayout = computed(() => {
  const registered = new Set(registeredDockPaneIds());
  return projectVisibleLayout(props.layout, registered);
});

function onResizeSplit(viewPath: DockNodePath, visibleSizes: number[]): void {
  const resized = resizeVisibleSplit(props.layout, visibleLayout.value, viewPath, visibleSizes);
  if (resized) emit('resize-split', resized.sourcePath, resized.sizes);
}

function measure(element: Element): DockRect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/**
 * Measure the live groups once per drag. Reading the DOM here rather than
 * deriving rectangles from the tree is deliberate: the browser already owns the
 * true geometry, including collapsed rails and minmax tracks.
 */
function surfaces(): DockDragSurface[] {
  const root = rootRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('[data-dock-group-active]')).map(group => {
    const strip = group.querySelector<HTMLElement>('[data-dock-tabs]');
    return {
      paneId: group.dataset.dockGroupActive as PaneId,
      rect: measure(group),
      tabStrip: strip
        ? {
          rect: measure(strip),
          tabs: Array.from(strip.querySelectorAll<HTMLElement>('[data-dock-tab-id]'))
            .map(tab => ({ paneId: tab.dataset.dockTabId as PaneId, rect: measure(tab) })),
        }
        : undefined,
    };
  });
}

function workspaceRect(): DockRect | null {
  return rootRef.value ? measure(rootRef.value) : null;
}

/** The model decides validity, so an impossible drop is never highlighted. */
function canDrop(paneId: PaneId, resolution: DockDropResolution): boolean {
  if (resolution.kind === 'reorder') return canReorderTab(props.layout, paneId, resolution.index);
  if (resolution.kind === 'edge') return canDockPaneToEdge(props.layout, paneId, resolution.side);
  return canDropPane(props.layout, paneId, { paneId: resolution.paneId, zone: resolution.zone });
}

const drag = useDockDrag({
  surfaces,
  workspaceRect,
  canDrop,
  onMove: (paneId, target) => emit('move-pane', paneId, target),
  onReorder: (paneId, index) => emit('reorder-tab', paneId, index),
  onDockEdge: (paneId, side) => emit('dock-pane-edge', paneId, side),
});

const ghostLabel = computed(() => {
  const paneId = drag.draggedPaneId.value;
  return paneId ? getPaneDescriptor(paneId)?.title ?? paneId : '';
});
</script>

<template>
  <div ref="rootRef" class="dock-workspace" :class="{ 'dock-workspace--dragging': drag.dragging.value }" data-dock-workspace>
    <DockNode
      :node="visibleLayout.layout.root"
      :path="[]"
      :focused-pane-id="focusedPaneId"
      :pane-components="resolvedPaneComponents"
      :revealed-pane-ids="revealedPaneIds ?? []"
      :dragged-pane-id="drag.dragging.value ? drag.draggedPaneId.value : null"
      @focus-pane="(...args) => emit('focus-pane', ...args)"
      @activate-pane="(paneId) => emit('activate-pane', paneId)"
      @close-pane="(paneId) => emit('close-pane', paneId)"
      @resize-split="onResizeSplit"
      @reveal-pane="(paneId) => emit('reveal-pane', paneId)"
      @autohide-close="(paneId) => emit('autohide-close', paneId)"
      @set-dock-mode="(...args) => emit('set-dock-mode', ...args)"
      @drag-start="drag.start"
      @dock-edge="(paneId, side) => emit('dock-pane-edge', paneId, side)"
      @reorder-tab="(paneId, index) => emit('reorder-tab', paneId, index)"
    />
    <DockPreview
      v-if="drag.dragging.value"
      :rect="drag.preview.value"
      :ghost="drag.ghost.value"
      :label="ghostLabel"
    />
  </div>
</template>
