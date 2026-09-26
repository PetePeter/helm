<script setup lang="ts">
/**
 * SessionsPane — the `sessions` tool window (sort bar + grouped session list).
 *
 * The sort bar belongs to the list it sorts, so both live in one pane. Session
 * data comes from the existing singletons; only the handlers the shell owns
 * arrive through the pane context.
 */
import { computed } from 'vue';
import SortBar from '../sidebar/SortBar.vue';
import SessionList from '../sidebar/SessionList.vue';
import OperatorSection from '../sidebar/OperatorSection.vue';
import { sessionsState } from '../../screens/sessions-state.js';
import { useAppStore } from '../../stores/app.js';
import { useNavigationStore } from '../../stores/navigation.js';
import { useSessionsScreenStore } from '../../stores/sessions-screen.js';
import { useLlmNotificationsStore } from '../../stores/llmNotifications.js';
import { useFlashAttention } from '../../composables/useFlashAttention.js';
import { useRecycleBin } from '../../composables/useRecycleBin.js';
import { isSessionHiddenFromOverview, resolveGroupDisplayName } from '../../session-groups.js';
import { getCliDisplayName } from '../../utils.js';
import { formatElapsed } from '../../../src/utils/time-parser.js';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'cliType', label: 'CLI Type' },
  { value: 'state', label: 'State' },
  { value: 'activity', label: 'Activity' },
];

const pane = useHelmMainPaneContext();
const sidebar = pane.sidebar;
const state = useAppStore().state;
const navStore = useNavigationStore();
const sessionsScreenStore = useSessionsScreenStore();
const llmNotificationsStore = useLlmNotificationsStore();
const flashAttention = useFlashAttention();
const recycleBin = useRecycleBin();

// Maps each navList item's id → its index — fed to session cards/group headers as
// data-nav-index so the legacy updateSessionsFocus() can find focused elements.
const navIndexMap = computed(() => {
  const map = new Map<string, number>();
  sessionsState.navList.forEach((item, i) => { map.set(item.id, i); });
  return map;
});

function sessionElapsedText(sessionId: string): string {
  // Touch the __tick__ sentinel to re-evaluate reactively
  state.lastOutputTimes.get('__tick__');
  const ts = state.lastOutputTimes.get(sessionId);
  if (ts === undefined) return '';
  return formatElapsed(Date.now() - ts);
}
</script>

<template>
  <section class="sessions-screen-section">
    <OperatorSection @open="sidebar.onSessionClick" />
    <SortBar
      :options="SORT_OPTIONS"
      :field="sidebar.getSortField()"
      :direction="sidebar.getSortDirection()"
      @change="sidebar.onSortChange"
    />
    <SessionList
      :has-sessions="state.sessions.length > 0"
      :groups="sessionsState.groups"
      :directories="sessionsState.directories"
      :projects="state.projects"
      :nav-index-map="navIndexMap"
      :active-focus="sessionsState.activeFocus"
      :focused-nav-item="navStore.focusedNavItem"
      :focus-column="sessionsState.cardColumn"
      :active-session-id="state.activeSessionId"
      :editing-session-id="sessionsState.editingSessionId"
      :session-states="state.sessionStates"
      :session-activity-levels="state.sessionActivityLevels"
      :draft-counts="state.draftCounts"
      :artifact-counts="state.artifactCounts"
      :working-plan-labels="state.workingPlanLabels"
      :working-plan-tooltips="state.workingPlanTooltips"
      :pending-schedules="state.pendingSchedules"
      :snapped-out-sessions="state.snappedOutSessions"
      :llm-notifications="llmNotificationsStore.bySession"
      :flash-entries="flashAttention.entries"
      :get-cli-display-name="getCliDisplayName"
      :resolve-group-display-name="resolveGroupDisplayName"
      :is-session-hidden-from-overview="(session) => isSessionHiddenFromOverview(session, sessionsState.groupPrefs)"
      :session-elapsed-text="sessionElapsedText"
      :session-shortcut-map="sessionsScreenStore.sessionShortcutMap"
      :preview-mode="sessionsState.groupPrefs.sessionPreviewMode"
      @new-group="pane.groups.newGroup"
      @new-group-with-session="pane.groups.newGroupWithSession"
      @group-rename="pane.groups.rename"
      @group-close="pane.groups.close"
      @group-add-session="pane.groups.addSession"
      @group-remove-session="pane.groups.removeSession"
      @toggle-group-collapse="sidebar.onGroupToggleCollapse"
      @show-overview="sidebar.onShowOverview"
      @session-click="sidebar.onSessionClick"
      @session-rename="sidebar.onSessionRename"
      @commit-rename="sidebar.onCommitRename"
      @cancel-rename="sidebar.onCancelRename"
      @request-close="sidebar.onRequestClose"
      @session-state-change="sidebar.onSessionStateChange"
      @toggle-overview="sidebar.onToggleOverview"
      @toggle-lock="sidebar.onToggleLock"
      @show-artifacts="pane.showArtifactsForSession"
      @cancel-schedule="sidebar.onCancelSchedule"
      @dismiss-notification="llmNotificationsStore.dismiss"
      @dismiss-session-notifications="llmNotificationsStore.dismissSession"
    />
    <button
      class="recycle-bin-btn focusable"
      type="button"
      title="Recycle Bin — restore closed sessions"
      @click="recycleBin.modalVisible.value = true"
    >
      <span class="recycle-bin-icon">🗑️</span>
      <span class="recycle-bin-label">Recycle Bin</span>
      <span v-if="recycleBin.count.value > 0" class="recycle-bin-badge">{{ recycleBin.count.value }}</span>
    </button>
  </section>
</template>
