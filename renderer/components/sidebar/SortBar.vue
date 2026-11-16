<script setup lang="ts">
/**
 * SortBar.vue — Sort field dropdown + direction toggle.
 *
 * Replaces the legacy imperative sort control with a reactive Vue component.
 * Dropdown opens on click, closes on outside click
 * or selection.
 */
import { ref, onMounted, onUnmounted } from 'vue';

export interface SortOption {
  value: string;
  label: string;
}

const props = defineProps<{
  options: SortOption[];
  field: string;
  direction: 'asc' | 'desc';
}>();

const emit = defineEmits<{
  change: [field: string, direction: 'asc' | 'desc'];
}>();

const dropdownOpen = ref(false);
const barRef = ref<HTMLElement | null>(null);

function getFieldLabel(field: string): string {
  return props.options.find(o => o.value === field)?.label ?? field;
}

function selectField(value: string): void {
  dropdownOpen.value = false;
  emit('change', value, props.direction);
}

function toggleDirection(): void {
  dropdownOpen.value = false;
  const next = props.direction === 'asc' ? 'desc' : 'asc';
  emit('change', props.field, next);
}

function onOutsideClick(e: MouseEvent): void {
  if (barRef.value && !barRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', onOutsideClick));
onUnmounted(() => document.removeEventListener('click', onOutsideClick));
</script>

<template>
  <div ref="barRef" class="sort-control-bar">
    <span class="sort-control-label">Sort:</span>

    <button
      class="sort-field-btn focusable"
      :title="`Sort by: ${getFieldLabel(field)}`"
      @click.stop="dropdownOpen = !dropdownOpen"
    >
      ▼ {{ getFieldLabel(field) }}
    </button>

    <button
      class="sort-direction-btn focusable"
      :title="direction === 'asc' ? 'Ascending' : 'Descending'"
      @click.stop="toggleDirection"
    >
      {{ direction === 'asc' ? '↑' : '↓' }}
    </button>

    <div v-if="dropdownOpen" class="sort-dropdown">
      <button
        v-for="opt in options"
        :key="opt.value"
        class="sort-dropdown-option"
        :class="{ active: opt.value === field }"
        @click.stop="selectField(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Sort Controls */
.sort-control-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  flex: 0 0 auto;
}

.sort-control-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
}

.sort-field-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  padding: 2px 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.sort-field-btn:hover,
.sort-field-btn:focus {
  border-color: var(--accent);
  color: var(--text-primary);
  outline: none;
}

.sort-direction-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  cursor: pointer;
  min-width: 24px;
  text-align: center;
  transition: all 0.15s;
}

.sort-direction-btn:hover,
.sort-direction-btn:focus {
  border-color: var(--accent);
  color: var(--text-primary);
  outline: none;
}

.sort-dropdown {
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 6px;
  padding: 4px 0;
  z-index: 200;
  min-width: 120px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.sort-dropdown-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: #ccc;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  text-align: left;
}

.sort-dropdown-option:hover,
.sort-dropdown-option:focus {
  background: rgba(255, 255, 255, 0.1);
  outline: none;
}

.sort-dropdown-option.active {
  color: #4fc3f7;
}
</style>
