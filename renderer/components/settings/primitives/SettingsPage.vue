<script setup lang="ts">
/**
 * SettingsPage.vue — one settings page: header (title, optional subtitle and
 * actions), body, and the footer with key hints and the autosave status.
 * `flush` hands the body to a page that lays out its own panes (MasterDetail);
 * otherwise the body is a single scrolling gamepad pane.
 */
import { computed } from 'vue';
import { settingsSaveState } from '../../../composables/useAutosave.js';
import SettingsPane from './SettingsPane.vue';

defineProps<{ title: string; subtitle?: string; flush?: boolean }>();

const saveLabel = computed(() => {
  switch (settingsSaveState.status) {
    case 'saving': return 'Saving…';
    case 'saved': return 'Saved';
    case 'error': return settingsSaveState.message || 'Not saved';
    default: return 'Changes save automatically';
  }
});
</script>

<template>
  <section class="settings-page">
    <header class="settings-page__header">
      <div class="settings-page__titles">
        <h2 class="settings-page__title">{{ title }}</h2>
        <span v-if="subtitle" class="settings-page__subtitle">{{ subtitle }}</span>
      </div>
      <div class="settings-page__actions"><slot name="actions" /></div>
    </header>
    <div v-if="flush" class="settings-page__body settings-page__body--flush"><slot /></div>
    <SettingsPane v-else class="settings-page__body">
      <div class="settings-page__column"><slot /></div>
    </SettingsPane>
    <footer class="settings-page__footer">
      <span><kbd>◀▶</kbd> pane</span>
      <span><kbd>▲▼</kbd> move</span>
      <span><kbd>A</kbd> select</span>
      <span><kbd>B</kbd> back</span>
      <span><kbd>LB</kbd><kbd>RB</kbd> tabs</span>
      <span
        class="settings-page__save"
        :class="`settings-page__save--${settingsSaveState.status}`"
        role="status"
      >{{ saveLabel }}</span>
    </footer>
  </section>
</template>

<style scoped>
.settings-page { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.settings-page__header {
  display: flex; align-items: center; gap: var(--spacing-md);
  padding: 14px 22px; border-bottom: 1px solid var(--border);
}
.settings-page__titles { display: flex; align-items: baseline; gap: var(--spacing-sm); flex: 1; min-width: 0; }
.settings-page__title { margin: 0; font-size: var(--font-size-lg); font-weight: 600; color: var(--text-primary); }
.settings-page__subtitle { font-size: var(--font-size-sm); color: var(--text-dim); }
.settings-page__actions { display: flex; gap: var(--spacing-sm); }
.settings-page__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--spacing-md) 22px; }
.settings-page__body--flush { display: flex; padding: 0; overflow: hidden; }
.settings-page__column { max-width: 860px; display: flex; flex-direction: column; gap: var(--spacing-md); }
.settings-page__footer {
  display: flex; gap: 14px; align-items: center;
  padding: 8px 22px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--text-dim);
}
.settings-page__footer kbd {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0 5px; margin-right: 3px; font: 10px var(--font-mono); color: var(--text-secondary);
}
.settings-page__save { margin-left: auto; }
.settings-page__save--saved { color: var(--accent); }
.settings-page__save--error { color: var(--danger); }
</style>
