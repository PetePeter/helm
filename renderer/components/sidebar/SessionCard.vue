<script setup lang="ts">
/**
 * SessionCard.vue — Single session card with activity dot, state, badges, timer, rename.
 *
 * Reactive sidebar row for one terminal session. Props drive all rendering
 * and events route session commands through sidebar services.
 */
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { getActivityColor } from '../../state-colors.js';
import NotificationCarousel from './NotificationCarousel.vue';
import { useRuntimeGroups } from '../../composables/useRuntimeGroups.js';
import { useSessionDrag } from '../../composables/useSessionDrag.js';
import { formatHelmRef } from '../../lib/helm-ref.js';
import { getCliDisplayName } from '../../utils.js';

// --- Types ---

export interface SessionCardSession {
  id: string;
  name: string;
  cliType: string;
  title?: string;
  cliSessionName?: string;
  /** Epoch ms when the session was first spawned. */
  createdAt?: number;
  /** Epoch ms when the activity dot last left green. */
  lastActiveAt?: number;
  /** Remote Fleet peer that created this session, when spawned over the peer proxy. */
  createdByPeerId?: string;
  locked?: boolean;
}

export type SessionCardFocusColumn = 0 | 1 | 2 | 3 | 4 | 5;

export interface SessionCardProps {
  session: SessionCardSession;
  navIndex: number;
  sessionState: string;
  activityLevel: string;
  displayName: string;
  draftCount: number;
  artifactCount: number;
  /** G8: consecutive Stop-hook auto-continues in flight. 0 = no active loop. */
  loopContinues: number;
  elapsedText: string;
  workingPlanLabel: string;
  workingPlanTooltip: string;
  isActive: boolean;
  isFocused: boolean;
  focusColumn: SessionCardFocusColumn;
  isEditing: boolean;
  isHiddenFromOverview: boolean;
  scheduledAt?: string | null;
  isSnappedOut?: boolean;
  llmNotifications?: Array<{ id: string; title: string; content: string; createdAt?: number }>;
  flashEntry?: { accentColor: string | null; textColor: string | null; phase: 'pulse' | 'solid' } | null;
  shortcutKey?: number | null;
}

// --- Constants ---

const STATE_LABELS: Record<string, string> = {
  implementing: '🔨 Implementing',
  waiting: '⏳ Waiting',
  planning: '🧠 Planning',
  completed: '🎉 Completed',
  idle: '💤 Idle',
};

const STATES = ['implementing', 'waiting', 'planning', 'completed', 'idle'];

// --- Props & Emits ---

const props = defineProps<SessionCardProps>();

const emit = defineEmits<{
  click: [sessionId: string];
  rename: [sessionId: string];
  commitRename: [sessionId: string, newName: string];
  cancelRename: [];
  close: [sessionId: string, displayName: string];
  stateChange: [sessionId: string, newState: string];
  toggleOverview: [sessionId: string];
  toggleLock: [sessionId: string, locked: boolean];
  showArtifacts: [sessionId: string];
  cancelSchedule: [sessionId: string];
  dismissNotification: [notificationId: string];
  dismissSessionNotifications: [sessionId: string];
}>();

// --- Timer tooltip: clarify the ambiguous elapsed label with absolute times ---

function formatClockTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

const timerTooltip = computed(() => {
  const created = formatClockTime(props.session.createdAt);
  const lastActive = props.activityLevel === 'active'
    ? 'now (active)'
    : formatClockTime(props.session.lastActiveAt);
  return `Time since last output\nCreated: ${created}\nLast active: ${lastActive}`;
});

// --- Local state ---

const cardEl = ref<HTMLDivElement | null>(null);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
const showStateDropdown = ref(false);

const openDropdown = () => { showStateDropdown.value = true; };
const closeDropdown = () => { showStateDropdown.value = false; };

onMounted(() => {
  cardEl.value?.addEventListener('open-state-dropdown', openDropdown);
  cardEl.value?.addEventListener('close-state-dropdown', closeDropdown);
});

onUnmounted(() => {
  cardEl.value?.removeEventListener('open-state-dropdown', openDropdown);
  cardEl.value?.removeEventListener('close-state-dropdown', closeDropdown);
});

// Auto-focus rename input when editing begins
watch(() => props.isEditing, async (editing) => {
  if (editing) {
    renameValue.value = props.session.name;
    await nextTick();
    renameInput.value?.focus();
    renameInput.value?.select();
  }
}, { immediate: true });

// --- Computed ---

const dotColor = computed(() => getActivityColor(props.activityLevel));

// Flash-attention: pulse (beating) or solid (steady accent) until focused.
const flashClass = computed(() => {
  if (!props.flashEntry) return '';
  return props.flashEntry.phase === 'solid' ? 'flash-solid' : 'flash-pulse';
});
const flashStyle = computed<Record<string, string>>(() => {
  const entry = props.flashEntry;
  if (!entry) return {};
  return {
    '--flash-accent': entry.accentColor ?? 'var(--accent)',
    '--flash-text': entry.textColor ?? 'var(--accent-contrast)',
  };
});
// Sessions opened here by a remote Helm peer are tinted so their origin is
// obvious on the machine actually running them.
const isPeerCreated = computed(() => !!props.session.createdByPeerId);
const peerTitle = computed(() =>
  props.session.createdByPeerId ? `Opened by peer: ${props.session.createdByPeerId}` : undefined,
);
const stateLabel = computed(() => STATE_LABELS[props.sessionState] || '💤 Idle');
const eyeIcon = computed(() => props.isHiddenFromOverview ? '👁‍🗨' : '👁');
const eyeTitle = computed(() => props.isHiddenFromOverview ? 'Show in overview' : 'Hide from overview');
const metaText = computed(() => {
  const title = props.session.title?.trim();
  return title && title !== props.displayName ? title : '';
});

// --- Runtime group badge + drag ---

const { groups: runtimeGroups } = useRuntimeGroups();
const { beginDrag, endDrag } = useSessionDrag();

/**
 * The runtime group this session belongs to (null when ungrouped). Drives the
 * `grouped` card class and drag behaviour — the card sits under its group header,
 * so it deliberately does NOT render a redundant group badge.
 */
const runtimeGroup = computed(() =>
  runtimeGroups.value.find(g => g.sessionIds.includes(props.session.id)) ?? null,
);

const isDragging = ref(false);

function onDragStart(e: DragEvent): void {
  beginDrag(props.session.id);
  isDragging.value = true;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', props.session.id);
  }
}

function onDragEnd(): void {
  endDrag();
  isDragging.value = false;
}

// Column focus helpers
function colClass(col: number): string {
  return props.isFocused && props.focusColumn === col ? 'card-col-focused' : '';
}

// --- Clipboard copy-id ---

const copied = ref(false);
const sessionRef = computed(
  () => formatHelmRef('session', { label: props.session.name, meta: getCliDisplayName(props.session.cliType), id: props.session.id }),
);

async function copyId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionRef.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    console.warn('[SessionCard] clipboard write failed');
  }
}

// --- Handlers ---

function onRenameKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    emit('commitRename', props.session.id, renameValue.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('cancelRename');
  }
}

function selectState(s: string): void {
  showStateDropdown.value = false;
  emit('stateChange', props.session.id, s);
}

function onCardClick(e: MouseEvent): void {
  const sessionId = (e.currentTarget as HTMLElement).getAttribute('data-session-id');
  if (sessionId) {
    emit('click', sessionId);
  }
}

</script>

<template>
  <div
    ref="cardEl"
    class="session-card"
    :class="[{ active: isActive, focused: isFocused, 'snapped-out': isSnappedOut, dragging: isDragging, grouped: !!runtimeGroup, 'peer-created': isPeerCreated }, flashClass]"
    :style="flashStyle"
    :title="peerTitle"
    :data-session-id="session.id"
    :data-nav-index="navIndex"
    :draggable="!isEditing"
    @click="onCardClick"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <!-- Line 1: top row -->
    <div class="session-top-row">
      <span class="session-activity-dot" :style="{ background: dotColor }" />
      <span v-if="isSnappedOut" class="snap-indicator" title="Snapped out">📤</span>

      <button
        class="session-state-btn"
        :class="colClass(1)"
        @click.stop="showStateDropdown = !showStateDropdown"
      >
        {{ stateLabel }}
      </button>

      <!-- State dropdown -->
      <div v-if="showStateDropdown" class="session-state-dropdown">
        <button
          v-for="s in STATES"
          :key="s"
          class="session-state-option"
          :class="{ active: s === sessionState }"
          @click.stop="selectState(s)"
        >
          {{ STATE_LABELS[s] || s }}
        </button>
      </div>

      <!-- Draft badge -->
      <span v-if="draftCount > 0" class="draft-badge">📝{{ draftCount }}</span>

      <!-- G8 loop badge — an in-progress auto-continue loop must never be invisible -->
      <span
        v-if="loopContinues > 0"
        class="loop-badge"
        title="Loop driving: consecutive Stop-hook auto-continues in flight. A user prompt or the kill switch ends it."
      >🔁{{ loopContinues }}</span>

      <!-- Artifact badge — click to show this session's artifact panel -->
      <button
        v-if="artifactCount > 0"
        class="artifact-badge"
        type="button"
        :title="`Show ${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`"
        @click.stop="emit('showArtifacts', session.id)"
      >📄{{ artifactCount }}</button>

      <span style="flex: 1" />

      <span class="session-timer" :title="timerTooltip">{{ elapsedText }}</span>

      <!-- Copy session id button -->
      <button
        class="session-copy-id"
        :title="copied ? 'Copied!' : 'Copy session id'"
        @click.stop="copyId"
      >
        {{ copied ? '✓' : '🔗' }}
      </button>

      <!-- Rename button (hidden when editing) -->
      <button
        v-if="!isEditing"
        class="session-rename"
        :class="colClass(2)"
        title="Rename session"
        @click.stop="emit('rename', session.id)"
      >
        ✎
      </button>

      <!-- Eye toggle -->
      <button
        class="session-overview-toggle"
        :class="colClass(3)"
        :title="eyeTitle"
        @click.stop="emit('toggleOverview', session.id)"
      >
        {{ eyeIcon }}
      </button>

      <!-- Lock toggle — sits beside the button it guards. -->
      <button
        class="session-lock"
        :class="[colClass(5), { 'session-lock--on': session.locked }]"
        :title="session.locked ? `${displayName} is locked — click to unlock` : `Lock ${displayName} against closure`"
        @click.stop="emit('toggleLock', session.id, !session.locked)"
      >
        {{ session.locked ? '🔒' : '🔓' }}
      </button>

      <!-- Close button -->
      <button
        class="session-close"
        :class="colClass(4)"
        :title="session.locked ? `${displayName} is locked` : `Close ${displayName}`"
        :disabled="session.locked"
        @click.stop="emit('close', session.id, displayName)"
      >
        ✕
      </button>
    </div>

    <!-- Line 2: session identity and CLI-produced terminal title -->
    <div class="session-name-line">
      <template v-if="isEditing">
        <input
          ref="renameInput"
          v-model="renameValue"
          class="session-rename-input"
          type="text"
          maxlength="50"
          placeholder="Enter name..."
          @keydown="onRenameKeydown"
        />
        <button class="session-rename-save" title="Save (Enter)" @click.stop="emit('commitRename', session.id, renameValue)">✓</button>
        <button class="session-rename-cancel" title="Cancel (Escape)" @click.stop="emit('cancelRename')">×</button>
      </template>
      <template v-else>
        <span v-if="shortcutKey != null" class="session-jump-key">^{{ shortcutKey }}</span>
        <span v-else class="session-jump-key session-jump-key--empty" aria-hidden="true" />
        <span class="session-name">{{ displayName }}</span>
        <span v-if="metaText" class="session-meta" :title="metaText">
          {{ metaText }}
        </span>
      </template>
    </div>

    <!-- Line 3: working plan claim -->
    <span v-if="workingPlanLabel" class="session-working-plan" :title="workingPlanTooltip">
      {{ workingPlanLabel }}
    </span>

    <!-- Keep the terminal title visible on its former row while renaming. -->
    <span v-if="isEditing && metaText" class="session-meta" :title="metaText">
      {{ metaText }}
    </span>

    <!-- Line 4: pending schedule chip -->
    <div v-if="scheduledAt" class="session-schedule-chip">
      <span>⏰ {{ scheduledAt }}</span>
      <button
        class="session-schedule-cancel"
        title="Cancel scheduled resume"
        @click.stop="emit('cancelSchedule', session.id)"
      >×</button>
    </div>

    <NotificationCarousel
      :notifications="llmNotifications ?? []"
      :session-id="session.id"
      @dismiss="emit('dismissNotification', $event)"
      @dismiss-all="emit('dismissSessionNotifications', session.id)"
    />
  </div>
</template>

<style scoped>
.draft-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  background: #2a2a3a;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
}

/* Same badge anatomy as the draft badge, but accent-tinted: an active loop
   is machinery running on the user's behalf and deserves the eye. */
.loop-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  background: #2a2a3a;
  border: 1px solid var(--accent);
  border-radius: 8px;
  font-size: 10px;
  color: var(--accent);
  flex-shrink: 0;
  white-space: nowrap;
}

/* Clickable entry point that opens the session's artifact panel. */
.artifact-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  background: #2a2a3a;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
  cursor: pointer;
  font-family: inherit;
}

.artifact-badge:hover { border-color: var(--accent); color: var(--accent); }
.draft-badge + .artifact-badge { margin-left: 4px; }

/* Natural draggability — whole card, no handle. */
.session-card[draggable='true'] { cursor: grab; }
.session-card[draggable='true']:active { cursor: grabbing; }
.session-card.dragging { opacity: 0.4; }
</style>
