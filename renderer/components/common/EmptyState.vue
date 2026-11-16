<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  hint?: string;
  icon?: string;
  loading?: boolean;
  compact?: boolean;
}>(), {
  loading: false,
  compact: false,
});
</script>

<template>
  <div
    class="empty-state"
    :class="{
      'empty-state--loading': loading,
      'empty-state--compact': compact,
    }"
    :role="loading ? 'status' : undefined"
    :aria-busy="loading ? 'true' : undefined"
  >
    <template v-if="loading">
      <span class="empty-state__spinner" aria-hidden="true"></span>
      <div class="empty-state__content">
        <h3>{{ title }}</h3>
        <p v-if="hint">{{ hint }}</p>
      </div>
    </template>
    <template v-else>
      <span v-if="icon" class="empty-state__icon" aria-hidden="true">{{ icon }}</span>
      <div class="empty-state__content">
        <h3>{{ title }}</h3>
        <p v-if="hint">{{ hint }}</p>
        <div v-if="$slots.action" class="empty-state__action">
          <slot name="action" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  min-height: 160px;
  padding: var(--spacing-lg);
  color: var(--text-secondary);
  text-align: center;
}

.empty-state--compact {
  min-height: 0;
  padding: var(--spacing-sm);
  gap: var(--spacing-sm);
}

.empty-state__icon {
  flex: 0 0 auto;
  font-size: var(--font-size-2xl);
}

.empty-state__spinner {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 999px;
  animation: empty-state-spin 0.8s linear infinite;
}

.empty-state__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  align-items: center;
}

.empty-state h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-lg);
}

.empty-state p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.empty-state--compact h3 {
  font-size: var(--font-size-sm);
}

.empty-state__action {
  margin-top: var(--spacing-sm);
}

.empty-state--compact .empty-state__action {
  margin-top: var(--spacing-xs);
}

@keyframes empty-state-spin {
  to { transform: rotate(360deg); }
}
</style>
