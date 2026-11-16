<script setup lang="ts">
/**
 * Drag overlay — the landing-zone highlight and the cursor ghost.
 *
 * Purely presentational: every rectangle it draws already came from
 * `dock-drag.ts`, so the highlight cannot disagree with the committed drop.
 */
import { computed, type CSSProperties } from 'vue';
import type { DockPoint, DockRect } from '../../dock-drag.js';

const props = defineProps<{
  /** Workspace-local preview rect, or null when the pointer is over no valid drop. */
  rect: (DockRect & { kind: 'target' | 'reorder' | 'edge' }) | null;
  ghost: DockPoint | null;
  label: string;
}>();

function box(rect: DockRect): CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

const ghostStyle = computed<CSSProperties>(() => ({
  left: `${props.ghost?.x ?? 0}px`,
  top: `${props.ghost?.y ?? 0}px`,
}));
</script>

<template>
  <div class="dock-preview-layer" aria-hidden="true">
    <div
      v-if="rect"
      class="dock-preview"
      :class="`dock-preview--${rect.kind}`"
      :style="box(rect)"
      data-dock-preview
      :data-dock-preview-kind="rect.kind"
    />
    <div v-if="ghost" class="dock-drag-ghost" :style="ghostStyle" data-dock-drag-ghost>
      {{ label }}
    </div>
  </div>
</template>

<style scoped>
/* The overlay and ghost never intercept a pointer during a drag. */
.dock-preview-layer {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}
.dock-preview {
  position: absolute;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 1px solid var(--accent);
  transition: left 60ms ease, top 60ms ease, width 60ms ease, height 60ms ease;
}
.dock-preview--reorder { background: var(--accent); border: none; }
.dock-drag-ghost {
  position: absolute;
  padding: 3px 8px;
  color: var(--text-primary);
  font-size: 11px;
  white-space: nowrap;
  background: var(--bg-tertiary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm, 3px);
  transform: translate(10px, 10px);
  opacity: 0.92;
}
</style>
