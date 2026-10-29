<script setup lang="ts">
/**
 * SessionList.vue — Owns the full sidebar session list surface.
 *
 * Renders the entire scrollable session-list region. App.vue keeps the lower
 * Quick Spawn and Folder Planner sections outside this component so they stay
 * pinned below the scrolling list.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useScheduledTaskIndicatorsStore } from '../../stores/scheduled-task-indicators.js';
import SessionGroup from './SessionGroup.vue';
import SessionCard from './SessionCard.vue';
import { isNavItemFocused, type SessionPreviewMode } from '../../session-groups.js';
import { pickGroupFlashEntry } from '../../composables/useFlashAttention.js';
import { useSessionDrag } from '../../composables/useSessionDrag.js';
import { useSessionPreviews } from '../../composables/useSessionPreviews.js';
import { useMessageFlights } from '../../composables/useMessageFlights.js';
import { useTodosStore } from '../../stores/todos.js';
import { sessionsState, toggleShowHiddenSessions } from '../../stores/sessions-screen.js';
import { isKeyboardModalOpen } from '../../keyboard/install.js';
import { handleSessionsZone } from '../../screens/sessions-spawn.js';
import { createWheelStepAccumulator } from './wheel-step-accumulator.js';
import type { ContextUsageSample, SessionContextUsageSnapshot, UserPromptSource } from '../../../src/types/session.js';

interface FlashEntry {
  phase: 'pulse' | 'solid';
  startedAt: number;
}

interface SessionListDirectory {
  name: string;
  path: string;
}

interface SessionListProject {
  name: string;
  canonicalPath: string;
  alternatePaths: string[];
}

interface SessionListGroupSession {
  id: string;
  name: string;
  cliType: string;
  contextUsage?: SessionContextUsageSnapshot;
  contextHistory?: ContextUsageSample[];
  title?: string;
  cliSessionName?: string;
  /** G8: active auto-continue count — drives the loop badge on the card. */
  loopContinues?: number;
  /** Subagents this session is waiting on — the 🔥 badge. */
  pendingSubagents?: number;
  lastUserPromptAt?: number;
  lastUserPromptSource?: UserPromptSource;
  peerSessionId?: string;
  peerAttached?: boolean;
  remote?: { peerId: string; sessionId: string };
  activityLevel?: string;
  state?: string;
}

type SessionListFocusColumn = 0 | 1 | 2 | 3 | 4 | 5;

interface SessionListGroup {
  dirPath: string;
  displayName: string;
  collapsed: boolean;
  sessions: SessionListGroupSession[];
  kind?: 'directory' | 'runtime' | 'peer';
  groupId?: string;
  color?: string;
}

const props = defineProps<{
  hasSessions: boolean;
  groups: SessionListGroup[];
  directories: SessionListDirectory[];
  projects?: SessionListProject[];
  navIndexMap: Map<string, number>;
  activeFocus: string;
  focusedNavItem: { id: string; type: string } | null;
  focusColumn: SessionListFocusColumn;
  activeSessionId: string | null;
  editingSessionId: string | null;
  sessionStates: Map<string, string>;
  sessionActivityLevels: Map<string, string>;
  artifactCounts: Map<string, number>;
  unreadChatCountFor?: (sessionId: string) => number;
  workingPlanLabels: Map<string, string>;
  workingPlanTooltips: Map<string, string>;
  pendingSchedules: Map<string, string>;
  snappedOutSessions: Set<string>;
  llmNotifications: Map<string, Array<{ id: string; title: string; content: string; createdAt?: number }>>;
  flashEntries?: Map<string, FlashEntry>;
  getCliDisplayName: (cliType: string) => string;
  resolveGroupDisplayName: (dirPath: string, directories: SessionListDirectory[], projects?: SessionListProject[]) => string;
  sessionElapsedText: (sessionId: string) => string;
  userPromptElapsedText?: (sessionId: string) => string;
  sessionShortcutMap: Map<string, number>;
  /** PTY preview density. Absent = 'on'. */
  previewMode?: SessionPreviewMode;
  source?: 'local' | 'peer';
  listId?: string;
  peerOffline?: boolean;
  peerStale?: boolean;
}>();

const emit = defineEmits<{
  newGroup: [];
  newGroupWithSession: [sessionId: string];
  groupRename: [groupId: string];
  groupClose: [groupId: string];
  groupAddSession: [groupId: string, sessionId: string];
  groupRemoveSession: [sessionId: string];
  toggleGroupCollapse: [dirPath: string];
  sessionClick: [sessionId: string];
  commitRename: [sessionId: string, newName: string];
  cancelRename: [];
  requestClose: [sessionId: string, displayName: string];
  sessionStateChange: [sessionId: string, newState: string];
  showArtifacts: [sessionId: string];
  cancelSchedule: [sessionId: string];
  dismissNotification: [notificationId: string];
  dismissSessionNotifications: [sessionId: string];
  attachPeerSession: [sessionId: string];
}>();

const scheduledTaskIndicators = useScheduledTaskIndicatorsStore();
const todosStore = useTodosStore();
const usesScheduledTaskIndicators = props.source !== 'peer';
const localTodoSessionIds = computed(() => props.source === 'peer'
  ? []
  : [...new Set(props.groups.flatMap(group => group.sessions.map(session => session.id)))],
);
watch(localTodoSessionIds, ids => { void todosStore.loadSessions(ids); }, { immediate: true });

onMounted(() => {
  if (usesScheduledTaskIndicators) scheduledTaskIndicators.start();
  if (props.source !== 'peer') listEl.value?.addEventListener('wheel', onWheel, { passive: false });
});

onUnmounted(() => {
  listEl.value?.removeEventListener('wheel', onWheel);
  wheelAccumulator.reset();
  if (usesScheduledTaskIndicators) scheduledTaskIndicators.stop();
});
function onSessionClick(sessionId: string): void {
  if (props.source === 'peer') {
    const session = props.groups.flatMap(group => group.sessions).find(row => row.id === sessionId);
    if (!session?.peerAttached && session?.peerSessionId) {
      if (!props.peerOffline) emit('attachPeerSession', session.peerSessionId);
      return;
    }
  }
  emit('sessionClick', sessionId);
}

function onCommitRename(sessionId: string, newName: string): void {
  emit('commitRename', sessionId, newName);
}

function onRequestClose(sessionId: string, displayName: string): void {
  emit('requestClose', sessionId, displayName);
}

function onSessionStateChange(sessionId: string, newState: string): void {
  emit('sessionStateChange', sessionId, newState);
}

/** Colours driving a collapsed group-header flash — newest pulse wins (see pickGroupFlashEntry). */
function groupFlashEntry(sessions: SessionListGroupSession[]): FlashEntry | null {
  if (!props.flashEntries) return null;
  return pickGroupFlashEntry(props.flashEntries, sessions.map((session) => session.id));
}

// --- PTY previews ---------------------------------------------------------

const { linesFor } = useSessionPreviews();

/**
 * The preview source for a row, or null when the row shows no preview. The
 * card calls it during its own render, so a busy session re-renders only its
 * own row, not the whole list.
 */
function previewSourceFor(sessionId: string): ((id: string) => string[]) | null {
  const mode = props.previewMode ?? 'on';
  if (mode === 'off') return null;
  if (mode === 'selected-only' && sessionId !== props.activeSessionId) return null;
  return linesFor;
}

// --- Message flights -------------------------------------------------------

const listEl = ref<HTMLElement | null>(null);
const wheelAccumulator = createWheelStepAccumulator();

function onWheel(event: WheelEvent): void {
  if (props.source === 'peer') return;

  event.preventDefault();
  if (isKeyboardModalOpen()) {
    wheelAccumulator.reset();
    return;
  }

  const delta = event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 100 : 1);
  const steps = wheelAccumulator.push(delta);
  if (steps === 0) return;

  sessionsState.activeFocus = 'sessions';
  sessionsState.cardColumn = 0;
  const direction = steps > 0 ? 'down' : 'up';
  const button = steps > 0 ? 'DPadDown' : 'DPadUp';
  for (let i = 0; i < Math.abs(steps); i++) {
    handleSessionsZone(button, direction);
    if (sessionsState.activeFocus !== 'sessions') break;
  }
}

/**
 * Where a session's envelope lands: its row, else its collapsed group's
 * header, else nowhere. Compares dataset values rather than building an
 * attribute selector: session ids and paths contain characters (mobile
 * proxies, Windows paths) that would need CSS escaping.
 */
function resolveAnchor(sessionId: string): HTMLElement | null {
  const root = listEl.value;
  if (!root) return null;
  const row = Array.from(root.querySelectorAll<HTMLElement>('[data-session-id]'))
    .find(el => el.dataset.sessionId === sessionId);
  if (row) return row;
  const group = props.groups.find(g => g.collapsed && g.sessions.some(s => s.id === sessionId));
  if (!group) return null;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-dir-path]'))
    .find(el => el.dataset.dirPath === group.dirPath) ?? null;
}

const { flights, landedSessionIds, onFlightLanded, flightStyle } = useMessageFlights({ rootEl: listEl, resolveAnchor });

// Dropping a session onto the ＋ New Group segment creates a group prefilled and
// moves the session in (mirrors the mockup).
const { draggedSessionId } = useSessionDrag();
const newGroupDropActive = ref(false);

function onNewGroupDragOver(e: DragEvent): void {
  if (!draggedSessionId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  newGroupDropActive.value = true;
}
function onNewGroupDragLeave(): void {
  newGroupDropActive.value = false;
}
function onNewGroupDrop(e: DragEvent): void {
  newGroupDropActive.value = false;
  const sid = draggedSessionId.value;
  if (!sid) return;
  e.preventDefault();
  emit('newGroupWithSession', sid);
}
</script>

<template>
  <div class="sessions-list-shell">
    <!-- Shared list actions. -->
    <div v-if="source !== 'peer'" class="runtime-list-actions">
      <button
        v-if="sessionsState.hiddenSessionCount > 0"
        class="runtime-action"
        :aria-pressed="sessionsState.showHiddenSessions"
        @click="toggleShowHiddenSessions"
      >
        {{ sessionsState.showHiddenSessions ? 'Hide hidden' : `Show hidden (${sessionsState.hiddenSessionCount})` }}
      </button>
      <button
        class="runtime-action"
        :class="{ 'drop-ok': newGroupDropActive }"
        title="Create a new runtime group"
        @click="emit('newGroup')"
        @dragover="onNewGroupDragOver"
        @dragleave="onNewGroupDragLeave"
        @drop="onNewGroupDrop"
      >＋ New Group</button>
    </div>

    <div ref="listEl" class="sessions-list" :id="listId ?? 'sessionsList'" :class="{ 'sessions-list--stale': peerStale }">
      <template v-for="group in groups" :key="group.dirPath">
        <!-- Runtime groups always render (even empty); directory groups only when non-empty. -->
        <template v-if="group.sessions.length > 0 || group.kind === 'runtime'">
          <SessionGroup
            :group="{
              dirPath: group.dirPath,
              displayName: group.kind === 'runtime' || group.kind === 'peer'
                ? group.displayName
                : resolveGroupDisplayName(group.dirPath, directories, projects),
              collapsed: group.collapsed,
              sessionCount: group.sessions.length,
              sessions: group.sessions.map(session => ({
                id: session.id,
                name: session.name !== session.cliType ? session.name : getCliDisplayName(session.cliType),
                activityLevel: session.activityLevel || sessionActivityLevels.get(session.id) || 'idle',
              })),
              kind: source === 'peer' ? 'peer' : group.kind,
              groupId: group.groupId,
              color: group.color,
            }"
            :nav-index="navIndexMap.get(group.dirPath) ?? -1"
            :is-focused="isNavItemFocused(activeFocus, focusedNavItem, 'group-header', group.dirPath)"
            :flash-entry="group.collapsed ? groupFlashEntry(group.sessions) : null"
            @toggle-collapse="emit('toggleGroupCollapse', $event)"
            @rename="emit('groupRename', $event)"
            @close-group="emit('groupClose', $event)"
            @add-session="(gid, sid) => emit('groupAddSession', gid, sid)"
            @remove-session="emit('groupRemoveSession', $event)"
          >

          <template v-if="!group.collapsed">
            <!-- Empty runtime group placeholder -->
            <div
              v-if="group.sessions.length === 0 && group.kind === 'runtime'"
              class="runtime-group-placeholder"
            >
              <span>No active sessions</span>
              <button
                class="placeholder-close"
                title="Close empty group"
                @click="emit('groupClose', group.groupId ?? group.dirPath)"
              >✕</button>
            </div>

            <SessionCard
              v-for="session in group.sessions"
              :key="session.id"
              :session="{ id: session.id, name: session.name, cliType: session.cliType, contextUsage: session.contextUsage, contextHistory: session.contextHistory, title: session.title, cliSessionName: session.cliSessionName, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt, createdByPeerId: session.createdByPeerId, remote: session.remote, locked: session.locked, frozen: session.frozen, lastPromptAt: session.lastPromptAt, lastUserPromptAt: session.lastUserPromptAt, lastUserPromptSource: session.lastUserPromptSource, keepWarmUntil: session.keepWarmUntil, eta: session.eta, mission: session.mission }"
              :nav-index="navIndexMap.get(session.id) ?? -1"
              :session-state="source === 'peer' ? (session.state || 'idle') : (sessionStates.get(session.id) || 'idle')"
              :activity-level="session.activityLevel || sessionActivityLevels.get(session.id) || 'idle'"
              :display-name="session.name !== session.cliType ? session.name : getCliDisplayName(session.cliType)"
              :artifact-count="artifactCounts.get(session.id) ?? 0"
              :unread-chat-count="source === 'peer' ? 0 : unreadChatCountFor?.(session.id) ?? 0"
              :todo-count="source === 'peer' ? { done: 0, total: 0 } : todosStore.countFor(session.id)"
              :loop-continues="session.loopContinues ?? 0"
              :pending-subagents="session.pendingSubagents ?? 0"
              :elapsed-text="sessionElapsedText(session.id)"
              :user-prompt-elapsed-text="userPromptElapsedText?.(session.id) ?? ''"
              :working-plan-label="workingPlanLabels.get(session.id) || ''"
              :working-plan-tooltip="workingPlanTooltips.get(session.id) || ''"
              :is-active="activeSessionId === session.id"
              :is-focused="isNavItemFocused(activeFocus, focusedNavItem, 'session-card', session.id)"
              :focus-column="focusColumn"
              :is-editing="editingSessionId === session.id"
              :scheduled-at="pendingSchedules.get(session.id) ?? null"
              :scheduled-task-indicator-enabled="usesScheduledTaskIndicators"
              :is-snapped-out="snappedOutSessions.has(session.id)"
              :llm-notifications="llmNotifications.get(session.id) ?? []"
              :flash-entry="flashEntries?.get(session.id) ?? null"
              :shortcut-key="sessionShortcutMap.get(session.id) ?? null"
              :preview-source="previewSourceFor(session.id)"
              :message-landed="landedSessionIds.has(session.id)"
              :read-only="source === 'peer' && !session.peerAttached"
              :state-read-only="source === 'peer'"
              :interaction-disabled="source === 'peer' && peerOffline && !session.peerAttached"
              :stale="peerStale"
              @click="onSessionClick($event)"
              @commit-rename="onCommitRename"
              @cancel-rename="emit('cancelRename')"
              @close="onRequestClose"
              @state-change="onSessionStateChange"
              @show-artifacts="emit('showArtifacts', $event)"
              @cancel-schedule="emit('cancelSchedule', $event)"
              @dismiss-notification="emit('dismissNotification', $event)"
              @dismiss-session-notifications="emit('dismissSessionNotifications', $event)"
            />
          </template>
          </SessionGroup>
        </template>
      </template>

      <div v-if="!hasSessions" class="sessions-empty">
        {{ source === 'peer' ? 'No sessions on this computer' : 'No active sessions' }}
      </div>

      <span
        v-for="flight in flights"
        :key="flight.id"
        class="message-flight"
        :style="flightStyle(flight)"
        aria-hidden="true"
        @animationend="onFlightLanded(flight.id)"
      >
        <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden="true">
          <rect x="0.75" y="0.75" width="16.5" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M1.5 1.5 9 7l7.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Flights are drawn in list coordinates, so they scroll with the rows. */
.sessions-list { position: relative; }

/* Centred on its anchor point; flies by the offset to the recipient. */
.message-flight {
  position: absolute;
  z-index: 6;
  margin: -6px 0 0 -9px;
  pointer-events: none;
  color: var(--flight-colour, var(--status-ready));
  animation: session-message-flight 1s ease-in-out forwards;
}
.message-flight svg { display: block; filter: drop-shadow(0 0 3px var(--flight-colour, var(--status-ready))); }

@keyframes session-message-flight {
  from { transform: translate(0, 0); }
  to { transform: translate(var(--flight-dx, 0), var(--flight-dy, 0)); }
}
</style>
