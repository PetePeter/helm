<script setup lang="ts">
/** Small accent-bordered count chip on a session row (unread chat, todos). */
defineProps<{
  /** The row is flashing: the chip follows its beat instead of staying a dark patch. */
  flashing?: boolean;
}>();
</script>

<template>
  <span class="count-chip" :class="{ 'count-chip--flashing': flashing }"><slot /></span>
</template>

<style scoped>
.count-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: 8px;
  font-size: 10px;
  color: var(--accent);
  flex-shrink: 0;
  white-space: nowrap;
}

.count-chip--flashing {
  background: transparent;
  border-color: currentColor;
}
</style>
