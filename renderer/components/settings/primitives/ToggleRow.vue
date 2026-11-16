<script setup lang="ts">
defineProps<{
  label: string;
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <label class="toggle-row">
    <span class="toggle-row__content">
      <span class="toggle-row__label">{{ label }}</span>
      <span v-if="$slots.hint" class="toggle-row__hint"><slot name="hint" /></span>
    </span>
    <input
      class="focusable"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
  </label>
</template>

<style scoped>
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.toggle-row__content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.toggle-row__hint {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.toggle-row input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}
</style>
