<script setup lang="ts">
/**
 * SessionList.vue — Owns the full sidebar session list surface.
 *
 * Renders the entire scrollable session-list region. App.vue keeps the lower
 * Quick Spawn and Folder Planner sections outside this component so they stay
 * pinned below the scrolling list.
 */
import { ref } from 'vue';
import SessionGroup from './SessionGroup.vue';
import SessionCard from './SessionCard.vue';
import { isNavItemFocused, type SessionPreviewMode } from '../../session-groups.js';
import { pickGroupFlashEntry } from '../../composables/useFlashAttention.js';
import { useSessionDrag } from '../../composables/useSessionDrag.js';
import { useSessionPreviews } from '../../composables/useSessionPreviews.js';
import { useMessageFlights } from '../../composables/useMessageFlights.js';

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
  title?: string;
  cliSessionName?: string;
  /** G8: active auto-continue count — drives the loop badge on the card. */
  loopContinues?: number;
}

type SessionListFocusColumn = 0 | 1 | 2 | 3 | 4 | 5;

interface SessionListGroup {
  dirPath: string;
  displayName: string;
  collapsed: boolean;
  sessions: SessionListGroupSession[];
  kind?: 'directory' | 'runtime';
  groupId?: string;
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
  draftCounts: Map<string, number>;
  artifactCounts: Map<string, number>;
  workingPlanLabels: Map<string, string>;
  workingPlanTooltips: Map<string, string>;
  pendingSchedules: Map<string, string>;
  snappedOutSessions: Set<string>;
  llmNotifications: Map<string, Array<{ id: string; title: string; content: string; createdAt?: number }>>;
  flashEntries?: Map<string, FlashEntry>;
  getCliDisplayName: (cliType: string) => string;
  resolveGroupDisplayName: (dirPath: string, directories: SessionListDirectory[], projects?: SessionListProject[]) => string;
  isSessionHiddenFromOverview: (session: SessionListGroupSession) => boolean;
  sessionElapsedText: (sessionId: string) => string;
  sessionShortcutMap: Map<string, number>;
  /** PTY preview density. Absent = 'on'. */
  previewMode?: SessionPreviewMode;
}>();

const emit = defineEmits<{
  newGroup: [];
  newGroupWithSession: [sessionId: string];
  groupRename: [groupId: string];
  groupClose: [groupId: string];
  groupAddSession: [groupId: string, sessionId: string];
  groupRemoveSession: [sessionId: string];
  toggleGroupCollapse: [dirPath: string];
  showOverview: [dirPath: string];
  sessionClick: [sessionId: string];
  sessionRename: [sessionId: string];
  commitRename: [sessionId: string, newName: string];
  cancelRename: [];
  requestClose: [sessionId: string, displayName: string];
  sessionStateChange: [sessionId: string, newState: string];
  toggleOverview: [sessionId: string];
  toggleLock: [sessionId: string, locked: boolean];
  showArtifacts: [sessionId: string];
  cancelSchedule: [sessionId: string];
  dismissNotification: [notificationId: string];
  dismissSessionNotifications: [sessionId: string];
}>();

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
    <!-- This toolbar only owns runtime-group creation. -->
    <div class="runtime-list-actions">
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

    <div ref="listEl" class="sessions-list" id="sessionsList">
      <template v-for="group in groups" :key="group.dirPath">
        <!-- Runtime groups always render (even empty); directory groups only when non-empty. -->
        <template v-if="group.sessions.length > 0 || group.kind === 'runtime'">
          <SessionGroup
            :group="{
              dirPath: group.dirPath,
              displayName: group.kind === 'runtime'
                ? group.displayName
                : resolveGroupDisplayName(group.dirPath, directories, projects),
              collapsed: group.collapsed,
              sessionCount: group.sessions.length,
              sessions: group.sessions.map(session => ({
                id: session.id,
                name: session.name !== session.cliType ? session.name : getCliDisplayName(session.cliType),
                activityLevel: sessionActivityLevels.get(session.id) || 'idle',
              })),
              kind: group.kind,
              groupId: group.groupId,
            }"
            :nav-index="navIndexMap.get(group.dirPath) ?? -1"
            :is-focused="isNavItemFocused(activeFocus, focusedNavItem, 'group-header', group.dirPath)"
            :flash-entry="group.collapsed ? groupFlashEntry(group.sessions) : null"
            @toggle-collapse="emit('toggleGroupCollapse', $event)"
            @show-overview="emit('showOverview', $event)"
            @rename="emit('groupRename', $event)"
            @close-group="emit('groupClose', $event)"
            @add-session="(gid, sid) => emit('groupAddSession', gid, sid)"
            @remove-session="emit('groupRemoveSession', $event)"
          />

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
              :session="{ id: session.id, name: session.name, cliType: session.cliType, title: session.title, cliSessionName: session.cliSessionName, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt, createdByPeerId: session.createdByPeerId, locked: session.locked }"
              :nav-index="navIndexMap.get(session.id) ?? -1"
              :session-state="sessionStates.get(session.id) || 'idle'"
              :activity-level="sessionActivityLevels.get(session.id) || 'idle'"
              :display-name="session.name !== session.cliType ? session.name : getCliDisplayName(session.cliType)"
              :draft-count="draftCounts.get(session.id) ?? 0"
              :artifact-count="artifactCounts.get(session.id) ?? 0"
              :loop-continues="session.loopContinues ?? 0"
              :elapsed-text="sessionElapsedText(session.id)"
              :working-plan-label="workingPlanLabels.get(session.id) || ''"
              :working-plan-tooltip="workingPlanTooltips.get(session.id) || ''"
              :is-active="activeSessionId === session.id"
              :is-focused="isNavItemFocused(activeFocus, focusedNavItem, 'session-card', session.id)"
              :focus-column="focusColumn"
              :is-editing="editingSessionId === session.id"
              :is-hidden-from-overview="isSessionHiddenFromOverview(session)"
              :scheduled-at="pendingSchedules.get(session.id) ?? null"
              :is-snapped-out="snappedOutSessions.has(session.id)"
              :llm-notifications="llmNotifications.get(session.id) ?? []"
              :flash-entry="flashEntries?.get(session.id) ?? null"
              :shortcut-key="sessionShortcutMap.get(session.id) ?? null"
              :preview-source="previewSourceFor(session.id)"
              :message-landed="landedSessionIds.has(session.id)"
              @click="emit('sessionClick', $event)"
              @rename="emit('sessionRename', $event)"
              @commit-rename="onCommitRename"
              @cancel-rename="emit('cancelRename')"
              @close="onRequestClose"
              @state-change="onSessionStateChange"
              @toggle-overview="emit('toggleOverview', $event)"
              @toggle-lock="(id: string, locked: boolean) => emit('toggleLock', id, locked)"
              @show-artifacts="emit('showArtifacts', $event)"
              @cancel-schedule="emit('cancelSchedule', $event)"
              @dismiss-notification="emit('dismissNotification', $event)"
              @dismiss-session-notifications="emit('dismissSessionNotifications', $event)"
            />
          </template>
        </template>
      </template>

      <div v-if="!hasSessions" class="sessions-empty">
        No active sessions
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
