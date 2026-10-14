<script setup lang="ts">
import type { PaneId } from '../../dock-types.js';
import { panePulses } from '../../composables/useNewItemPulse.js';

defineProps<{ paneId: PaneId }>();
</script>

<template>
  <span v-for="id in panePulses(paneId)" :key="id" class="dock-new-item-pulse" aria-hidden="true">+1</span>
</template>
