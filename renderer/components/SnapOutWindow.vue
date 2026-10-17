<script setup lang="ts">
/**
 * SnapOutWindow.vue — the shell for a snapped-out session.
 *
 * A pop-out is a full docking workspace on the `popout` profile, not a bare
 * terminal: terminal, plans, memories, mess and artifacts, all bound to the one
 * session this window exists for.
 *
 * Isolation is free rather than engineered. Each pop-out is its own
 * BrowserWindow, so Pinia and every module singleton are already per-window; the
 * shell only has to pin `activeSessionId` once and every pane — which reads the
 * store, not a prop — is correct from then on. Nothing is copied into props and
 * no pane learns that it is in a pop-out.
 */
import { computed, markRaw, onMounted, onUnmounted, ref, watch } from 'vue';
import { registerKeyHandler } from '../keyboard/router.js';
import { createDockShortcutKeyHandlers } from '../keyboard/handlers/workspace-keys.js';
import { createNumberKeyHandlers } from '../keyboard/handlers/number-keys.js';
import { installDockKeyRouter } from '../keyboard/install.js';
import { PANE_ARTIFACTS, PANE_TERMINAL, type DockMode, type DockSide, type DropTarget, type PaneId } from '../dock-types.js';
import { useAppStore } from '../stores/app.js';
import { useModalKeyboardBridge } from '../composables/useModalKeyboardBridge.js';
import { useToast } from '../composables/useToast.js';
import { useArtifactViewer } from '../composables/useArtifactViewer.js';
import { useArtifactSessionBinding } from '../composables/useArtifactSessionBinding.js';
import { usePlanWorkspaceController } from '../composables/usePlanWorkspaceController.js';
import { listRegisteredPanes, useDockWorkspace } from '../composables/useDockWorkspace.js';
import { provideHelmPaneContext } from '../dock-pane-context.js';
import DockViewMenu from './dock/DockViewMenu.vue';
import DockWorkspace from './dock/DockWorkspace.vue';
import PopOutTerminalPane from './dock/PopOutTerminalPane.vue';
import EscProtectionModal from './modals/EscProtectionModal.vue';
import { loadStoredSessions } from '../session-store.js';
import { refreshProjects } from '../projects-sync.js';
import { getCliDisplayName } from '../utils.js';
import { setPlanEditorOpener as setChipBarPlanEditorOpener } from '../stores/chip-bar.js';
import { useChipBarStore } from '../stores/chip-bar.js';
import { slotToIndex } from '../composables/useNumberAccelerator.js';
import { configClient, eventsClient, sessionsClient } from '../ipc/clients.js';

const props = defineProps<{ sessionId: string }>();

const appStore = useAppStore();
const chipBarStore = useChipBarStore();
// Pinned during setup, not in `onMounted`: child panes mount before the parent's
// mounted hook runs, so a later pin would let the terminal pane come up with no
// session. From here the window's session can never change, which is why no pane
// needs to know it is in a pop-out.
appStore.pinActiveSession(props.sessionId);
const { addToast } = useToast();
const artifactViewer = useArtifactViewer();
const planWorkspaceController = usePlanWorkspaceController();
const { handler: handleModalKeyboardBridge } = useModalKeyboardBridge();

// One shared pop-out layout for every snapped-out window: the panes are the
// same everywhere, so a per-session tree would only fragment the user's
// arrangement without ever meaning anything different.
const dockWorkspace = useDockWorkspace(undefined, {
  profile: 'popout',
  persistence: {
    load: () => configClient.configGetWorkspaceLayout('popout'),
    save: (layout) => configClient.configSetWorkspaceLayout(layout, 'popout'),
    viewportWidth: () => window.innerWidth,
  },
});

// The pop-out terminal owns its own PTY attachment instead of sharing the main
// window's TerminalManager, so the `terminal` pane resolves to a different
// component here; every other pane is the registry's.
const paneComponents = { [PANE_TERMINAL]: markRaw(PopOutTerminalPane) } as Readonly<Partial<Record<PaneId, typeof PopOutTerminalPane>>>;

const sessionInfo = computed(() => appStore.state.sessions.find(session => session.id === props.sessionId) ?? null);

/**
 * Panes mount once, with the session record already in the store.
 *
 * Every pane derives its binding from the pinned session — the plan pane from
 * its working directory, Mess from its project — and a pinned id never changes,
 * so there is no second `activeSessionId` edge to re-bind on. Rendering the dock
 * only once the record has loaded is what makes the single binding pass correct.
 */
const sessionLoaded = ref(false);

let unsubSessionUpdated: (() => void) | null = null;
let uninstallKeyRouter: (() => void) | null = null;
const keyHandlerCleanups: Array<() => void> = [];

// Register global bindings before pane setup so artifact-frame keydowns reach
// the complete pop-out router as soon as a pane is ready.
for (const handler of createDockShortcutKeyHandlers(onDockActivatePane, 'popout')) {
  keyHandlerCleanups.push(registerKeyHandler(handler));
}
for (const handler of createNumberKeyHandlers({
  jumpToSession: (slot) => { void sessionsClient.sessionRequestFocusSlot(slot); return true; },
  fireChipAction: (slot) => {
    const action = chipBarStore.actions[slotToIndex(slot)];
    if (!action) return false;
    void chipBarStore.triggerAction(action.sequence);
    return true;
  },
})) {
  keyHandlerCleanups.push(registerKeyHandler(handler));
}

// Artifacts follow the active session in both shells; here that is a constant,
// which is exactly the point of pinning.
useArtifactSessionBinding(artifactViewer);

function getFolderLabel(workingDir?: string): string {
  if (!workingDir) return 'No Folder';
  const parts = workingDir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}

/**
 * The window's identity: one derivation feeding both the OS title bar and the
 * header, so the two can never disagree about which session this window is.
 */
const identity = computed(() => {
  const session = sessionInfo.value;
  if (!session) return null;
  return {
    name: session.name,
    cli: getCliDisplayName(session.cliType || '') || session.cliType || 'Unknown CLI',
    folder: getFolderLabel(session.workingDir),
  };
});

function updateWindowTitle(): void {
  const parts = identity.value;
  document.title = parts ? `${parts.name} - ${parts.cli} - ${parts.folder}` : 'Snapped Out';
}

watch(sessionInfo, updateWindowTitle, { deep: true });

// ── Dock plumbing ──────────────────────────────────────────────────────────
// A pop-out has no view-transition manager to reconcile with, so pane
// activation is pure layout: the panes bind themselves to the pinned session.

function onDockFocusPane(paneId: PaneId, focusedItemId?: string): void {
  dockWorkspace.focusPane(paneId, focusedItemId);
}

function onDockActivatePane(paneId: PaneId): void {
  if (!dockWorkspace.isOpen(paneId)) dockWorkspace.restore(paneId);
  dockWorkspace.activate(paneId);
  dockWorkspace.focusPane(paneId);
}

function onDockClosePane(paneId: PaneId): void {
  try { dockWorkspace.close(paneId); }
  catch { /* The model refuses to empty the workspace; the layout is unchanged. */ }
}

function onDockRevealPane(paneId: PaneId): void {
  dockWorkspace.reveal(paneId);
}

function onDockAutohideClose(paneId: PaneId): void {
  dockWorkspace.unreveal(paneId);
}

function onDockSetMode(paneId: PaneId, mode: DockMode): void {
  dockWorkspace.setMode(paneId, mode);
  if (mode !== 'pinned') dockWorkspace.unreveal(paneId);
}

function onDockResize(path: number[], sizes: number[]): void {
  dockWorkspace.resize(path, sizes);
}

function onDockMovePane(paneId: PaneId, target: DropTarget): void {
  try { dockWorkspace.move(paneId, target); }
  catch { /* An invalid drop leaves the previous layout in place. */ }
}

function onDockReorderTab(paneId: PaneId, index: number): void {
  try { dockWorkspace.reorder(paneId, index); }
  catch { /* Reorder is clamped by the model; an unknown pane is ignored. */ }
}

// The View menu is the only way back from a closed pane. The main window's
// handlers additionally reconcile a view transition; a pop-out has none, so the
// two lines here are the whole behaviour rather than a copy of that logic.
const dockViewMenuOpen = ref(false);
const dockViewItems = computed(() => listRegisteredPanes(dockWorkspace.layout.value, 'popout'));

function onDockViewToggle(paneId: PaneId): void {
  dockViewMenuOpen.value = false;
  if (dockWorkspace.isOpen(paneId)) onDockClosePane(paneId);
  else onDockActivatePane(paneId);
}

function onDockLayoutReset(): void {
  dockWorkspace.reset();
  dockViewMenuOpen.value = false;
}

function onDockPaneEdge(paneId: PaneId, side: DockSide): void {
  try { dockWorkspace.dockToEdge(paneId, side); }
  catch { /* Docking the last remaining pane to an edge is rejected. */ }
}

// The one seam panes read from. `sidebar` is absent by design: no pop-out pane
// drives the session list, and the controller belongs to the main-window
// bootstrap graph. The remaining main-window entry points get honest no-ops —
// this window cannot switch sessions, and it is already popped out.
provideHelmPaneContext({
  terminalContainerRef: ref(null),
  planWorkspace: planWorkspaceController,
  groups: {
    newGroup: () => {},
    newGroupWithSession: () => {},
    rename: () => {},
    close: () => {},
    addSession: () => {},
    removeSession: () => {},
  },
  showArtifactsForSession: (sessionId: string) => {
    if (sessionId === props.sessionId) onDockActivatePane(PANE_ARTIFACTS);
  },
  popOutArtifacts: () => {},
});

onMounted(async () => {
  // A failed session load must not abort the rest of the boot: the panes bind
  // to the pinned id, not to the record, so a blank title is recoverable but a
  // window that never reaches `sessionLoaded` renders nothing at all.
  try {
    const sessions = await loadStoredSessions();
    const session = sessions.find(entry => entry.id === props.sessionId);
    if (session) appStore.upsertSession(session);
  } catch (error) {
    console.error('[SnapOut] Failed to load session record:', error);
  }
  updateWindowTitle();

  // The Mess pane derives its project from the pinned session, so the project
  // mirror has to exist in this window too.
  void refreshProjects();
  artifactViewer.ensureSubscribed();
  void artifactViewer.setActiveSession(props.sessionId);

  await dockWorkspace.loadPersisted();
  // Session record and layout are both settled: the panes now mount once, into
  // their final positions.
  sessionLoaded.value = true;

  unsubSessionUpdated = eventsClient.onSessionUpdated?.((updatedSession: any) => {
    if (updatedSession?.id !== props.sessionId) return;
    appStore.upsertSession(updatedSession);
  }) ?? null;

  setChipBarPlanEditorOpener(() => {});

  // The modal bridge registers at `modal` scope, which is what guarantees an
  // open picker outranks the focused pane without a listener race.
  keyHandlerCleanups.push(registerKeyHandler({
    id: 'modal-stack-bridge',
    scope: 'modal',
    handle: (ctx) => handleModalKeyboardBridge(ctx.event),
  }));
  uninstallKeyRouter = installDockKeyRouter({
    getActiveSessionId: () => appStore.state.activeSessionId ?? null,
    getFocusedPane: () => dockWorkspace.focusedPaneId.value,
    isPaneVisible: (pane) => dockWorkspace.isVisible(pane),
    isPanelOpen: () => false,
  });
});

onUnmounted(() => {
  for (const cleanup of keyHandlerCleanups.splice(0)) cleanup();
  uninstallKeyRouter?.();
  uninstallKeyRouter = null;
  unsubSessionUpdated?.();
  unsubSessionUpdated = null;
});
</script>

<template>
  <div class="snap-out-window" id="mainArea">
    <header class="app-header">
      <span class="sidebar-brand">
        <span class="sidebar-title">{{ identity?.name ?? 'Snapped Out' }}</span>
        <span v-if="identity" class="sidebar-tagline">{{ identity.cli }} · {{ identity.folder }}</span>
      </span>
      <div class="sidebar-actions">
        <!-- View only: help, logs and settings are app-global and stay in the main window. -->
        <DockViewMenu
          :open="dockViewMenuOpen"
          :items="dockViewItems"
          @open="dockViewMenuOpen = true"
          @close="dockViewMenuOpen = false"
          @toggle="onDockViewToggle"
          @reset="onDockLayoutReset"
        />
      </div>
    </header>
    <div class="snap-out-body">
      <DockWorkspace
        v-if="sessionLoaded"
        :layout="dockWorkspace.layout.value"
        :focused-pane-id="dockWorkspace.focusedPaneId.value"
        :focus-request-id="dockWorkspace.focusRequestId.value"
        :revealed-pane-ids="dockWorkspace.revealedPanes.value"
        :pane-components="paneComponents"
        @focus-pane="onDockFocusPane"
        @activate-pane="onDockActivatePane"
        @close-pane="onDockClosePane"
        @resize-split="onDockResize"
        @reveal-pane="onDockRevealPane"
        @autohide-close="onDockAutohideClose"
        @set-dock-mode="onDockSetMode"
        @move-pane="onDockMovePane"
        @reorder-tab="onDockReorderTab"
        @dock-pane-edge="onDockPaneEdge"
      />
    </div>
    <EscProtectionModal />
  </div>
</template>

<style scoped>
.snap-out-window { width: 100vw; height: 100vh; background: #0a0a0a; display: flex; flex-direction: column; }
.snap-out-body { flex: 1; min-height: 0; display: flex; flex-direction: row; }
.snap-out-body > :deep(.dock-workspace) { flex: 1; min-width: 0; min-height: 0; }
</style>
