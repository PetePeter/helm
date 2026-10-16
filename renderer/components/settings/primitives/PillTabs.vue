<script setup lang="ts">
/**
 * PillTabs.vue — sub-tabs as pills. Registered with SettingsScreen so LB/RB
 * cycle them.
 */
import { useSettingsSubTabs } from '../settings-panes.js';

const props = defineProps<{ tabs: ReadonlyArray<{ id: string; label: string }>; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

useSettingsSubTabs(() => props.tabs.map((tab) => tab.id), () => props.modelValue, (id) => emit('update:modelValue', id));
</script>

<template>
  <div class="pill-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="pill-tabs__tab focusable"
      :class="{ 'pill-tabs__tab--active': tab.id === modelValue }"
      role="tab"
      :aria-selected="String(tab.id === modelValue)"
      @click="emit('update:modelValue', tab.id)"
    >{{ tab.label }}</button>
  </div>
</template>

<style scoped>
.pill-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.pill-tabs__tab {
  padding: 5px 11px; border: 0; border-radius: 999px; background: transparent;
  color: var(--text-secondary); font: inherit; font-size: var(--font-size-sm); cursor: pointer;
}
.pill-tabs__tab:hover { background: var(--bg-hover); }
.pill-tabs__tab--active, .pill-tabs__tab--active:hover { background: var(--accent-tint); color: var(--accent); }
.pill-tabs__tab:focus { outline: none; box-shadow: var(--focus-ring); }
</style>
