<script setup lang="ts">
import type { PaneId } from '../../dock-types.js';
import { panePulses } from '../../composables/useNewItemPulse.js';

defineProps<{ paneId: PaneId }>();
</script>

<template>
  <span v-for="id in panePulses(paneId)" :key="id" class="dock-new-item-pulse" aria-hidden="true">+1</span>
</template>

<style scoped>
/* Floats up and fades over NEW_ITEM_PULSE_MS; never takes the pointer. */
.dock-new-item-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  pointer-events: none;
  animation: dock-new-item-pulse 1.2s ease-out forwards;
}
@keyframes dock-new-item-pulse {
  0% { opacity: 0; transform: translateY(4px) scale(0.8); }
  15% { opacity: 1; transform: translateY(0) scale(1.15); }
  100% { opacity: 0; transform: translateY(-10px) scale(1); }
}
</style>
