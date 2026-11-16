<script setup lang="ts">
import { toRef } from 'vue';
import type { SplitDirection } from '../../dock-types.js';
import { useSplitResize } from '../../composables/usePanelResize.js';

const props = defineProps<{
  containerRef: HTMLElement | null;
  direction: SplitDirection;
  index: number;
  sizes: readonly number[];
  minSize?: number;
}>();

const emit = defineEmits<{
  resize: [sizes: number[]];
}>();

const containerRef = toRef(props, 'containerRef');
const { splitterRef, isDragging, onKeyDown } = useSplitResize({
  containerRef,
  direction: props.direction,
  index: props.index,
  getSizes: () => props.sizes,
  minSize: props.minSize,
  onResized: sizes => emit('resize', sizes),
});
</script>

<template>
  <button
    ref="splitterRef"
    class="dock-splitter"
    :class="{ 'dock-splitter--dragging': isDragging }"
    type="button"
    role="separator"
    :aria-orientation="direction"
    :aria-valuemin="1"
    :aria-valuemax="99"
    :aria-valuenow="Math.round((sizes[index] ?? 0) * 100)"
    :aria-label="`${direction} pane splitter`"
    @keydown="onKeyDown"
  />
</template>

<style scoped>
.dock-splitter {
  z-index: 2;
  width: 4px;
  height: 100%;
  padding: 0;
  cursor: col-resize;
  background: var(--border);
}
.dock-splitter:hover,
.dock-splitter:focus-visible,
.dock-splitter--dragging { background: var(--accent); outline: none; }
</style>
