<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'span' | 'button';
  tone?: 'accent' | 'ok' | 'warn' | 'error' | 'neutral';
  size?: 'md' | 'count';
  flashing?: boolean;
}>(), {
  as: 'span',
  tone: 'neutral',
  size: 'md',
  flashing: false,
});
</script>

<template>
  <component
    :is="as"
    class="badge"
    :type="as === 'button' ? 'button' : undefined"
    :class="[
      `badge--${tone}`,
      { 'badge--count': size === 'count' },
      { 'badge--flashing': flashing },
    ]"
  ><slot /></component>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 0;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 500;
  font-family: inherit;
  line-height: normal;
  flex-shrink: 0;
  white-space: nowrap;
}

.badge:where(button):not(:disabled) {
  cursor: pointer;
}

.badge--accent {
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
}

.badge--ok {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}

.badge--warn {
  background: color-mix(in srgb, var(--warning) 18%, transparent);
  color: var(--warning);
}

.badge--error {
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  color: var(--danger);
}

.badge--neutral {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.badge--count {
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 400;
  line-height: 1.2;
}

.badge--count.badge--accent {
  background: var(--bg-secondary);
  border-color: var(--accent);
}

.badge--flashing {
  background: transparent;
  border: 1px solid currentColor;
}
</style>
