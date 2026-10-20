<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import FilterChip from '../common/FilterChip.vue';
import EmptyState from '../common/EmptyState.vue';
import { useAppStore } from '../../stores/app.js';
import { useTodosStore } from '../../stores/todos.js';
import { registerFilterPreference } from '../../stores/filter-preferences.js';
import type { FilterPreferenceState } from '../../../src/types/filter-preference.js';

const appStore = useAppStore();
const todosStore = useTodosStore();
const sessionId = computed(() => appStore.state.activeSessionId);
const todos = computed(() => sessionId.value ? todosStore.todosFor(sessionId.value) : []);
const loadError = computed(() => sessionId.value ? todosStore.errorFor(sessionId.value) : '');
const loading = ref(false);
const donePreference = registerFilterPreference<FilterPreferenceState>(
  'todo.done',
  'either',
  value => value === 'yes' || value === 'no' || value === 'either' ? value : 'either',
  { persistOnChange: false },
);
const doneFilter = donePreference.value;
function updateDoneFilter(value: FilterPreferenceState): void {
  doneFilter.value = value;
  void donePreference.persist();
}
const visibleTodos = computed(() => todos.value.filter(t =>
  doneFilter.value === 'either' || (t.status === 'done') === (doneFilter.value === 'yes')));

watch(sessionId, async id => {
  if (!id) return;
  loading.value = true;
  await todosStore.loadSession(id);
  loading.value = false;
}, { immediate: true });
</script>

<template>
  <section class="todos-pane" aria-label="Session todos">
    <EmptyState v-if="!sessionId" title="No session selected" hint="Select a session to view its todos." icon="☑" />
    <div v-if="sessionId" class="todos-pane__filters">
      <FilterChip :state="doneFilter" label="Done" @update:state="updateDoneFilter" />
    </div>
    <div v-if="sessionId" class="todos-pane__scroll" aria-live="polite">
      <EmptyState v-if="loading && !todos.length" title="Loading todos" loading />
      <EmptyState v-else-if="loadError" title="Could not load todos" :hint="loadError" icon="⚠️" />
      <EmptyState v-else-if="!todos.length" title="No todos" hint="The session's AI-managed checklist is empty." icon="☑" />
      <ol v-else class="todos-pane__list">
        <li
          v-for="todo in visibleTodos"
          :key="todo.id"
          class="todos-pane__item"
          :class="{ 'todos-pane__item--done': todo.status === 'done', 'todos-pane__item--waiting': todo.status === 'waiting' }"
          :data-todo-id="todo.id"
          :title="todo.status === 'waiting' ? 'Waiting on you' : undefined"
        >{{ todo.status === 'waiting' ? '⏳ ' : '' }}{{ todo.text }}</li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.todos-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.todos-pane__filters { display: flex; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md) 0; }
.todos-pane__scroll { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-sm) var(--spacing-md); }
.todos-pane__list { margin: 0; padding-left: 1.5rem; color: var(--text-primary); }
.todos-pane__item { padding: var(--spacing-xs) 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.todos-pane__item--waiting { color: var(--text-secondary); }
.todos-pane__item--done { color: var(--text-secondary); text-decoration: line-through; }
</style>
