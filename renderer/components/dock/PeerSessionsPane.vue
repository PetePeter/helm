<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import SessionList from '../sidebar/SessionList.vue';
import { sessionsState } from '../../screens/sessions-state.js';
import { useAppStore } from '../../stores/app.js';
import { useNavigationStore } from '../../stores/navigation.js';
import { useSessionsScreenStore } from '../../stores/sessions-screen.js';
import { usePeers } from '../../composables/usePeers.js';
import { refreshPeerSessions } from '../../peer-session-refresh.js';
import { peerSessionStore } from '../../peer-session-store.js';
import { getCliDisplayName } from '../../utils.js';
import { resolveGroupDisplayName } from '../../session-groups.js';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';

const props = defineProps<{ paneId: string }>();
const peerId = computed(() => props.paneId.slice('sessions:'.length));
const peers = usePeers();
const pane = useHelmMainPaneContext();
const state = useAppStore().state;
const navStore = useNavigationStore();
const sessionsScreenStore = useSessionsScreenStore();
const revision = ref(0);
let unsubscribe: (() => void) | undefined;

onMounted(() => {
  unsubscribe = peerSessionStore.subscribe(id => {
    if (id === peerId.value) revision.value++;
  });
});
onUnmounted(() => unsubscribe?.());

const peer = computed(() => peers.configuredPeers.value.find(item => item.id === peerId.value));
const snapshot = computed(() => {
  void revision.value;
  return peerSessionStore.get(peerId.value);
});
const online = computed(() => peer.value?.online === true && snapshot.value?.online !== false);
const attachedByRemoteId = computed(() => new Map(
  state.sessions
    .filter(session => session.remote?.peerId === peerId.value)
    .map(session => [session.remote!.sessionId, session]),
));
const rows = computed(() => (snapshot.value?.sessions ?? []).map(remote => {
  const attached = attachedByRemoteId.value.get(remote.id);
  return {
    id: attached?.id ?? remote.id,
    peerSessionId: remote.id,
    peerAttached: !!attached,
    name: attached?.name ?? remote.name,
    cliType: attached?.cliType ?? remote.cliType,
    activityLevel: remote.activityLevel ?? 'idle',
    state: remote.state,
    ...(attached?.remote ? { remote: attached.remote } : {}),
    ...(attached?.createdAt !== undefined ? { createdAt: attached.createdAt } : {}),
    ...(attached?.lastActiveAt !== undefined ? { lastActiveAt: attached.lastActiveAt } : {}),
  };
}));
const groups = computed(() => rows.value.length
  ? [{ dirPath: `peer:${peerId.value}`, displayName: peer.value?.alias ?? peerId.value, sessions: rows.value, collapsed: false, kind: 'peer' as const }]
  : []);
const navIndexMap = computed(() => new Map(sessionsState.navList.map((item, index) => [item.id, index])));
const emptyNotifications = new Map<string, Array<{ id: string; title: string; content: string; createdAt?: number }>>();

function refresh(): Promise<void> {
  return refreshPeerSessions(peerId.value);
}

async function attach(sessionId: string): Promise<void> {
  if (!online.value) return;
  const result = await peers.attachPeerSession(peerId.value, sessionId);
  if (result.ok && result.sessionId) pane.sidebar.onSessionClick(result.sessionId);
}

function sessionClick(sessionId: string): void {
  pane.sidebar.onSessionClick(sessionId);
}
</script>

<template>
  <section class="sessions-screen-section peer-sessions-pane">
    <div class="peer-sessions-status">
      <span>{{ online ? 'Online' : 'Offline' }} · {{ peer?.alias ?? peerId }}</span>
      <span v-if="!online && snapshot?.stale" class="peer-sessions-stale-label">Stale list</span>
      <button class="session-state-btn" type="button" :disabled="!online" @click="refresh">Refresh</button>
    </div>
    <SessionList
      :has-sessions="rows.length > 0"
      :groups="groups"
      :directories="[]"
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
      :llm-notifications="emptyNotifications"
      :get-cli-display-name="getCliDisplayName"
      :resolve-group-display-name="resolveGroupDisplayName"
      :is-session-hidden-from-overview="() => false"
      :session-elapsed-text="() => ''"
      :session-shortcut-map="sessionsScreenStore.sessionShortcutMap"
      source="peer"
      :list-id="`sessionsList-${peerId}`"
      :peer-offline="!online"
      :peer-stale="snapshot?.stale ?? false"
      @attach-peer-session="attach"
      @session-click="sessionClick"
      @request-close="pane.sidebar.onRequestClose"
      @commit-rename="pane.sidebar.onCommitRename"
      @cancel-rename="pane.sidebar.onCancelRename"
      @session-state-change="pane.sidebar.onSessionStateChange"
      @show-artifacts="pane.showArtifactsForSession"
    />
  </section>
</template>

<style scoped>
.peer-sessions-pane { min-height: 0; height: 100%; }
.peer-sessions-status {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
.peer-sessions-stale-label { color: var(--text-dim); }
</style>
