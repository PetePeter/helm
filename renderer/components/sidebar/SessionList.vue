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
import { isNavItemFocused } from '../../session-groups.js';
import { pickGroupFlashEntry } from '../../composables/useFlashAttention.js';
import { useSessionDrag } from '../../composables/useSessionDrag.js';

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
    <!-- Overview is a dock pane; this toolbar only owns runtime-group creation. -->
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

    <div class="sessions-list" id="sessionsList">
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
    </div>
  </div>
</template>
