<script setup lang="ts">
const props = withDefaults(defineProps<{ title: string; level?: 3 | 4 }>(), { level: 3 });
</script>

<template>
  <header class="section-header">
    <component :is="`h${props.level}`" class="section-header__title">{{ props.title }}</component>
    <div v-if="$slots.actions" class="section-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.section-header__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.88rem;
}

.section-header__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: auto;
}
</style>
