<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import PanelHeader from '../common/PanelHeader.vue';
import { useAppStore } from '../../stores/app.js';
import { useTodosStore } from '../../stores/todos.js';

const appStore = useAppStore();
const todosStore = useTodosStore();
const sessionId = computed(() => appStore.state.activeSessionId);
const todos = computed(() => sessionId.value ? todosStore.todosFor(sessionId.value) : []);
const loadError = computed(() => sessionId.value ? todosStore.errorFor(sessionId.value) : '');
const loading = ref(false);

watch(sessionId, async id => {
  if (!id) return;
  loading.value = true;
  await todosStore.loadSession(id);
  loading.value = false;
}, { immediate: true });
</script>

<template>
  <section class="todos-pane" aria-label="Session todos">
    <PanelHeader title="Todos" icon="☑" :subtitle="appStore.activeSession?.name ?? 'No session selected'" />
    <EmptyState v-if="!sessionId" title="No session selected" hint="Select a session to view its todos." icon="☑" />
    <div v-else class="todos-pane__scroll" aria-live="polite">
      <EmptyState v-if="loading && !todos.length" title="Loading todos" loading />
      <EmptyState v-else-if="loadError" title="Could not load todos" :hint="loadError" icon="⚠️" />
      <EmptyState v-else-if="!todos.length" title="No todos" hint="The session's AI-managed checklist is empty." icon="☑" />
      <ol v-else class="todos-pane__list">
        <li
          v-for="todo in todos"
          :key="todo.id"
          class="todos-pane__item"
          :class="{ 'todos-pane__item--done': todo.status === 'done' }"
          :data-todo-id="todo.id"
        >{{ todo.text }}</li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.todos-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.todos-pane__scroll { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-sm) var(--spacing-md); }
.todos-pane__list { margin: 0; padding-left: 1.5rem; color: var(--text-primary); }
.todos-pane__item { padding: var(--spacing-xs) 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.todos-pane__item--done { color: var(--text-secondary); text-decoration: line-through; }
</style>
