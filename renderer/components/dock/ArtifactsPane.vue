<script setup lang="ts">
/**
 * ArtifactsPane — the `artifacts` tool window.
 *
 * Always bound to the active session; the shell keeps `useArtifactViewer` in
 * step with `activeSessionId`, so the pane renders nothing when no session is
 * active rather than showing another session's reports.
 */
import ArtifactViewer from '../panels/ArtifactViewer.vue';
import { useAppStore } from '../../stores/app.js';
import { useHelmPaneContext } from '../../dock-pane-context.js';
import { useTimeActivity } from '../../composables/useTimeActivity.js';

const pane = useHelmPaneContext();
const state = useAppStore().state;
// Typing in a session's artifacts is the user's time on that session's project.
const timeActivity = useTimeActivity(() => (state.activeSessionId ? { sessionId: state.activeSessionId } : null));
</script>

<template>
  <div v-if="state.activeSessionId" class="artifacts-pane-input" @keydown="timeActivity.onKeydown">
    <ArtifactViewer
      :session-id="state.activeSessionId"
      @pop-out="pane.popOutArtifacts"
    />
  </div>
</template>

<style scoped>
/* Layout-neutral: only here to observe keystrokes for time tracking. */
.artifacts-pane-input { display: contents; }
</style>
