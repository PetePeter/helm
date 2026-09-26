<script setup lang="ts">
/**
 * OperatorSection — the "Helm" section pinned above the session list; the
 * desktop twin of the phone's first tab. Shows the operator's activity dot and
 * last reply, opens its terminal on click, and hosts the voice call (hands-free
 * Call / Hang up, live phase and transcript). The operator never appears in the
 * regular list (see buildSessionGroups); it is the first gamepad nav item
 * instead (buildFlatNavList), so the D-pad reaches it like any session card.
 */
import { computed } from 'vue';
import { useAppStore } from '../../stores/app.js';
import { useVoiceCall } from '../../composables/useVoiceCall.js';
import { operatorSummary } from '../../operator-summary.js';
import { getActivityColor } from '../../state-colors.js';
import { useNavigationStore } from '../../stores/navigation.js';
import { sessionsState } from '../../screens/sessions-state.js';
import { isNavItemFocused } from '../../session-groups.js';

const emit = defineEmits<{ open: [sessionId: string] }>();

const state = useAppStore().state;
const navStore = useNavigationStore();
const { inCall, handsFree, phase, transcript, error, toggleCall, hangUp } = useVoiceCall();

const summary = computed(() => operatorSummary(state.sessions, state.sessionActivityLevels, transcript.value));
const isFocused = computed(() => summary.value.kind === 'on'
  && isNavItemFocused(sessionsState.activeFocus, navStore.focusedNavItem, 'operator', summary.value.id));
const isActive = computed(() => summary.value.kind === 'on' && state.activeSessionId === summary.value.id);
const dotColor = computed(() => getActivityColor(summary.value.kind === 'on' ? summary.value.activityLevel : 'idle'));

const PHASE_LABELS = {
  idle: 'Hold to talk',
  listening: 'Listening…',
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  speaking: 'Helm is speaking…',
} as const;

const phaseLabel = computed(() => PHASE_LABELS[phase.value]);
const recentLines = computed(() => transcript.value.slice(-6));

function onCallClick(): void {
  if (inCall.value && !handsFree.value) hangUp();
  else void toggleCall();
}
</script>

<template>
  <div
    class="operator-section"
    :class="{ 'operator-section--in-call': inCall, focused: isFocused, active: isActive }"
  >
    <div class="operator-section__header">
      <button
        class="operator-section__open focusable"
        type="button"
        :disabled="summary.kind === 'off'"
        title="Open the Helm operator"
        @click="summary.kind === 'on' && emit('open', summary.id)"
      >
        <span class="session-activity-dot" :style="{ background: dotColor }" />
        <span class="operator-section__title">Helm</span>
      </button>
      <span v-if="inCall" class="operator-section__phase" :class="`operator-section__phase--${phase}`" role="status" aria-live="polite">{{ phaseLabel }}</span>
      <button
        v-if="summary.kind === 'on' || inCall"
        class="btn btn--sm focusable"
        :class="inCall ? 'btn--danger' : 'btn--secondary'"
        type="button"
        @click="onCallClick"
      >{{ inCall ? 'Hang up' : 'Call' }}</button>
    </div>

    <div v-if="summary.kind === 'off'" class="operator-section__hint">Enable in Settings &gt; Operator</div>
    <ul v-else-if="inCall" class="operator-section__transcript">
      <li v-for="(line, index) in recentLines" :key="index" :class="`operator-section__line--${line.from}`">
        <strong>{{ line.from === 'you' ? 'You' : 'Helm' }}:</strong> {{ line.text }}
      </li>
    </ul>
    <div v-else-if="summary.lastReply" class="operator-section__reply" :title="summary.lastReply">{{ summary.lastReply }}</div>

    <div v-if="error" class="operator-section__error">{{ error }}</div>
  </div>
</template>

<style scoped>
.operator-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border: 1px solid transparent;
  border-bottom-color: var(--border);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

/* Same focus/active language as .session-card. */
.operator-section.focused { background: var(--bg-tertiary); }
.operator-section.active { border-color: var(--accent); background: var(--bg-secondary); }

.operator-section__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.operator-section__open {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.operator-section__open:disabled {
  cursor: default;
}

.operator-section__title {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.operator-section__phase {
  color: var(--text-secondary);
}

.operator-section__phase--listening,
.operator-section__phase--recording {
  color: var(--accent);
}

.operator-section__hint,
.operator-section__reply,
.operator-section__line--you,
.operator-section__error {
  color: var(--text-secondary);
}

.operator-section__reply {
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.operator-section__transcript {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
