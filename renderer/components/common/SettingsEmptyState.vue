<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'div' | 'p';
}>(), {
  as: 'div',
});
</script>

<template>
  <component :is="as" class="settings-empty"><slot /></component>
</template>

<style scoped>
.settings-empty {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  padding: var(--spacing-md);
  text-align: center;
}
</style>
