<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  icon?: string;
}>();
</script>

<template>
  <header class="panel-header">
    <div class="panel-header__bar">
      <div class="panel-header__identity">
        <span v-if="icon" class="panel-header__icon" aria-hidden="true">{{ icon }}</span>
        <h2>{{ title }}</h2>
        <slot name="subtitle">
          <span v-if="subtitle" class="panel-header__subtitle">{{ subtitle }}</span>
        </slot>
      </div>
      <div class="panel-header__spacer" aria-hidden="true"></div>
      <div v-if="$slots.actions" class="panel-header__actions">
        <slot name="actions" />
      </div>
    </div>
    <div v-if="$slots.toolbar" class="panel-header__toolbar">
      <slot name="toolbar" />
    </div>
  </header>
</template>

<style scoped>
.panel-header {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  flex: 0 0 auto;
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.panel-header__bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.panel-header__identity,
.panel-header__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.panel-header__identity h2 {
  color: var(--text-primary);
  font-size: var(--font-size-lg);
  line-height: 1.2;
}

.panel-header__icon {
  flex: 0 0 auto;
}

.panel-header__subtitle {
  overflow: hidden;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-header__spacer {
  flex: 1 1 auto;
}

.panel-header__actions {
  justify-content: flex-end;
}

.panel-header__toolbar {
  width: 100%;
}
</style>
