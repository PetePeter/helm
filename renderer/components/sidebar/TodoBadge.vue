<script setup lang="ts">
/**
 * Session-row todo count chip with a hover/focus popover of the pending items.
 *
 * The popover is teleported to <body> with fixed coordinates: the session list
 * scrolls and clips, and a list of todos is taller than any row.
 */
import { computed, ref } from 'vue';
import type { SessionTodo } from '../../../src/types/todo.js';

const MAX_SHOWN = 8;

const props = defineProps<{ todos: readonly SessionTodo[] }>();

const position = ref<{ top: number; left: number } | null>(null);
const shown = computed(() => props.todos.slice(0, MAX_SHOWN));
const hiddenCount = computed(() => Math.max(0, props.todos.length - MAX_SHOWN));

function show(event: Event): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  position.value = { top: rect.bottom + 4, left: rect.left };
}

function hide(): void {
  position.value = null;
}
</script>

<template>
  <span
    v-if="todos.length"
    class="session-todo-count"
    tabindex="0"
    :aria-label="`${todos.length} todos left`"
    @mouseenter="show"
    @focus="show"
    @mouseleave="hide"
    @blur="hide"
  >{{ todos.length }}</span>
  <Teleport v-if="position" to="body">
    <div
      class="todo-badge__popover"
      role="tooltip"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <div class="todo-badge__heading">Todos</div>
      <div v-for="item in shown" :key="item.id" class="todo-badge__item">
        <template v-if="item.status === 'waiting'">⏸ </template>{{ item.text }}
      </div>
      <div v-if="hiddenCount" class="todo-badge__more">+{{ hiddenCount }} more</div>
    </div>
  </Teleport>
</template>

<style scoped>
.todo-badge__popover {
  position: fixed;
  z-index: 50;
  max-width: 320px;
  padding: 5px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  pointer-events: none;
}
.todo-badge__heading {
  padding: 2px 6px 4px;
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.todo-badge__item {
  padding: 3px 6px;
  font-size: 12px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.todo-badge__more {
  padding: 3px 6px;
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
