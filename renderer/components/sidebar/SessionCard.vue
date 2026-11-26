<script setup lang="ts">
/**
 * SessionCard.vue — Single session card with activity dot, state, badges, timer, rename.
 *
 * Reactive sidebar row for one terminal session. Props drive all rendering
 * and events route session commands through sidebar services.
 */
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue';
import NotificationCarousel from './NotificationCarousel.vue';
import { useRuntimeGroups } from '../../composables/useRuntimeGroups.js';
import { useSessionDrag } from '../../composables/useSessionDrag.js';
import { formatHelmRef } from '../../lib/helm-ref.js';
import { getCliDisplayName, resolveCliTypeRecord, showFormModal } from '../../utils.js';
import { useLlmNotificationsStore } from '../../stores/llmNotifications.js';
import { warnAfterMs } from '../../../src/session/prompt-staleness.js';
import type { ContextUsageSample, SessionContextUsageSnapshot, SessionEta, SessionMission, SessionQuotaUsageSnapshot, UserPromptSource } from '../../../src/types/session.js';
import { contextMenu, showSessionMenu } from '../../stores/modal-bridge.js';
import ContextRing from './ContextRing.vue';
import TodoBadge from './TodoBadge.vue';
import type { SessionTodo } from '../../../src/types/todo.js';
import TickerText from '../common/TickerText.vue';
import Badge from '../common/Badge.vue';
import { useScheduledTaskIndicatorsStore } from '../../stores/scheduled-task-indicators.js';
import { formatSessionEta } from '../../session-eta.js';
import { sessionsState } from '../../stores/sessions-screen.js';
import { VALID_SESSION_STATES } from '../../../src/types/session.js';

function openSessionMenu(event: MouseEvent): void {
  showSessionMenu(props.session.id, { x: event.clientX, y: event.clientY });
}

function onCardContextMenu(event: MouseEvent): void {
  if (!canOpenSessionMenu.value) return;
  event.preventDefault();
  event.stopPropagation();
  openSessionMenu(event);
}

// --- Types ---

export interface SessionCardSession {
  id: string;
  name: string;
  cliType: string;
  contextUsage?: SessionContextUsageSnapshot;
  quotaUsage?: SessionQuotaUsageSnapshot | null;
  contextHistory?: ContextUsageSample[];
  title?: string;
  cliSessionName?: string;
  /** Epoch ms when the session was first spawned. */
  createdAt?: number;
  /** Epoch ms when the activity dot last left green. */
  lastActiveAt?: number;
  /** Remote Fleet peer that created this session, when spawned over the peer proxy. */
  createdByPeerId?: string;
  remote?: { peerId: string; sessionId: string };
  locked?: boolean;
  /** No input reaches it; drives the ❄ toggle's on state and the hatched row. */
  frozen?: boolean;
  /** Closing: saving its memories first. Hatched like frozen, with a big X. */
  retiringAt?: number;
  /** Epoch ms of the last prompt (timer tooltip, cache fade). */
  lastPromptAt?: number;
  lastUserPromptAt?: number;
  lastUserPromptSource?: UserPromptSource;
  /** Keep-warm is on until switched off. */
  keepWarm?: boolean;
  eta?: SessionEta;
  mission?: SessionMission;
}

export type SessionCardFocusColumn = 0 | 1 | 2 | 3 | 4 | 5;

export interface SessionCardProps {
  session: SessionCardSession;
  navIndex: number;
  sessionState: string;
  activityLevel: string;
  displayName: string;
  artifactCount: number;
  unreadChatCount: number;
  /** Open todos left; the chip shows the count and hovers the items. */
  todos?: readonly SessionTodo[];
  /** G8: consecutive Stop-hook auto-continues in flight. 0 = no active loop. */
  loopContinues: number;
  /** Subagents this session is waiting on. 0 = none. */
  pendingSubagents: number;
  elapsedText: string;
  userPromptElapsedText?: string;
  workingPlanLabel: string;
  workingPlanTooltip: string;
  isActive: boolean;
  isFocused: boolean;
  focusColumn: SessionCardFocusColumn;
  isEditing: boolean;
  scheduledAt?: string | null;
  scheduledTaskIndicatorEnabled?: boolean;
  isSnappedOut?: boolean;
  llmNotifications?: Array<{ id: string; title: string; content: string; createdAt?: number; kind?: 'note' }>;
  flashEntry?: { phase: 'pulse' | 'solid' } | null;
  shortcutKey?: number | null;
  /** Reads this row's passive PTY tail; null/absent = no preview. */
  previewSource?: ((sessionId: string) => string[]) | null;
  /** True briefly after a message envelope lands on this row. */
  messageLanded?: boolean;
  readOnly?: boolean;
  stateReadOnly?: boolean;
  interactionDisabled?: boolean;
  stale?: boolean;
}

// --- Constants ---

const STATE_LABELS: Record<string, string> = {
  implementing: '🔨 Implementing',
  waiting: '⏳ Waiting',
  planning: '🧠 Planning',
  completed: '🎉 Completed',
  idle: '💤 Idle',
};

// --- Props & Emits ---

const props = defineProps<SessionCardProps>();

const scheduledTaskIndicators = useScheduledTaskIndicatorsStore();
const scheduledTaskTooltip = computed(() => props.scheduledTaskIndicatorEnabled === false
  ? null
  : scheduledTaskIndicators.tooltipFor(props.session.id));

const canOpenSessionMenu = computed(() => !props.isEditing && !props.readOnly);

const emit = defineEmits<{
  click: [sessionId: string];
  commitRename: [sessionId: string, newName: string];
  cancelRename: [];
  close: [sessionId: string, displayName: string];
  stateChange: [sessionId: string, newState: string];
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
  const lastPrompt = formatClockTime(props.session.lastPromptAt);
  return `Time since last prompt\nLast prompt: ${lastPrompt}\nCreated: ${created}\nLast active: ${lastActive}`;
});

const userPromptTimerTooltip = computed(() => {
  const source = props.session.lastUserPromptSource;
  const at = props.session.lastUserPromptAt;
  const origin = source === 'phone' ? 'phone' : source === 'chat' ? 'desktop Chat' : 'terminal';
  return `Time since your last submitted prompt from ${origin}${at !== undefined ? `\nSubmitted: ${formatClockTime(at)}` : ''}`;
});

const etaTimer = computed(() => {
  const eta = props.session.eta;
  if (!eta) return null;
  // The parent's existing one-second elapsed timer refreshes this computed too.
  void props.elapsedText;
  return formatSessionEta(eta);
});

// --- Prompt-cache fade: the fill drains over the CLI's short cache window ---
// A CSS animation with a negative delay starts part-way through, so the fill
// matches the session's age on render; keying the element on lastPromptAt
// restarts it on every new prompt. No per-second re-render needed.
const fadeStyle = computed(() => {
  const at = props.session.lastPromptAt;
  if (at === undefined) return null;
  const cli = resolveCliTypeRecord(props.session.cliType) ?? undefined;
  if (cli?.noPromptCache) return null;
  const durationMs = warnAfterMs(cli);
  return { animationDuration: `${durationMs}ms`, animationDelay: `${-(Date.now() - at)}ms` };
});

// --- Local state ---

const renameInput = ref<HTMLInputElement | null>(null);
const dropdownOptionRefs = ref<HTMLElement[]>([]);
// Rename editing is exclusive, so the draft and caret belong to the one active card.
const stateDropdownOpen = computed(() => sessionsState.stateDropdownSessionId === props.session.id);

onBeforeUnmount(() => {
  if (sessionsState.stateDropdownSessionId === props.session.id) {
    sessionsState.stateDropdownSessionId = null;
  }
});

function toggleStateDropdown(): void {
  if (stateDropdownOpen.value) {
    sessionsState.stateDropdownSessionId = null;
    return;
  }

  const activeIndex = VALID_SESSION_STATES.findIndex(value => value === props.sessionState);
  sessionsState.stateDropdownFocusIndex = activeIndex >= 0 ? activeIndex : 0;
  sessionsState.stateDropdownSessionId = props.session.id;
}

function syncRenameSelection(event: Event): void {
  const input = event.target as HTMLInputElement;
  sessionsState.renameSelectionStart = input.selectionStart ?? 0;
  sessionsState.renameSelectionEnd = input.selectionEnd ?? sessionsState.renameSelectionStart;
}

// Auto-focus rename input when editing begins
watch(() => props.isEditing, async (editing) => {
  if (editing) {
    sessionsState.renameDraft = props.session.name;
    sessionsState.renameSelectionStart = 0;
    sessionsState.renameSelectionEnd = props.session.name.length;
    await nextTick();
    renameInput.value?.focus();
    renameInput.value?.select();
  }
}, { immediate: true });

watch(() => [sessionsState.renameSelectionStart, sessionsState.renameSelectionEnd] as const,
  ([start, end]) => {
    if (!props.isEditing) return;
    renameInput.value?.setSelectionRange(start, end);
  },
  { flush: 'post' },
);

watch(() => stateDropdownOpen.value ? sessionsState.stateDropdownFocusIndex : null,
  async index => {
    if (index === null) return;
    await nextTick();
    dropdownOptionRefs.value[index]?.scrollIntoView?.({ block: 'nearest' });
  },
  { flush: 'post' },
);

// --- Computed ---

// Read inside the card so only this row re-renders when its session's output changes.
const previewLines = computed(() => props.previewSource?.(props.session.id) ?? null);


// Flash-attention: pulse (beating) or solid (steady accent) until focused.
const flashClass = computed(() => {
  if (!props.flashEntry) return '';
  return props.flashEntry.phase === 'solid' ? 'flash-solid' : 'flash-pulse';
});
// Rows tied to another Helm share one tint: sessions a peer opened HERE, and
// Remote rows whose CLI actually runs on a peer.
const isPeerCreated = computed(() => !!props.session.createdByPeerId || !!props.session.remote);
const peerTitle = computed(() => {
  if (props.session.remote) return `Remote — running on peer: ${props.session.remote.peerId}`;
  return props.session.createdByPeerId ? `Opened by peer: ${props.session.createdByPeerId}` : undefined;
});
const stateLabel = computed(() => STATE_LABELS[props.sessionState] || '💤 Idle');
/** Status shown in the middle of the row — every one that applies, side by side. */
const statusIcons = computed(() => [
  props.session.locked && { icon: '🔒', title: 'Locked against closure' },
  props.session.frozen && { icon: '❄️', title: 'Frozen — no input reaches it' },
  props.session.keepWarm && { icon: '⏰', title: 'Keeping cache warm' },
  scheduledTaskTooltip.value && { icon: '🕒', title: scheduledTaskTooltip.value, className: 'session-status-scheduled-task' },
].filter((x): x is { icon: string; title: string; className?: string } => !!x));
/** The row's own line: the mission when set, else the CLI's terminal title. */
const metaText = computed(() => {
  const mission = props.session.mission?.text.trim();
  if (mission) return mission;
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

/** 📝: the note joins the row's notification carousel as its newest entry. */
async function addNote(): Promise<void> {
  const values = await showFormModal(`Note for ${props.displayName}`, [{ key: 'note', label: 'Note', type: 'multiline' }]);
  const content = values?.note?.trim();
  if (content) useLlmNotificationsStore().add({ sessionId: props.session.id, title: 'Note', content, kind: 'note' });
}
const hasUserNote = computed(() => props.llmNotifications?.some(n => n.kind === 'note') ?? false);

// --- Handlers ---

function onRenameKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    emit('commitRename', props.session.id, sessionsState.renameDraft);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('cancelRename');
  }
}

function selectState(s: string): void {
  if (sessionsState.stateDropdownSessionId === props.session.id) {
    sessionsState.stateDropdownSessionId = null;
  }
  emit('stateChange', props.session.id, s);
}

function onCardClick(e: MouseEvent): void {
  if (props.interactionDisabled) return;
  const sessionId = (e.currentTarget as HTMLElement).getAttribute('data-session-id');
  if (sessionId) {
    emit('click', sessionId);
  }
}

</script>

<template>
  <div
    class="session-card"
    :class="[{ active: isActive, focused: isFocused, 'snapped-out': isSnappedOut, dragging: isDragging, grouped: !!runtimeGroup, 'peer-created': isPeerCreated, 'message-landed': messageLanded, 'user-noted': hasUserNote, frozen: session.frozen, retiring: session.retiringAt !== undefined, 'peer-stale': stale, 'interaction-disabled': interactionDisabled }, flashClass]"
    :title="peerTitle"
    :data-session-id="session.id"
    :data-nav-index="navIndex"
    :draggable="!isEditing && !readOnly && !interactionDisabled"
    @click="onCardClick"
    @contextmenu="onCardContextMenu"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <span v-if="fadeStyle" :key="session.lastPromptAt" class="session-prompt-fade" :style="fadeStyle" />
    <!-- Status at a glance, centred on the row: every one that applies, side by side. -->
    <span v-if="statusIcons.length" class="session-status-icons" aria-hidden="true">
      <span v-for="s in statusIcons" :key="s.icon" :class="s.className" :title="s.title">{{ s.icon }}</span>
    </span>
    <!-- Line 1: top row -->
    <div class="session-top-row">
      <ContextRing
        :activity-level="activityLevel"
        :cli-type="session.cliType"
        :context-usage="session.contextUsage"
        :quota-usage="session.quotaUsage"
        :context-history="session.contextHistory"
      />
      <span v-if="isSnappedOut" class="snap-indicator" title="Snapped out">📤</span>

      <button
        v-if="!readOnly && !stateReadOnly"
        class="session-state-btn"
        :class="colClass(1)"
        @click.stop="toggleStateDropdown"
      >
        {{ stateLabel }}
      </button>
      <span v-else class="session-state-btn session-state-btn--readonly">{{ stateLabel }}</span>

      <!-- State dropdown -->
      <div v-if="!readOnly && stateDropdownOpen" class="session-state-dropdown">
        <button
          v-for="(s, i) in VALID_SESSION_STATES"
          :key="s"
          ref="dropdownOptionRefs"
          class="session-state-option"
          :class="{ active: s === sessionState, 'dropdown-focused': i === sessionsState.stateDropdownFocusIndex }"
          @click.stop="selectState(s)"
        >
          {{ STATE_LABELS[s] || s }}
        </button>
      </div>

      <!-- G8 loop badge — an in-progress auto-continue loop must never be invisible -->
      <Badge
        v-if="loopContinues > 0"
        size="count"
        class="session-loop-indicator"
        tone="accent"
        title="Loop driving: consecutive Stop-hook auto-continues in flight. A user prompt or the kill switch ends it."
      >🔁{{ loopContinues }}</Badge>

      <!-- Subagent badge — the subagents themselves are hidden from the list -->
      <Badge
        v-if="pendingSubagents > 0"
        size="count"
        class="session-loop-indicator"
        tone="accent"
        :title="`${pendingSubagents} subagent${pendingSubagents === 1 ? '' : 's'} working for this session`"
      >🔥{{ pendingSubagents }}</Badge>

      <!-- Artifact badge — click to show this session's artifact panel -->
      <button
        v-if="artifactCount > 0"
        class="session-artifact-entry"
        type="button"
        :title="`Show ${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`"
        @click.stop="emit('showArtifacts', session.id)"
      >
        <Badge size="count" class="session-artifact-count" tone="neutral">📄{{ artifactCount }}</Badge>
      </button>

      <span style="flex: 1" />

      <button
        v-if="readOnly"
        class="session-state-btn session-attach-btn"
        type="button"
        :disabled="interactionDisabled"
        :title="stale ? 'Peer offline — this snapshot is stale' : 'Attach this session'"
        @click.stop="emit('click', session.id)"
      >{{ interactionDisabled ? 'Offline' : 'Attach' }}</button>

      <span class="session-timer session-timer-with-icon" :title="timerTooltip">
        <svg class="session-timer-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 5.5v4.7l3 1.8" />
        </svg>
        <span>{{ elapsedText }}</span>
      </span>
      <span
        v-if="userPromptElapsedText && session.lastUserPromptSource"
        class="session-timer session-timer-with-icon session-user-prompt-timer"
        :class="`source-${session.lastUserPromptSource}`"
        :title="userPromptTimerTooltip"
      >
        <svg v-if="session.lastUserPromptSource === 'phone'" class="session-timer-icon" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="5" y="2.5" width="10" height="15" rx="2" />
          <path d="M8 5h4M9 14.5h2" />
        </svg>
        <svg v-else-if="session.lastUserPromptSource === 'chat'" class="session-timer-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 4.5h14v10H9l-4 3v-3H3z" />
        </svg>
        <svg v-else class="session-timer-icon" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="3.5" width="15" height="13" rx="1.8" />
          <path d="m5.5 7 2.2 2-2.2 2M9.5 11h4" />
        </svg>
        <span>{{ userPromptElapsedText }}</span>
      </span>
      <!-- Copy session id button -->
      <button
        class="session-copy-id"
        :title="copied ? 'Copied!' : 'Copy session id'"
        @click.stop="copyId"
      >
        {{ copied ? '✓' : '🔗' }}
      </button>
      <button class="session-note" title="Add a note to this session" aria-label="Add a note" @click.stop="addNote">📝</button>

      <!-- Kebab: the session's own actions (rename, lock, freeze, keep warm, compact, clone, switch). -->
      <button
        v-if="canOpenSessionMenu"
        class="session-kebab"
        :class="colClass(2)"
        :title="`Actions for ${displayName}`"
        aria-haspopup="menu"
        :aria-expanded="contextMenu.visible && contextMenu.mode === 'session' && contextMenu.sourceSessionId === props.session.id"
        @click.stop="openSessionMenu"
      >
        ⋮
      </button>

      <!-- Close button -->
      <button
        v-if="!readOnly"
        class="session-close"
        :class="colClass(3)"
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
          v-model="sessionsState.renameDraft"
          class="session-rename-input"
          type="text"
          maxlength="50"
          placeholder="Enter name..."
          @input="syncRenameSelection"
          @select="syncRenameSelection"
          @keydown="onRenameKeydown"
        />
        <button class="session-rename-save" title="Save (Enter)" @click.stop="emit('commitRename', session.id, sessionsState.renameDraft)">✓</button>
        <button class="session-rename-cancel" title="Cancel (Escape)" @click.stop="emit('cancelRename')">×</button>
      </template>
      <template v-else>
        <span v-if="shortcutKey != null" class="session-jump-key">^{{ shortcutKey }}</span>
        <span v-else class="session-jump-key session-jump-key--empty" aria-hidden="true" />
        <span class="session-name">{{ displayName }}</span>
        <Badge
          v-if="unreadChatCount > 0"
          size="count"
          class="session-chat-unread"
          tone="accent"
          :flashing="!!flashEntry"
          :title="`${unreadChatCount} new Chat messages`"
          :aria-label="`${unreadChatCount} new Chat messages`"
        >{{ unreadChatCount }} new</Badge>
        <TodoBadge :todos="todos ?? []" :flashing="!!flashEntry" />
        <span
          v-if="etaTimer"
          class="session-timer session-eta-timer"
          :class="{ 'session-eta-timer--late': etaTimer.isLate }"
          :title="etaTimer.title"
        >{{ etaTimer.text }}</span>
      </template>
    </div>

    <!-- Line 3: mission, else terminal title — ticker-scrolls when it overflows -->
    <TickerText v-if="metaText" class="session-meta" :text="metaText" :title="metaText" />

    <!-- Line 4: working plan claim -->
    <span v-if="workingPlanLabel" class="session-working-plan" :title="workingPlanTooltip">
      {{ workingPlanLabel }}
    </span>

    <!-- Line 5: pending schedule chip -->
    <Badge v-if="scheduledAt" class="session-schedule-badge" tone="warn">
      <span>⏰ {{ scheduledAt }}</span>
      <button
        type="button"
        class="session-schedule-cancel"
        title="Cancel scheduled resume"
        @click.stop="emit('cancelSchedule', session.id)"
      >×</button>
    </Badge>

    <!-- Passive PTY tail: read-only, never focused, clicks select the row. -->
    <div v-if="previewLines" class="session-preview" aria-hidden="true">
      <span v-for="(line, index) in previewLines" :key="index" class="session-preview__line">{{ line }}</span>
      <span v-if="previewLines.length === 0" class="session-preview__line">No output yet</span>
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
/* ── Session cards ────────────────────────────────────────── */

.session-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
  padding: 8px 12px;
  min-height: 94px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.session-card:hover,
.session-card.focused { background: var(--bg-tertiary); }
.session-card.active {
  border-color: var(--accent);
  background: var(--bg-hover);
  /* 3px ring (1px border + 2px inset) plus an outer glow: selection must read at a glance. */
  box-shadow: inset 0 0 0 2px var(--accent), 0 0 12px 2px color-mix(in srgb, var(--accent) 55%, transparent);
}
.session-card.snapped-out {
  border-style: dashed;
  border-color: #555;
}
.session-card.snapped-out:hover,
.session-card.snapped-out.focused {
  background: var(--bg-tertiary);
}
.session-card.snapped-out.active,
.session-card.snapped-out.active:hover,
.session-card.snapped-out.active.focused {
  border-color: var(--accent);
  background: var(--bg-hover);
}

/* Sessions opened on this machine by a remote Fleet peer. The tint holds through
   hover/focus/active so the remote origin is never ambiguous — active keeps its
   accent BORDER as the selection cue. Declared before the flash-attention block
   so a flash (a deliberate grab-the-user signal) still wins while it runs. */
.session-card.peer-created,
.session-card.peer-created:hover,
.session-card.peer-created.focused,
.session-card.peer-created.active {
  background: var(--peer-session-bg, #1b2b3f) !important;
}
.session-card.peer-created:hover,
.session-card.peer-created.focused {
  background: var(--peer-session-bg-hover, #22374f) !important;
}
.session-card.peer-created.active,
.session-card.peer-created.active:hover,
.session-card.peer-created.active.focused {
  background: var(--bg-hover) !important;
}

.snap-indicator {
  font-size: 10px;
  margin-left: 2px;
}

/* Flash attention — beats between the resting bg and the app theme accent for
   15s (flash-pulse), then holds the accent (flash-solid) until the session is
   focused. Colour comes straight from the app's --accent / --accent-contrast
   tokens, so the flash matches the app theme regardless of the OS accent.

   The beat is DISCRETE, not a smooth interpolation: background + text switch
   together at flat plateaus so every rendered frame lands on one of two
   guaranteed-contrast surfaces (dark bg + light text, or accent + paired text).
   Smoothly cross-fading fg and bg would collapse contrast mid-transition. */
@keyframes flash-beat {
  0%,   49% { background-color: var(--bg-secondary); color: var(--text-primary); }
  50%, 100% { background-color: var(--accent);  color: var(--accent-contrast); }
}
.session-card.flash-pulse {
  animation: flash-beat 1s infinite;
}
.session-card.flash-solid {
  background-color: var(--accent) !important;
  color: var(--accent-contrast);
}
/* Force textual and icon descendants onto the flash colour. Badge, TodoBadge, ContextRing,
   TickerText, and NotificationCarousel render their own scoped DOM, so deep is required. */
.session-card.flash-pulse :deep(:where(span, button, input, .session-name)),
.session-card.flash-solid :deep(:where(span, button, input, .session-name)) {
  color: inherit !important;
}
/* Keep ContextRing’s inline-coloured activity dot readable during a flash. Its inner DOM
   has a child scope id, so deep reaches only that dot. */
.session-card.flash-pulse :deep(.context-ring__dot),
.session-card.flash-solid :deep(.context-ring__dot) {
  box-shadow: 0 0 0 1px var(--accent-contrast);
}

.session-timer {
  font-size: 11px;
  color: #bbb;
  white-space: nowrap;
  pointer-events: none;
}

.session-timer-with-icon {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.session-timer-icon {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.session-user-prompt-timer { color: #bbb; }
.session-user-prompt-timer.source-phone .session-timer-icon { color: #d0b8f5; }
.session-user-prompt-timer.source-terminal .session-timer-icon { color: #9de0d4; }
.session-user-prompt-timer.source-chat .session-timer-icon { color: #d0b8f5; }
.session-eta-timer--late { color: var(--warning, #b58900); }

/* Top row: dot, state, badges, timer, actions */
.session-top-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

/* State icon — removed, state shown via dropdown button only */

.session-card .session-name { flex: 1 1 auto; min-width: 0; font-size: var(--font-size-md); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: inherit; }
/* Clipping, ellipsis and ticker scrolling live in TickerText. */
.session-card .session-meta { font-size: var(--font-size-sm); color: var(--text-secondary); }

/* Session action buttons (state, kebab, close, copy-id) - always visible */
.session-kebab,
.session-state-btn,
.session-close,
.session-copy-id,
.session-note {
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s;
  opacity: 1;
}
.session-kebab { font-weight: 700; }
.session-kebab:hover { color: var(--accent); background: rgba(100, 150, 255, 0.1); }
.session-copy-id:hover,
.session-note:hover { color: var(--accent); background: rgba(100, 150, 255, 0.1); }
.session-kebab.card-col-focused {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
}
.session-state-btn:hover { color: var(--accent); background: rgba(100, 150, 255, 0.1); }

/* Session close button specific styles */
.session-close:hover {
  color: #ff4444;
  background: rgba(255, 68, 68, 0.1);
}
.session-close.card-col-focused {
  background: rgba(255, 80, 80, 0.2);
  border-color: #ff5050;
  color: #ff5050;
}

/* Session name line — dedicated row for editable name */
.session-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.session-jump-key {
  display: inline-flex;
  align-items: center;
  background: rgba(var(--accent-rgb), 0.08);
  border: 1px solid rgba(var(--accent-rgb), 0.25);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  font-family: monospace;
  color: rgba(var(--accent-rgb), 0.6);
  line-height: 1.5;
  flex-shrink: 0;
  min-width: 20px;
  justify-content: center;
}
.session-jump-key--empty {
  background: none;
  border-color: transparent;
}
.session-working-plan {
  display: block;
  width: 100%;
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-top-row .session-state-btn,
.session-top-row .session-kebab,
.session-top-row .session-close,
.session-top-row .session-copy-id,
.session-top-row .session-note {
  font-size: var(--font-size-sm);
  padding: 1px 4px;
}

/* Rename edit mode input and buttons */
.session-rename-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: var(--font-size-sm);
  font-family: inherit;
  color: var(--text-primary);
  outline: none;
}
.session-rename-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(79, 195, 247, 0.2);
}

.session-rename-save,
.session-rename-cancel {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.2s, color 0.2s;
}
.session-rename-save {
  color: #4cc94c;
}
.session-rename-save:hover {
  background: rgba(76, 201, 76, 0.15);
  color: #5dd95d;
}
.session-rename-cancel {
  color: #888;
}
.session-rename-cancel:hover {
  background: rgba(255, 68, 68, 0.1);
  color: #ff4444;
}

/* Session state dropdown button */
.session-state-btn {
  background: none;
  border: 1px solid transparent;
  color: #999;
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
  transition: border-color 0.2s, background 0.2s;
}
.session-state-btn:hover {
  border-color: #555;
  background: rgba(255, 255, 255, 0.05);
}
.session-state-btn.card-col-focused {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
}
.session-state-dropdown {
  position: fixed;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 6px;
  padding: 4px 0;
  z-index: 200;
  min-width: 150px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.session-state-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: #ccc;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  text-align: left;
}
.session-state-option:hover,
.session-state-option:focus,
.session-state-option.dropdown-focused {
  background: rgba(255, 255, 255, 0.1);
  outline: none;
}
.session-state-option.active {
  color: #4fc3f7;
}

.session-schedule-badge.badge--warn { display: flex; align-items: center; gap: 4px; margin-top: 2px; font-size: 11px; color: #ffa040; }
.session-schedule-cancel { background: none; border: none; color: #888; cursor: pointer; padding: 0 2px; font-size: 12px; line-height: 1; }
.session-schedule-cancel:hover { color: #ff6060; }

/* Prompt-cache fade — a tint that drains to nothing over the CLI's short cache
   window (cacheWarnMinutes). Behind the content, never catching clicks. */
.session-card { position: relative; isolation: isolate; }
.session-card.interaction-disabled { cursor: default; }
/* A user note holds the row in a solid, steady blue until it is dismissed. */
.session-card.user-noted {
  background: color-mix(in srgb, var(--info) 22%, var(--bg-secondary));
  border-color: var(--info);
}
.session-prompt-fade {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: rgba(255, 255, 255, 0.05);
  animation-name: session-prompt-fade;
  animation-timing-function: linear;
  animation-fill-mode: both;
}
@keyframes session-prompt-fade { to { opacity: 0; } }
/* Lock / frozen / keep-warm, centred over the row; never steals a click. */
.session-status-icons {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  gap: 6px;
  font-size: 18px;
  opacity: 0.85;
  pointer-events: none;
  z-index: 1;
}
.session-status-icons > span { pointer-events: auto; }
/* Frozen — cross-hatched: no input reaches this session. */
.session-card.frozen,
.session-card.retiring {
  background-image: repeating-linear-gradient(45deg, rgba(140, 190, 255, 0.18) 0 6px, transparent 6px 12px);
}
/* Closing — saving its memories first: a big X across the row until it goes. */
.session-card.retiring::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background:
    linear-gradient(to top right, transparent calc(50% - 2px), var(--danger) calc(50% - 2px), var(--danger) calc(50% + 2px), transparent calc(50% + 2px)),
    linear-gradient(to bottom right, transparent calc(50% - 2px), var(--danger) calc(50% - 2px), var(--danger) calc(50% + 2px), transparent calc(50% + 2px));
  opacity: 0.7;
}

.session-loop-indicator.badge--accent {
  background: #2a2a3a;
}

.session-artifact-entry {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  margin-left: auto;
  flex-shrink: 0;
  cursor: pointer;
  font-family: inherit;
}

.session-artifact-count.badge--neutral {
  gap: 2px;
  background: #2a2a3a;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-weight: 400;
}

.session-artifact-entry:hover .session-artifact-count { border-color: var(--accent); color: var(--accent); }

/* Five clipped lines, constant mid grey — no fade, no brighter last line. */
.session-preview {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: calc(5 * 12px + 8px);
  margin-top: 4px;
  padding: 4px 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  font: 10px/12px var(--font-mono);
  color: var(--text-secondary);
  pointer-events: none;
  user-select: none;
}
.session-preview__line {
  display: block;
  white-space: pre;
  overflow: hidden;
  text-overflow: clip;
}

/* An envelope just landed here: a short accent flash before the paste shows. */
.session-card.message-landed { animation: session-message-landed 0.6s ease-out; }
@keyframes session-message-landed {
  from { box-shadow: inset 0 0 0 2px var(--accent); }
  to { box-shadow: inset 0 0 0 2px transparent; }
}

/* Natural draggability — whole card, no handle. */
.session-card[draggable='true'] { cursor: grab; }
.session-card[draggable='true']:active { cursor: grabbing; }
.session-card.dragging { opacity: 0.4; }
</style>
