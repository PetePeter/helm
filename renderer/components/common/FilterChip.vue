<script setup lang="ts">
import type { FilterPreferenceState } from '../../../src/types/filter-preference.js';

type FilterState = FilterPreferenceState;

const props = defineProps<{
  state: FilterState;
  label: string;
}>();

const emit = defineEmits<{
  (event: 'update:state', next: FilterState): void;
}>();

function nextState(state: FilterState): FilterState {
  if (state === 'either') return 'yes';
  if (state === 'yes') return 'no';
  return 'either';
}

function stateText(state: FilterState): string {
  if (state === 'yes') return 'Yes';
  if (state === 'no') return 'No';
  return 'Any';
}

function ariaPressed(state: FilterState): string {
  if (state === 'yes') return 'true';
  if (state === 'no') return 'false';
  return 'mixed';
}

function toggle(): void {
  emit('update:state', nextState(props.state));
}
</script>

<template>
  <button
    type="button"
    class="filter-chip"
    :class="`filter-chip--${state}`"
    :aria-pressed="ariaPressed(state)"
    @click="toggle"
  >
    <span class="filter-chip__label">{{ label }}</span>
    <span class="filter-chip__state">{{ stateText(state) }}</span>
  </button>
</template>

<style scoped>
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-height: 24px;
  padding: 2px var(--spacing-sm);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.filter-chip:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.filter-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}

.filter-chip--yes {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-secondary));
  color: var(--accent);
}

.filter-chip--no {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, var(--bg-secondary));
  color: var(--danger);
}

.filter-chip__state {
  font-weight: 700;
}
</style>
