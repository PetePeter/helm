<script setup lang="ts">
defineProps<{ show: boolean }>();
</script>

<template>
  <span v-if="show" class="admin-only-hint" role="note">Admin only</span>
</template>

<style scoped>
.admin-only-hint {
  color: var(--text-dim);
  font: inherit;
  font-size: var(--font-size-sm);
}
</style>
