<script setup lang="ts">
/**
 * SessionGroup.vue — collapsible group header for both directory and runtime groups.
 *
 * Directory groups keep the legacy header (chevron + name + overview drill-in).
 * Runtime groups add always-visible controls (rename ✎ / close ✕ / overview ▸)
 * and render as a drop target: dropping a session onto a runtime header moves it
 * in; dropping onto its own directory header removes it from its runtime group.
 */

export interface SessionGroupData {
  dirPath: string;
  displayName: string;
  collapsed: boolean;
  sessionCount: number;
  /** Member activity used to render one dot per session in the header. */
  sessions?: Array<{ id: string; name: string; activityLevel: string }>;
  /** 'runtime' groups render the extra controls + drop rules. */
  kind?: 'directory' | 'runtime';
  /** Runtime group id (kind === 'runtime'). Equals dirPath for runtime groups. */
  groupId?: string;
}

import { computed, ref } from 'vue';
import { state } from '../../state.js';
import { getActivityColor } from '../../state-colors.js';
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
  showOverview: [dirPath: string];
  rename: [groupId: string];
  closeGroup: [groupId: string];
  addSession: [groupId: string, sessionId: string];
  removeSession: [sessionId: string];
}>();

const isRuntime = computed(() => props.group.kind === 'runtime');

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
  const sid = draggedSessionId.value;
  if (!sid) return;
  const v = verdictFor(sid);
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = v.ok ? 'move' : 'none';
  dropState.value = v.ok ? 'ok' : 'bad';
}

function onDragLeave(): void {
  dropState.value = null;
}

function onDrop(e: DragEvent): void {
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
    class="group-header"
    :class="[
      { focused: isFocused, runtime: isRuntime },
      flashClass,
      dropState === 'ok' ? 'drop-ok' : dropState === 'bad' ? 'drop-bad' : '',
    ]"
    :data-dir-path="group.dirPath"
    :data-nav-index="navIndex"
    @click="emit('toggleCollapse', group.dirPath)"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <span class="group-chevron">{{ group.collapsed ? '▲' : '▼' }}</span>
    <span v-if="isRuntime" class="group-icon" aria-hidden="true">🗂️</span>

    <span
      class="group-name"
      style="cursor: pointer"
      title="Open group overview"
      @click.stop="emit('showOverview', group.dirPath)"
    >
      {{ group.displayName }} ({{ group.sessionCount }})
    </span>

    <div class="group-header-trailing">
      <div
        v-if="group.sessions?.length"
        class="group-activity-dots"
        role="img"
        :aria-label="activitySummary"
        title="Activity by session"
      >
        <span
          v-for="session in group.sessions"
          :key="session.id"
          class="group-activity-dot"
          :style="{ background: getActivityColor(session.activityLevel) }"
          :title="`${session.name}: ${session.activityLevel}`"
        />
      </div>

      <div v-if="isRuntime" class="group-header-actions">
        <button
          class="group-header-action overview"
          title="Overview of this group"
          @click.stop="emit('showOverview', group.dirPath)"
        >▸</button>
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
      <div v-else class="group-header-actions">
        <button
          class="group-header-action"
          title="Close all sessions in this folder"
          @click.stop="emit('closeGroup', group.dirPath)"
        >✕</button>
      </div>
    </div>
  </div>
</template>
