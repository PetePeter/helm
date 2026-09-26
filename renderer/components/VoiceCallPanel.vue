<script setup lang="ts">
/**
 * Floating "Helm" call panel — visible while a desktop voice call is open.
 * Shows the call phase, the latest error, and the recent shared operator
 * transcript (the phone shows the same exchange). Mount once in the main window.
 */
import { computed } from 'vue';
import { useVoiceCall } from '../composables/useVoiceCall.js';

const { inCall, phase, transcript, error, hangUp } = useVoiceCall();

const PHASE_LABELS = {
  idle: 'Hold to talk',
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  speaking: 'Helm is speaking…',
} as const;

const phaseLabel = computed(() => PHASE_LABELS[phase.value]);
const recentLines = computed(() => transcript.value.slice(-6));
</script>

<template>
  <div v-if="inCall" class="voice-call-panel" role="status" aria-live="polite">
    <div class="voice-call-panel__header">
      <span class="voice-call-panel__title">📞 Helm</span>
      <span class="voice-call-panel__phase" :class="`voice-call-panel__phase--${phase}`">{{ phaseLabel }}</span>
      <button class="btn voice-call-panel__hangup" title="Hang up" @click="hangUp">Hang up</button>
    </div>
    <ul class="voice-call-panel__transcript">
      <li v-for="(line, index) in recentLines" :key="index" :class="`voice-call-panel__line--${line.from}`">
        <strong>{{ line.from === 'you' ? 'You' : 'Helm' }}:</strong> {{ line.text }}
      </li>
    </ul>
    <div v-if="error" class="voice-call-panel__error">{{ error }}</div>
  </div>
</template>

<style scoped>
.voice-call-panel {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 900;
  width: 340px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.voice-call-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.voice-call-panel__title {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.voice-call-panel__phase {
  flex: 1;
  color: var(--text-secondary);
}

.voice-call-panel__phase--recording {
  color: var(--accent);
}

.voice-call-panel__transcript {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-call-panel__line--you {
  color: var(--text-secondary);
}

.voice-call-panel__error {
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
</style>
