<script setup lang="ts" generic="T extends string">
/**
 * A split button: the primary half runs the common action, the ▾ half opens a
 * menu of the individual ones. Used by the Plans header for Add and Clear.
 */
import { ref } from 'vue';

defineProps<{
  label: string;
  items: { value: T; label: string; detail?: string }[];
}>();

const emit = defineEmits<{
  primary: [];
  select: [value: T];
}>();

const open = ref(false);

function toggleMenu(): void {
  open.value = !open.value;
}

function onPrimary(): void {
  emit('primary');
  open.value = false;
}

function onSelect(value: T): void {
  emit('select', value);
  open.value = false;
}
</script>

<template>
  <div class="split-action">
    <button class="split-action__primary" @click="onPrimary">{{ label }}</button>
    <button class="split-action__toggle" @click="toggleMenu">▾</button>
    <div v-if="open" class="split-action__menu">
      <button v-for="item in items" :key="item.value" class="split-action__item" @click="onSelect(item.value)">
        {{ item.label }}
        <span v-if="item.detail" class="split-action__detail">{{ item.detail }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.split-action {
  position: relative;
  display: inline-flex;
  align-items: stretch;
}

.split-action__primary,
.split-action__toggle {
  background: #1a1a1a;
  border: 1px solid #333;
  color: #ccc;
  height: 30px;
}

.split-action__primary {
  border-radius: 4px 0 0 4px;
  padding: 0 10px;
}

.split-action__toggle {
  border-left: none;
  border-radius: 0 4px 4px 0;
  padding: 0 8px;
  min-width: 28px;
}

.split-action__primary:focus-visible,
.split-action__toggle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.split-action__primary:hover,
.split-action__toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.split-action__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 140px;
  background: #151515;
  border: 1px solid #333;
  border-radius: 6px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  z-index: 20;
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.split-action__item {
  text-align: left;
  padding: 8px 10px;
  border-radius: 4px;
  color: #ddd;
}

.split-action__detail {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #888;
}

.split-action__item:hover {
  background: #232323;
}
</style>
