<script setup lang="ts">
/**
 * SessionListTab.vue: Session List display settings (PTY preview density).
 */
import { computed } from 'vue';
import { sessionsState } from '../../screens/sessions-state.js';
import { setSessionPreviewMode } from '../../screens/sessions.js';
import { SESSION_PREVIEW_MODES, type SessionPreviewMode } from '../../session-groups.js';

const MODE_LABELS: Record<SessionPreviewMode, string> = {
  on: 'Every session',
  'selected-only': 'Selected session only',
  off: 'Off (compact rows)',
};

const mode = computed(() => sessionsState.groupPrefs.sessionPreviewMode ?? 'on');

function onChange(event: Event): void {
  void setSessionPreviewMode((event.target as HTMLSelectElement).value as SessionPreviewMode);
}
</script>

<template>
  <div class="settings-session-list-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Session List</span>
    </div>

    <div class="settings-help">
      <p><strong>Output preview</strong> shows the last 5 lines of each session's terminal under its row.
        It is read-only: clicking a row still just selects the session.</p>
    </div>

    <label class="session-list-setting">
      <span>Output preview</span>
      <select class="btn btn--secondary btn--sm focusable" :value="mode" @change="onChange">
        <option v-for="m in SESSION_PREVIEW_MODES" :key="m" :value="m">{{ MODE_LABELS[m] }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.session-list-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}
</style>
