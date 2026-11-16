<script setup lang="ts">
defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md';
}>(), {
  variant: 'primary',
  size: 'md',
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();
</script>

<template>
  <button
    type="button"
    class="app-button"
    :class="[`app-button--${variant}`, `app-button--${size}`]"
    v-bind="$attrs"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.app-button {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border: 0;
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-weight: 500;
  font-size: var(--font-size-md);
  line-height: normal;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.1s;
}

.app-button--sm {
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-sm);
}

.app-button:active:not(:disabled) {
  transform: scale(0.98);
}

.app-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.app-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.app-button--primary {
  background: var(--accent);
  color: var(--accent-contrast);
}

.app-button--primary:hover:not(:disabled),
.app-button--primary:focus-visible {
  background: var(--accent-hover);
}

.app-button--secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.app-button--secondary:hover:not(:disabled),
.app-button--secondary:focus-visible {
  background: var(--border);
}

.app-button--danger {
  border: 1px solid var(--danger-border);
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  color: var(--danger);
}

.app-button--danger:hover:not(:disabled),
.app-button--danger:focus-visible {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 30%, transparent);
}

.app-button--ghost {
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.app-button--ghost:hover:not(:disabled),
.app-button--ghost:focus-visible {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.app-button--success {
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
  border-radius: var(--radius-sm);
  padding: 6px 16px;
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
  font-size: var(--font-size-sm);
  transition: background 0.2s, border-color 0.2s;
}

.app-button--success:hover:not(:disabled),
.app-button--success:focus-visible {
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 30%, transparent);
}

.app-button--focused {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.app-button--danger.app-button--focused {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 30%, transparent);
}
</style>
