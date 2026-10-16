<script setup lang="ts">
/** FieldRow.vue — label and hint on the left, the control on the right. */
defineProps<{ label: string; hint?: string; for?: string }>();
</script>

<template>
  <div class="field-row">
    <label class="field-row__label" :for="$props.for">
      {{ label }}
      <small v-if="hint">{{ hint }}</small>
    </label>
    <div class="field-row__control"><slot /></div>
  </div>
</template>

<style scoped>
.field-row {
  display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 14px; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border);
}
.field-row:last-child { border-bottom: 0; }
.field-row__label { font-size: var(--font-size-md); color: var(--text-primary); }
.field-row__label small { display: block; font-size: 11px; color: var(--text-dim); }
.field-row__control { min-width: 0; display: flex; gap: var(--spacing-sm); align-items: center; flex-wrap: wrap; }
.field-row__control > :deep(input:not([type='checkbox'])),
.field-row__control > :deep(select),
.field-row__control > :deep(textarea) { flex: 1; min-width: 0; }
</style>
