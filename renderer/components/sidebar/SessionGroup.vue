<script setup lang="ts">
/**
 * SessionGroup.vue — a group's box: its header plus its session rows (the default
 * slot), bordered and tinted in the group colour. The whole box is the drop
 * target, so a session can be dropped anywhere on the group, not just its title.
 *
 * Directory groups keep the legacy header (chevron + name).
 * Runtime groups add controls and render as a drop target. Peer groups are a
 * compact read-only header for a computer's source-parameterized Sessions list.
 */

export interface SessionGroupData {
  dirPath: string;
  displayName: string;
  collapsed: boolean;
  sessionCount: number;
  totalSessionCount?: number;
  /** Member activity used to render one dot per session in the header. */
  sessions?: Array<{ id: string; name: string; activityLevel: string }>;
  /** 'peer' groups render read-only controls for a remote Sessions source. */
  kind?: 'directory' | 'runtime' | 'peer';
  /** Runtime group id (kind === 'runtime'). Equals dirPath for runtime groups. */
  groupId?: string;
  /** Box colour; absent = the neutral grey. */
  color?: string;
}

import { computed, ref } from 'vue';
import { state } from '../../state.js';
import ContextRing from './ContextRing.vue';
import { useSessionDrag } from '../../composables/useSessionDrag.js';
import { useRuntimeGroups } from '../../composables/useRuntimeGroups.js';
import { dropVerdict, type DropTarget } from '../../runtime-group-drop.js';

const props = defineProps<{
  group: SessionGroupData;
  navIndex: number;
  isFocused: boolean;
  /** When the group is collapsed and a member session is flashing, drives the header flash. */
  flashEntry?: { phase: 'pulse' | 'solid' } | null;
}>();

const emit = defineEmits<{
  toggleCollapse: [dirPath: string];
  rename: [groupId: string];
  closeGroup: [groupId: string];
  addSession: [groupId: string, sessionId: string];
  removeSession: [sessionId: string];
}>();

const isRuntime = computed(() => props.group.kind === 'runtime');
const isPeer = computed(() => props.group.kind === 'peer');

const activitySummary = computed(() => {
  const sessions = props.group.sessions ?? [];
  if (sessions.length === 0) return 'No active sessions';
  return `${sessions.length} session${sessions.length === 1 ? '' : 's'}: ${sessions.map(session => `${session.name} ${session.activityLevel}`).join(', ')}`;
});

const flashClass = computed(() => {
  if (!props.flashEntry) return '';
  return props.flashEntry.phase === 'solid' ? 'flash-solid' : 'flash-pulse';
});

// --- Drag & drop ---

const { draggedSessionId } = useSessionDrag();
const { groups: runtimeGroups } = useRuntimeGroups();
const dropState = ref<'ok' | 'bad' | null>(null);

const dropTarget = computed<DropTarget>(() => ({
  kind: isRuntime.value ? 'runtime' : 'directory',
  id: isRuntime.value ? (props.group.groupId ?? props.group.dirPath) : props.group.dirPath,
}));

/** The full session behind a header dot, for its context ring (the group data carries only id/name/activity). */
const stateSession = (sessionId: string) => state.sessions.find(s => s.id === sessionId);

/** Resolve a verdict for the currently dragged session against this header. */
function verdictFor(sessionId: string) {
  const session = state.sessions.find(s => s.id === sessionId);
  const dir = session?.projectPath ?? session?.workingDir ?? '';
  const currentGroup = runtimeGroups.value.find(g => g.sessionIds.includes(sessionId)) ?? null;
  return dropVerdict(
    dropTarget.value,
    sessionId,
    dir,
    currentGroup?.id ?? null,
    props.group.displayName,
    props.group.displayName,
  );
}

function onDragOver(e: DragEvent): void {
  if (isPeer.value) return;
  const sid = draggedSessionId.value;
  if (!sid) return;
  const v = verdictFor(sid);
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = v.ok ? 'move' : 'none';
  dropState.value = v.ok ? 'ok' : 'bad';
}

/** Moving between rows inside the box fires dragleave too; only leaving the box counts. */
function onDragLeave(e: DragEvent): void {
  const into = e.relatedTarget as Node | null;
  if (into && (e.currentTarget as HTMLElement).contains(into)) return;
  dropState.value = null;
}

function onDrop(e: DragEvent): void {
  if (isPeer.value) return;
  const sid = draggedSessionId.value;
  dropState.value = null;
  if (!sid) return;
  const v = verdictFor(sid);
  if (!v.ok) return;
  e.preventDefault();
  if (v.action === 'add-to-group') {
    emit('addSession', dropTarget.value.id, sid);
  } else if (v.action === 'remove-from-group') {
    emit('removeSession', sid);
  }
}
</script>

<template>
  <div
    class="session-group-box"
    :class="dropState === 'ok' ? 'drop-ok' : dropState === 'bad' ? 'drop-bad' : ''"
    :style="group.color ? { '--group-color': group.color } : undefined"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
  <div
    class="group-header"
    :class="[{ focused: isFocused, runtime: isRuntime }, flashClass]"
    :data-dir-path="group.dirPath"
    :data-nav-index="navIndex"
    @click="!isPeer && emit('toggleCollapse', group.dirPath)"
  >
    <span v-if="!isPeer" class="group-chevron">{{ group.collapsed ? '▲' : '▼' }}</span>
    <span v-if="isRuntime" class="group-icon" aria-hidden="true">🗂️</span>
    <span v-else-if="isPeer" class="group-icon" aria-hidden="true" title="Sessions on this computer">🖥️</span>

    <span class="group-name" :title="isPeer ? 'Sessions on this computer' : undefined">
      {{ group.displayName }} ({{ group.sessionCount }}<template v-if="!isPeer">/{{ group.totalSessionCount ?? group.sessionCount }}</template>)
    </span>

    <div class="group-header-trailing">
      <div
        v-if="group.sessions?.length"
        class="group-activity-dots"
        role="img"
        :aria-label="activitySummary"
        title="Activity by session"
      >
        <ContextRing
          v-for="session in group.sessions"
          :key="session.id"
          :size="14"
          :activity-level="session.activityLevel"
          :cli-type="stateSession(session.id)?.cliType"
          :context-usage="stateSession(session.id)?.contextUsage"
          :quota-usage="stateSession(session.id)?.quotaUsage"
          :context-history="stateSession(session.id)?.contextHistory"
          :title="`${session.name}: ${session.activityLevel}`"
        />
      </div>

      <div v-if="isRuntime" class="group-header-actions">
        <button
          class="group-header-action"
          title="Rename group"
          @click.stop="emit('rename', group.groupId ?? group.dirPath)"
        >✎</button>
        <button
          class="group-header-action"
          title="Close group"
          @click.stop="emit('closeGroup', group.groupId ?? group.dirPath)"
        >✕</button>
      </div>
      <div v-else-if="!isPeer" class="group-header-actions">
        <button
          class="group-header-action"
          title="Close all sessions in this folder"
          @click.stop="emit('closeGroup', group.dirPath)"
        >✕</button>
      </div>
    </div>
  </div>
  <slot />
  </div>
</template>

<style scoped>
/* ── Group box: header + its session rows ──────────────────── */

/* Folder groups are neutral grey; a custom group sets
   --group-color inline from its picked palette colour. */
.session-group-box {
  --group-color: #5a606b;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  padding: 2px;
  margin-top: 8px;
  border: 3px solid color-mix(in srgb, var(--group-color) 60%, transparent);
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, var(--group-color) 10%, transparent);
}
.session-group-box:first-child { margin-top: 0; }

/* ── Group header ─────────────────────────────────────────── */

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px 12px;
  min-height: 52px;
  cursor: pointer;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  background: transparent;
  user-select: none;
}
.group-header:hover { background: var(--bg-tertiary); }
.group-header.focused {
  border-color: var(--accent);
  background: var(--bg-tertiary);
}

.group-chevron {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}

.group-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-header-trailing {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* One dot per member, kept visible when the group is collapsed. */
.group-activity-dots {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border: 1px solid rgba(115, 125, 145, 0.28);
  border-radius: 999px;
  background: rgba(10, 11, 13, 0.3);
}

/* ── Runtime (custom) groups ──────────────────────────────── */

/* Group header action buttons (rename / close) */
.group-header-actions {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
.group-header-action {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1;
}
.group-header-action:hover {
  background: rgba(120, 130, 150, 0.2);
  color: var(--text-primary);
}

/* Drop-target highlighting */
.session-group-box.drop-ok {
  outline: 2px solid var(--activity-active, #44cc44);
  outline-offset: 1px;
}
.session-group-box.drop-bad {
  outline: 2px dashed #6a3a3a;
  outline-offset: 1px;
  opacity: 0.6;
}

/* The group owns this copy of the keyframes because its header is a separate scoped component. */
@keyframes flash-beat {
  0%,   49% { background-color: var(--bg-secondary); color: var(--text-primary); }
  50%, 100% { background-color: var(--accent);  color: var(--accent-contrast); }
}
.group-header.flash-pulse {
  animation: flash-beat 1s infinite;
}
.group-header.flash-solid {
  background-color: var(--accent) !important;
  color: var(--accent-contrast);
}
/* ContextRing renders the dot under its own scope id; deep keeps it readable during the group flash. */
.group-header.flash-pulse :deep(.context-ring__dot),
.group-header.flash-solid :deep(.context-ring__dot) {
  box-shadow: 0 0 0 1px var(--accent-contrast);
}
/* ContextRing and its group buttons render descendants with child scope ids, so deep is required for inherited flash text. */
.group-header.flash-pulse :deep(:where(span, button)),
.group-header.flash-solid :deep(:where(span, button)) {
  color: inherit !important;
}
</style>
