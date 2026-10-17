<script setup lang="ts">
/**
 * MainView.vue — Right panel manager for terminal / plan views.
 *
 * Replaces main-view-manager.ts with a reactive component that switches
 * between two mutually exclusive views using v-show (terminal) and v-if
 * (plan) for appropriate lifecycle management.
 */
import { computed } from 'vue';

export type ViewMode = 'terminal' | 'plan';

const props = defineProps<{
  activeView: ViewMode;
}>();

const emit = defineEmits<{
  'update:activeView': [view: ViewMode];
}>();

const isTerminal = computed(() => props.activeView === 'terminal');
const isPlan = computed(() => props.activeView === 'plan');

function showTerminal(): void {
  emit('update:activeView', 'terminal');
}

function showPlan(): void {
  emit('update:activeView', 'plan');
}

defineExpose({ showTerminal, showPlan });
</script>

<template>
  <div class="main-view" id="mainArea">
    <div v-show="isTerminal" class="main-view-terminal" id="terminalContainer">
      <slot name="terminal" />
    </div>

    <div v-if="isPlan" class="main-view-plan">
      <slot name="plan" />
    </div>
  </div>
</template>
