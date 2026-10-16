<script setup lang="ts">
/** SettingsCard.vue — a titled group of field rows. */
defineProps<{ title?: string }>();
</script>

<template>
  <section class="settings-card">
    <div v-if="title || $slots.actions" class="settings-card__head">
      <span class="settings-card__title">{{ title }}</span>
      <slot name="actions" />
    </div>
    <div class="settings-card__body"><slot /></div>
  </section>
</template>

<style scoped>
.settings-card__head { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 6px; }
.settings-card__title { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); }
.settings-card__body {
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: 10px; padding: 2px 14px;
}
</style>
