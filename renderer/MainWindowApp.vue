<script setup lang="ts">
/**
 * MainWindowApp.vue -- main Helm window shell.
 *
 * Owns the full layout: sidebar (left) + main area (right) + modals.
 * Composables handle bootstrap, navigation, and gamepad input.
 * Components are presentational — they receive props and emit events.
 */

declare global {
  interface Window {
    openLegacyBindingEditor?: (button: string, cliType: string, binding: any) => void;
  }
}

import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { sessionsState } from './screens/sessions-state.js';
import { useAppStore } from './stores/app.js';
import { adoptTerminalHost, getTerminalManager } from './runtime/terminal-provider.js';
import { getCliDisplayName } from './utils.js';
import { initConfigCache } from './bindings.js';
import { doSpawn, doSpawnShell, switchToSession, doCloseSession,
  bootstrap, teardown, startTimerRefresh, stopTimerRefresh,
  setPendingContextText, restoreSnappedBackSession, refreshProjects, refreshSessions,
  cycleActiveSession,
} from './composables/useAppBootstrap.js';
import { createWorkspaceKeyHandlers } from './keyboard/handlers/workspace-keys.js';
import { registerKeyHandler } from './keyboard/router.js';
import { installDockKeyRouter } from './keyboard/install.js';
import { useTerminalKeys } from './composables/useTerminalKeys.js';
import { resolveGroupDisplayName } from './session-groups.js';
import { onPlanContextSave } from './plans/plan-screen.js';
import { getActiveSessionDir } from './stores/app.js';
import { onViewChange, type MainView as ViewName } from './main-view/main-view-manager.js';
import { useToast } from './composables/useToast.js';
import { useSettingsController } from './composables/useSettingsController.js';
import { useInputRouter } from './composables/useInputRouter.js';
import { useSidebarController } from './composables/useSidebarController.js';
import { useRecycleBin } from './composables/useRecycleBin.js';
import { useArtifactViewer } from './composables/useArtifactViewer.js';
import { useArtifactSessionBinding } from './composables/useArtifactSessionBinding.js';
import { useRuntimeGroups } from './composables/useRuntimeGroups.js';
import { useRuntimeGroupActions } from './composables/useRuntimeGroupActions.js';
import { useDraftPlanContextEditor } from './composables/useDraftPlanContextEditor.js';
import { usePlanWorkspaceController } from './composables/usePlanWorkspaceController.js';
import { appClient, configClient, deliveryClient, draftsClient, eventsClient, sessionsClient, systemClient } from './ipc/clients.js';
import {
  contextMenu,
  openQuickSpawn,
  draftSubmenu,
  toolEditor,
  isAnyBridgeModalVisible,
  showAppCloseConfirm,
  showFolderCloseConfirm,
  openRuntimeGroupMoveSubmenu,
} from './stores/modal-bridge.js';
import { showEditorPopup } from './editor/editor-popup.js';
import { usePromptApplyFlow } from './composables/usePromptApplyFlow.js';
import DraftEditor from './components/panels/DraftEditor.vue';
import type { ScheduledTask } from '../../src/types/scheduled-task.js';
import {
  setDraftEditorOpener as setDraftEditorCompatibilityOpener,
  setPlanEditorOpener as setPlanEditorCompatibilityOpener,
  setDraftEditorCloser as setDraftEditorCompatibilityCloser,
  setDraftEditorVisibilityChecker as setDraftEditorCompatibilityVisibilityChecker,
  setDraftEditorButtonHandler as setDraftEditorCompatibilityButtonHandler,
  setPlanChangesChecker as setPlanCompatibilityChangesChecker,
} from './stores/draft-editor-registry.js';
import {
  setPlanEditorOpener as setChipBarPlanEditorOpener,
} from './stores/chip-bar.js';
import {
  setPlanEditorOpener as setPlanScreenPlanEditorOpener,
  setDraftEditorCloser as setPlanScreenDraftEditorCloser,
  setDraftEditorVisibilityChecker as setPlanScreenDraftEditorVisibilityChecker,
  setPlanChangesChecker as setPlanScreenPlanChangesChecker,
  setPlanScreenContextEditorOpener,
} from './plans/plan-screen.js';
import { deliverBulkText } from './paste-handler.js';
import { deliverPromptSequence } from './sequence-delivery.js';

// Docking workspace — every view/tool window is resolved through the registry.
import { provideHelmPaneContext } from './dock-pane-context.js';
import { setPaneVisibilityBridge } from './dock-visibility-bridge.js';
import {
  PANE_ARTIFACTS,
  PANE_OVERVIEW,
  PANE_PLAN_SCREEN,
  PANE_TERMINAL,
} from './dock-types.js';
import { confirmCloseSessionById } from './screens/sessions.js';

// Sidebar components
import StatusStrip from './components/sidebar/StatusStrip.vue';
import RecycleBinModal from './components/sidebar/RecycleBinModal.vue';
import SettingsPanel from './components/sidebar/SettingsPanel.vue';

// Settings tab components
import BindingsTab from './components/sidebar/BindingsTab.vue';
import ToolsTab from './components/sidebar/ToolsTab.vue';
import TelegramTab from './components/sidebar/TelegramTab.vue';
import ProjectsTab from './components/sidebar/ProjectsTab.vue';
import ChipbarActionsTab from './components/sidebar/ChipbarActionsTab.vue';
import McpTab from './components/sidebar/McpTab.vue';
import PeersTab from './components/sidebar/PeersTab.vue';
import PeerPairingDialog from './components/modals/PeerPairingDialog.vue';
import MobileTab from './components/sidebar/MobileTab.vue';
import MobilePairingDialog from './components/modals/MobilePairingDialog.vue';
import { usePeers } from './composables/usePeers.js';
import SkillsTab from './components/sidebar/SkillsTab.vue';

import { loadSessions } from './screens/sessions.js';

import AppModalHost from './components/app/AppModalHost.vue';
import PendingHandoverModal from './components/modals/PendingHandoverModal.vue';

const appStore = useAppStore();
const state = appStore.state;
import { useChipBarStore } from './stores/chip-bar.js';
import { useNavigationStore } from './stores/navigation.js';
import { useSessionsScreenStore } from './stores/sessions-screen.js';
import { slotToIndex } from './composables/useNumberAccelerator.js';
import { resolveFocusSlot } from './composables/focus-slot.js';
import { useLlmNotificationsStore } from './stores/llmNotifications.js';
import { useFlashAttention } from './composables/useFlashAttention.js';
import { listRegisteredPanes, useDockWorkspace } from './composables/useDockWorkspace.js';
import DockViewMenu from './components/dock/DockViewMenu.vue';
import DockWorkspace from './components/dock/DockWorkspace.vue';
import type { DockMode, DockSide, DropTarget, PaneId } from './dock-types.js';

// ============================================================================
// Reactive view state
// ============================================================================

const activeView = ref<'terminal' | 'overview' | 'plan'>('terminal');
const settingsVisible = ref(false);
const terminalContainerRef = ref<HTMLElement | null>(null);
const chipBarStore = useChipBarStore();
const navStore = useNavigationStore();
const sessionsScreenStore = useSessionsScreenStore();
const llmNotificationsStore = useLlmNotificationsStore();
const flashAttention = useFlashAttention();
const recycleBin = useRecycleBin();
const runtimeGroups = useRuntimeGroups();
const runtimeGroupActions = useRuntimeGroupActions();
const artifactViewer = useArtifactViewer();
const peers = usePeers();

// The layout tree is persisted through the app-data config boundary. Legacy
// localStorage widths/visibility are read only by the persistence adapter when
// no versioned layout exists yet.
const dockWorkspace = useDockWorkspace(undefined, {
  persistence: {
    load: () => configClient.configGetWorkspaceLayout(),
    save: (layout) => configClient.configSetWorkspaceLayout(layout),
    viewportWidth: () => window.innerWidth,
  },
});
const dockViewMenuOpen = ref(false);

// The imperative gamepad navigation in `screens/` decides whether to skip a
// zone. The dock is the only collapse authority, so it answers that question
// directly rather than a parallel set of collapse booleans.
setPaneVisibilityBridge(dockWorkspace.isVisible);

// A recursive dock renderer may move the host while keeping the workspace
// alive. TerminalManager adopts the existing DOM so xterm scrollback and PTY
// ownership remain attached to the same session.
watch(terminalContainerRef, (container) => {
  adoptTerminalHost(container);
}, { flush: 'post' });

const dockViewItems = computed(() => listRegisteredPanes(dockWorkspace.layout.value));

const viewPaneByName: Record<ViewName, PaneId> = {
  terminal: PANE_TERMINAL,
  overview: PANE_OVERVIEW,
  plan: PANE_PLAN_SCREEN,
};
const viewNameByPane = new Map<PaneId, ViewName>([
  [PANE_TERMINAL, 'terminal'],
  [PANE_OVERVIEW, 'overview'],
  [PANE_PLAN_SCREEN, 'plan'],
]);

function syncViewFromDockLayout(): void {
  const activePane = ([PANE_TERMINAL, PANE_OVERVIEW, PANE_PLAN_SCREEN] as const)
    .find(paneId => dockWorkspace.isOpen(paneId) && dockWorkspace.isVisible(paneId));
  const view = activePane ? viewNameByPane.get(activePane) : undefined;
  if (view) activeView.value = view;
}

function fallbackToOpenView(): void {
  if (dockWorkspace.isOpen(viewPaneByName[activeView.value])) return;
  const fallback = ([PANE_TERMINAL, PANE_OVERVIEW, PANE_PLAN_SCREEN] as const)
    .find(paneId => dockWorkspace.isOpen(paneId));
  const view = fallback ? viewNameByPane.get(fallback) : undefined;
  if (view) activeView.value = view;
}

let dockNavigationRequest = 0;

/**
 * Select a pane through one shell-owned path. View panes must pass through the
 * navigation store so their existing mount/unmount lifecycle initializes data;
 * tool panes only need dock activation/focus.
 */
async function activateDockPane(paneId: PaneId, reveal = false, focusedItemId?: string): Promise<void> {
  const requestId = ++dockNavigationRequest;
  try {
    if (!dockWorkspace.isOpen(paneId)) dockWorkspace.restore(paneId);
    if (reveal) dockWorkspace.reveal(paneId);
    else dockWorkspace.activate(paneId);
  } catch {
    return;
  }

  if (paneId === PANE_OVERVIEW) {
    await navStore.openOverview(null, state.activeSessionId ?? undefined);
  } else if (paneId === PANE_PLAN_SCREEN) {
    const dirPath = getActiveSessionDir();
    if (dirPath) await navStore.openPlan(dirPath);
  } else if (paneId === PANE_TERMINAL) {
    if (activeView.value === 'overview') await navStore.closeOverview();
    else if (activeView.value === 'plan') await navStore.closePlan();
  } else if (paneId === PANE_ARTIFACTS) {
    // ArtifactViewer retains content/session state for snapped-out windows;
    // dock visibility itself remains owned by the workspace tree.
    artifactViewer.showPanel();
  }

  if (requestId !== dockNavigationRequest) return;
  dockWorkspace.focusPane(paneId, focusedItemId);
}

async function closeDockPane(paneId: PaneId): Promise<void> {
  const view = viewNameByPane.get(paneId);
  const wasActiveView = view === activeView.value;

  if (wasActiveView && view === 'overview') await navStore.closeOverview();
  else if (wasActiveView && view === 'plan') await navStore.closePlan();

  try {
    dockWorkspace.close(paneId);
  } catch {
    return;
  }

  if (paneId === PANE_ARTIFACTS) artifactViewer.hidePanel();

  if (wasActiveView && view === 'terminal') {
    const fallback = ([PANE_OVERVIEW, PANE_PLAN_SCREEN] as const)
      .find(candidate => dockWorkspace.isOpen(candidate));
    if (fallback) void activateDockPane(fallback);
    else fallbackToOpenView();
  }
}

function onDockViewToggle(paneId: PaneId): void {
  dockViewMenuOpen.value = false;
  if (dockWorkspace.isOpen(paneId)) void closeDockPane(paneId);
  else void activateDockPane(paneId);
}

function onDockLayoutReset(): void {
  dockNavigationRequest++;
  dockWorkspace.reset();
  if (activeView.value === 'overview') void navStore.closeOverview();
  else if (activeView.value === 'plan') void navStore.closePlan();
  activeView.value = 'terminal';
  dockViewMenuOpen.value = false;
}

function onDockFocusPane(paneId: PaneId, focusedItemId?: string): void {
  const view = viewNameByPane.get(paneId);
  if (view && view !== activeView.value) {
    void activateDockPane(paneId, false, focusedItemId);
    return;
  }
  dockWorkspace.focusPane(paneId, focusedItemId);
}

function onDockActivatePane(paneId: PaneId): void {
  void activateDockPane(paneId);
}

function onDockClosePane(paneId: PaneId): void {
  void closeDockPane(paneId);
}

/**
 * Opening an edge rail reveals the dock and hands it focus — an opened pane the
 * user can see is a pane the gamepad can drive. The dock keeps its autohide
 * mode, so leaving it re-collapses the rail instead of stealing layout space.
 */
function onDockRevealPane(paneId: PaneId): void {
  void activateDockPane(paneId, true);
}

function onDockAutohideClose(paneId: PaneId): void {
  dockWorkspace.unreveal(paneId);
  if (paneId === PANE_ARTIFACTS) artifactViewer.hidePanel();
}

// Collapsing a pinned dock is a mode change, not a close: the panes stay in the
// tree and the rail brings them back.
function onDockSetMode(paneId: PaneId, mode: DockMode): void {
  dockWorkspace.setMode(paneId, mode);
  if (mode !== 'pinned') dockWorkspace.unreveal(paneId);
}

function onDockResize(path: number[], sizes: number[]): void {
  dockWorkspace.resize(path, sizes);
  refitTerminalsSoon();
}

/**
 * Drag/keyboard layout moves. The model is the only authority, so a rejected
 * move simply leaves the layout untouched; the terminal host is adopted by the
 * new pane element rather than remounted, so PTY ownership never changes.
 */
function onDockMovePane(paneId: PaneId, target: DropTarget): void {
  try {
    dockWorkspace.move(paneId, target);
    refitTerminalsSoon();
  } catch {
    // An invalid drop leaves the previous layout in place.
  }
}

function onDockReorderTab(paneId: PaneId, index: number): void {
  try {
    dockWorkspace.reorder(paneId, index);
  } catch {
    // Reorder is clamped by the model; an unknown pane is simply ignored.
  }
}

function onDockPaneEdge(paneId: PaneId, side: DockSide): void {
  try {
    dockWorkspace.dockToEdge(paneId, side);
    refitTerminalsSoon();
  } catch {
    // Docking the last remaining pane to an edge is rejected by the model.
  }
}

// main-view-manager stays the view transition authority; the dock mirrors it.
// Reconciling here — rather than a second routing path — is what lets a normal
// openOverview()/openPlan() bring back a view pane the user closed to the View
// menu, instead of transitioning into a pane that is not in the tree.
watch(() => activeView.value, (view) => {
  const paneId = viewPaneByName[view];
  if (!dockWorkspace.isOpen(paneId)) {
    try {
      dockWorkspace.restore(paneId);
    } catch {
      // Only an already-docked pane can throw here; nothing left to reconcile.
      return;
    }
  }
  if (!dockWorkspace.isVisible(paneId)) dockWorkspace.activate(paneId);
  dockWorkspace.focusPane(paneId);
});

// Bringing the window forward while viewing the active session means the user has
// seen it — clear its flash. (The activeSessionId watcher handles session switches.)
const onWindowFocusClearFlash = (): void => {
  if (state.activeSessionId) flashAttention.clear(state.activeSessionId);
};

const {
  draftEditorVisible,
  draftEditorMode,
  draftEditorSessionId,
  draftEditorDraftId,
  draftEditorLabel,
  draftEditorText,
  draftEditorPlanId,
  draftEditorPlanStatus,
  draftEditorPlanStateInfo,
  draftEditorPlanType,
  draftEditorPlanAutoImplement,
  draftEditorPlanCompletionRecap,
  draftEditorPlanHumanId,
  draftEditorPlanCreatedAt,
  draftEditorPlanStateUpdatedAt,
  draftEditorPlanCallbacks,
  draftEditorCompletionNotes,
  draftEditorContextId,
  draftEditorContextType,
  draftEditorContextPermission,
  draftEditorContextCallbacks,
  draftEditorContextBoundPlans,
  draftEditorContextBoundSequences,
  draftEditorPendingContextUnbinds,
  draftEditorRef,
  openDraftEditor,
  openPlanEditor,
  openContextEditor,
  closeDraftEditor,
  saveContextEditor,
  onDraftSave,
  onDraftApply,
  onDraftDelete,
  onDraftClose,
  onPlanSave,
  onPlanApply,
  onPlanDone,
  onPlanDelete,
  onContextDelete,
  hasUnsavedChanges,
  handleButton: handleDraftEditorButton,
} = useDraftPlanContextEditor({
  saveContext: (id, updates, pendingUnbinds) => onPlanContextSave(id, updates, pendingUnbinds),
  refreshDraftSession: (sessionId) => chipBarStore.refresh(sessionId),
});
let unsubSnapOut: (() => void) | null = null;
let unsubSnapBack: (() => void) | null = null;
let unsubFocusSlot: (() => void) | null = null;
let unsubLlmNotify: (() => void) | null = null;
let unsubFlashAttention: (() => void) | null = null;
let unsubAppCloseRequest: (() => void) | null = null;

// Non-modal local state
const bindingEditorVisible = ref(false);
const bindingEditorButton = ref('');
const bindingEditorCliType = ref('');
const bindingEditorBinding = ref<any>(null);

// Settings panel state
const settingsPanelRef = ref<any>(null);
const {
  settingsTab,
  settingsTools,
  settingsProjects,
  settingsChipbarActions,
  settingsTelegramConfig,
  settingsTelegramBotRunning,
  settingsMcpConfig,
  settingsSkills,
  settingsSkillDraft,
  skillBodyCache,
  settingsBindings,
  settingsBindingSortField,
  settingsBindingSortDirection,
  settingsAddableButtons,
  settingsBindingCopySources,
  loadSettingsData,
  loadCurrentTabBindings,
  buildSettingsTabs,
  onToolAdd,
  onToolEdit,
  onToolClone,
  onToolDelete,
  onToolReorder,
  onChipbarActionAdd,
  onChipbarActionEdit,
  onChipbarActionDelete,
  onChipbarActionMove,
  onTelegramUpdateField,
  onTelegramStartBot,
  onTelegramStopBot,
  onMcpUpdate,
  onMcpGenerateToken,
  onMcpRunInShell,
  onSkillSelect,
  onSkillNew,
  onSkillSave,
  onSkillDelete,
  onSkillClone,
  onSkillClearReviews,
  onSkillResetUseCount,
  onSkillResetAllCounts,
  onSkillLoadBodies,
  onBindingAdd,
  onBindingDelete,
  onBindingCopyFrom,
  onBindingSortChange,
} = useSettingsController({
  refreshProjects,
  doSpawnShell,
  reloadSessions: () => { loadSessions(); },
  closeSettings: () => {
    settingsVisible.value = false;
    navStore.closeSettings();
  },
  openBindingEditor: (button, cliType, binding) => onEditBinding(button, cliType, binding),
});

const sidebarController = useSidebarController({
  activeView,
  navStore,
  refreshProjects,
  doSpawn,
  doCloseSession,
});
const {
  overviewCollapsedIds,
  overviewGroupLabel,
  schedulerPopupVisible,
  schedulerPopupTaskId,
  recreatePrefill,
  onSessionClick,
  onSessionRename,
  onSessionSnapOut,
  onSessionSnapBack,
  onSpawn,
  onDirPickerSelect,
  installDirPickerBridge,
} = sidebarController;

// Re-fit terminals after the panel opens/closes/resizes — the terminal column
// width changes, so xterm needs a fresh fit on the next frame.
function refitTerminalsSoon(): void {
  requestAnimationFrame(() => { getTerminalManager()?.fitActive(); });
}

// Keep artifacts bound to whichever session is active; the plan pane owns its
// own session binding because it can remain mounted alongside the terminal.
useArtifactSessionBinding(artifactViewer);
const { addToast } = useToast();
const planWorkspaceController = usePlanWorkspaceController();

// ============================================================================
// Computed props for components
// ============================================================================

const hasActiveSession = computed(() => !!state.activeSessionId);

// Runtime group name for the session the context menu targets (null when ungrouped).
const contextMenuGroupName = computed<string | null>(() => {
  const sessionId = contextMenu.sourceSessionId || state.activeSessionId;
  if (!sessionId) return null;
  return runtimeGroupActions.groupOfSession(sessionId)?.name ?? null;
});


const hasDrafts = computed(() => {
  if (!state.activeSessionId) return false;
  return (state.draftCounts.get(state.activeSessionId) ?? 0) > 0;
});

watch(() => activeView.value, (view) => {
  if (view === 'overview') {
    if (sessionsState.overviewIsGlobal) {
      overviewGroupLabel.value = 'All Sessions';
    } else if (sessionsState.overviewGroup) {
      // Runtime groups carry their own display name (their id is a UUID, not a
      // directory path), so prefer the group's own name when present.
      const grp = sessionsState.groups.find(g => g.dirPath === sessionsState.overviewGroup);
      overviewGroupLabel.value = grp?.kind === 'runtime'
        ? grp.displayName
        : resolveGroupDisplayName(sessionsState.overviewGroup, sessionsState.directories, settingsProjects.value);
    } else {
      overviewGroupLabel.value = 'Sessions';
    }
  }
});

watch(() => state.activeSessionId, (next, prev) => {
  if (!next) return;
  // Focusing a session clears any flash-attention pulse on it.
  flashAttention.clear(next);
  if (prev && prev !== next) {
    state.lastSelectedSessionId = prev;
  }
  state.recentSessionId = next;
});

const { handleButton, handleRelease, handleModalKeyboardBridge } = useInputRouter({
  settingsVisible,
  activeView,
  bindingEditorVisible,
  draftEditorVisible,
  draftEditorRef,
  settingsPanelRef,
  settingsTab,
  overviewCollapsedIds,
  buildSettingsTabs,
  navStore,
  focusedPaneId: dockWorkspace.focusedPaneId,
  getFocusedItemId: dockWorkspace.getFocusedItemId,
});

// Router registrations, released on unmount.
const keyHandlerCleanups: Array<() => void> = [];
let uninstallKeyRouter: (() => void) | null = null;

// Prompt-template apply flow (picker → editor → deliverPromptSequence).
const { openPromptPicker } = usePromptApplyFlow(() => state.activeSessionId);

/**
 * Workspace keys, owned by the router.
 *
 * Eligibility (modal open, editable field, which pane is focused or visible) is
 * resolved once per event by the router and handed to each handler, replacing
 * the per-listener DOM probes that used to guess it. Ctrl+Shift+A shows
 * Artifacts; it never toggles.
 */
const workspaceKeyHandlers = createWorkspaceKeyHandlers({
  activatePane: (paneId) => { void activateDockPane(paneId, paneId === PANE_ARTIFACTS); },
  cycleSession: (direction) => { cycleActiveSession(direction); },
  jumpToSession: (slot) => {
    for (const [sessionId, assignedSlot] of sessionsScreenStore.sessionShortcutMap) {
      if (assignedSlot === slot) { void navStore.navigateToSession(sessionId); return true; }
    }
    return false;
  },
  fireChipAction: (slot) => {
    const action = chipBarStore.actions[slotToIndex(slot)];
    if (!action) return false;
    void chipBarStore.triggerAction(action.sequence);
    return true;
  },
  spawnSession: () => {
    setPendingContextText(null);
    openQuickSpawn((cliType) => { void onSpawn(cliType); });
  },
  closeActiveSession: () => {
    if (state.activeSessionId) confirmCloseSessionById(state.activeSessionId);
  },
});

// Terminal-owned keys (Esc, Ctrl+V, Ctrl+G, key relay). Rename and
// notification-clear are passed straight in; they used to travel as window
// CustomEvents purely because the relay had no way to reach the shell.
useTerminalKeys({
  getActiveSessionId: () => getTerminalManager()?.getActiveSessionId() ?? null,
  getEscProtectionEnabled: async () => {
    try {
      return await configClient.configGetEscProtectionEnabled();
    } catch (error) {
      console.error('Failed to get ESC protection setting:', error);
      return true;
    }
  },
  renameSession: (sessionId) => { onSessionRename(sessionId); },
  clearNotifications: (sessionId) => { llmNotificationsStore.dismissSession(sessionId); },
});

// ⧉ pop-out: snap the active terminal into its own window. The artifact pane
// remains owned by the dock; SnapOutWindow renders only the terminal surface.
function onArtifactPopOut(): void {
  if (state.activeSessionId) void onSessionSnapOut(state.activeSessionId);
}

// Session-card 📄 badge: an additional entry point that SHOWS (never toggles)
// the artifact panel for that session — activate it, then reveal the panel.
function onShowArtifactsForSession(sessionId: string): void {
  void (async () => {
    await onSessionClick(sessionId);
    await activateDockPane(PANE_ARTIFACTS, true);
  })();
}

// Context menu
function onContextMenuAction(action: string): void {
  contextMenu.visible = false;
  switch (action) {
    case 'copy': {
      const text = contextMenu.selectedText;
      if (text) navigator.clipboard.writeText(text);
      break;
    }
    case 'paste':
      navigator.clipboard.readText().then(text => {
        if (text && state.activeSessionId) {
          void deliverBulkText(state.activeSessionId, text);
        }
      });
      break;
    case 'editor':
      void showEditorPopup((text) => {
        if (state.activeSessionId) void deliverPromptSequence(state.activeSessionId, text);
      });
      break;
    case 'new-session':
      setPendingContextText(null);
      openQuickSpawn((cliType) => {
        onSpawn(cliType);
      });
      break;
    case 'new-session-with-selection': {
      const selText = contextMenu.selectedText;
      setPendingContextText(selText || null);
      openQuickSpawn((cliType) => {
        onSpawn(cliType);
      });
      break;
    }
    case 'prompts':
      void openPromptPicker();
      break;
    case 'drafts':
      if (state.activeSessionId) {
        void draftsClient.draftList(state.activeSessionId).then(drafts => {
          draftSubmenu.visible = true;
          draftSubmenu.items = [...(drafts ?? [])];
        });
      }
      break;
    case 'move-to-group': {
      const sessionId = contextMenu.sourceSessionId || state.activeSessionId;
      if (sessionId) {
        const current = runtimeGroupActions.groupOfSession(sessionId);
        openRuntimeGroupMoveSubmenu(
          sessionId,
          current?.id ?? null,
          runtimeGroups.groups.value.map(g => ({ id: g.id, name: g.name })),
        );
      }
      break;
    }
    case 'remove-from-group': {
      const sessionId = contextMenu.sourceSessionId || state.activeSessionId;
      if (sessionId) void runtimeGroupActions.removeFromGroup(sessionId);
      break;
    }
    case 'snap-out':
      if (state.activeSessionId) void onSessionSnapOut(state.activeSessionId);
      break;
    case 'snap-back':
      if (state.activeSessionId) void onSessionSnapBack(state.activeSessionId);
      break;
    case 'cancel':
      break;
  }
}

// Settings
function onOpenLogsFolder(): void {
  void systemClient.systemOpenLogsFolder();
}

function onOpenHelp(): void {
  void systemClient.systemOpenHelp();
}

function onOpenSettings(): void {
  settingsVisible.value = true;
  navStore.openSettings();
  settingsTab.value = state.settingsTab || 'tools';
  void loadSettingsData();
}

watch(settingsTab, () => {
  state.settingsTab = settingsTab.value;
  void loadCurrentTabBindings();
});

watch(() => toolEditor.visible, (visible) => {
  if (!visible && settingsVisible.value) {
    void loadSettingsData();
  }
});

function onCloseSettings(): void {
  settingsVisible.value = false;
  navStore.closeSettings();
}

// ── Scheduled Tasks Tab Handlers ─────────────────────────────────────────────

async function onScheduledTaskCreated(task: ScheduledTask): Promise<void> {
  console.log('[App] Scheduled task created:', task.title);
  recreatePrefill.value = null;
}

async function onScheduledTaskUpdated(task: ScheduledTask): Promise<void> {
  console.log('[App] Scheduled task updated:', task.title);
}

// Clear any recreate prefill once the scheduler popup is dismissed so a later
// plain "New Schedule" never reopens with stale snapshot data.
watch(schedulerPopupVisible, (visible) => {
  if (!visible) recreatePrefill.value = null;
});

async function onScheduledTaskCancelled(taskId: string): Promise<void> {
  console.log('[App] Scheduled task cancelled:', taskId);
}

// Draft submenu actions
function onDraftNewDraft(): void {
  draftSubmenu.visible = false;
  if (!state.activeSessionId) return;
  openDraftEditor(state.activeSessionId);
}

async function onDraftSubmenuApply(draft: { id: string; text: string }): Promise<void> {
  draftSubmenu.visible = false;
  if (state.activeSessionId && draft.text) {
    void deliverPromptSequence(state.activeSessionId, draft.text);
  }
  await draftsClient.draftDelete(draft.id);
}

function onDraftSubmenuEdit(draft: { id: string; label: string; text: string }): void {
  draftSubmenu.visible = false;
  if (!state.activeSessionId) return;
  openDraftEditor(state.activeSessionId, draft);
}

async function onDraftSubmenuDelete(draft: { id: string }): Promise<void> {
  draftSubmenu.visible = false;
  await draftsClient.draftDelete(draft.id);
}

// Binding editor handlers
function onEditBinding(button: string, cliType: string, binding: any = { action: 'keyboard', sequence: '' }): void {
  bindingEditorButton.value = button;
  bindingEditorCliType.value = cliType;
  bindingEditorBinding.value = { ...binding };
  bindingEditorVisible.value = true;
}

// Bridge function for legacy binding editor
function openLegacyBindingEditor(button: string, cliType: string, binding: any): void {
  onEditBinding(button, cliType, binding);
}

// Make this function available globally for legacy code
window.openLegacyBindingEditor = openLegacyBindingEditor;

// Binding editor save
async function onBindingEditorSave(binding: any): Promise<void> {
  try {
    const result = await configClient.configSetBinding(
      bindingEditorButton.value,
      bindingEditorCliType.value,
      binding
    );
    if (result.success) {
      // Refresh bindings cache to reflect the changes
      await initConfigCache();
      // Refresh the settings display to show updated bindings
      void loadCurrentTabBindings();
    }
    bindingEditorVisible.value = false;
  } catch (error) {
    console.error('Failed to save binding:', error);
    // Keep modal open if save fails
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

// Runtime group sidebar actions (split button, headers, drop targets).
function onNewGroup(): void {
  runtimeGroupActions.promptCreate();
}
function onNewGroupWithSession(sessionId: string): void {
  runtimeGroupActions.promptCreate(sessionId);
}
function onGroupRename(groupId: string): void {
  const group = runtimeGroups.groups.value.find(g => g.id === groupId);
  if (group) runtimeGroupActions.promptRename(group);
}
function onGroupClose(groupId: string): void {
  const group = runtimeGroups.groups.value.find(g => g.id === groupId);
  if (group) {
    runtimeGroupActions.requestClose(group);
    return;
  }
  // Directory group — closing it closes every session in that folder, so it
  // asks first. Runtime groups get their own 3-way dialog above.
  const dirGroup = sessionsState.groups.find(g => g.dirPath === groupId);
  if (dirGroup && dirGroup.sessions.length > 0) {
    const sessionIds = dirGroup.sessions.map(session => session.id);
    showFolderCloseConfirm(dirGroup.displayName || dirGroup.dirPath, sessionIds.length, () => {
      for (const sessionId of sessionIds) {
        void doCloseSession(sessionId);
      }
    });
  }
}
function onGroupAddSession(groupId: string, sessionId: string): void {
  void runtimeGroupActions.moveToGroup(groupId, sessionId);
}
function onGroupRemoveSession(sessionId: string): void {
  void runtimeGroupActions.removeFromGroup(sessionId);
}

// The one seam panes read from. Everything here is shell-owned per-instance
// state; panes take domain state from the existing singletons themselves.
provideHelmPaneContext({
  terminalContainerRef,
  sidebar: sidebarController,
  planWorkspace: planWorkspaceController,
  groups: {
    newGroup: onNewGroup,
    newGroupWithSession: onNewGroupWithSession,
    rename: onGroupRename,
    close: onGroupClose,
    addSession: onGroupAddSession,
    removeSession: onGroupRemoveSession,
  },
  showArtifactsForSession: onShowArtifactsForSession,
  popOutArtifacts: onArtifactPopOut,
});

// Rebuild the session list whenever runtime groups change (create/rename/close,
// membership moves). buildSessionGroups reads the live groups ref, so a rebuild
// re-partitions sessions between runtime and directory groups.
watch(runtimeGroups.groups, () => { refreshSessions(); }, { deep: true });

onMounted(async () => {
  const dockLoad = await dockWorkspace.loadPersisted();
  if (dockLoad.source === 'persisted') syncViewFromDockLayout();
  else fallbackToOpenView();

  recycleBin.ensureSubscribed();
  runtimeGroups.ensureSubscribed();
  artifactViewer.ensureSubscribed();
  // Subscribe app-wide, NOT from the Peers tab: an inbound pairing request must
  // raise its dialog even when Settings has never been opened this session.
  peers.ensureSubscribed();
  void artifactViewer.setActiveSession(state.activeSessionId ?? null);

  // One listener for the whole window. Workspace keys and the modal bridge
  // register as handlers; the router resolves context and decides precedence.
  for (const handler of workspaceKeyHandlers) {
    keyHandlerCleanups.push(registerKeyHandler(handler));
  }
  keyHandlerCleanups.push(registerKeyHandler({
    id: 'modal-stack-bridge',
    scope: 'modal',
    handle: (ctx) => handleModalKeyboardBridge(ctx.event),
  }));

  // Arrow/Enter/Delete/F5 are the keyboard spelling of gamepad buttons, so they
  // go through the same pane dispatch. The terminal is excluded explicitly
  // rather than by registration order: its own Escape handler owns that key.
  keyHandlerCleanups.push(registerKeyHandler({
    id: 'pane-navigation',
    scope: 'pane',
    // `ctx.scope === 'terminal'` means the keystroke landed inside xterm, which
    // owns arrows itself (TUI navigation) regardless of which pane is focused.
    claims: (ctx) => !ctx.isFocused(PANE_TERMINAL) && ctx.scope !== 'terminal',
    handle: (ctx) => {
      if (ctx.event.ctrlKey || ctx.event.altKey || ctx.event.metaKey) return false;
      const button = NAVIGATION_KEY_BUTTONS[ctx.key];
      if (!button) return false;
      handleButton(button);
      return true;
    },
  }));
  uninstallKeyRouter = installDockKeyRouter({
    getActiveSessionId: () => state.activeSessionId ?? null,
    getFocusedPane: () => dockWorkspace.focusedPaneId.value,
    isPaneVisible: (pane) => dockWorkspace.isVisible(pane),
    isPanelOpen: () => settingsVisible.value || draftEditorVisible.value || bindingEditorVisible.value,
  });

  if (!terminalContainerRef.value) {
    await appClient.appStartupReady();
    return;
  }

  try {
    await bootstrap({
      terminalContainer: terminalContainerRef.value,
      handleButton,
      handleRelease,
      onTerminalSwitch(sessionId) {
        void navStore.reconcileTerminalSwitch(sessionId ?? null);
        if (sessionId) activeView.value = 'terminal';
      },
      onTerminalEmpty() {
        void navStore.reconcileTerminalSwitch(null);
        chipBarStore.clear();
      },
      onTerminalTitleChange(sessionId, title) {
        const s = state.sessions.find(s => s.id === sessionId);
        if (s) s.title = title;
      },
    });

    installDirPickerBridge();

    // Snap-out / snap-back IPC listeners
    unsubSnapOut = eventsClient.onSnapOut
      ? eventsClient.onSnapOut((sessionId: string) => {
          state.snappedOutSessions.add(sessionId);
          const tm = getTerminalManager();
          if (tm) tm.detachTerminal(sessionId, true);
        })
      : null;
    unsubSnapBack = eventsClient.onSnapBack
      ? eventsClient.onSnapBack((sessionId: string) => {
          void restoreSnappedBackSession(sessionId);
        })
      : null;

    // A popout pressed Ctrl+<n>: the main window owns slot→session ordering, so
    // it resolves the slot and raises the owning window. Snapped-out sessions
    // are excluded from the shortcut map, so every resolved session is local
    // and we switch the main window to its terminal.
    unsubFocusSlot = eventsClient.onFocusSlot
      ? eventsClient.onFocusSlot((slot: number) => {
          const sessionId = resolveFocusSlot(slot, sessionsScreenStore.sessionShortcutMap);
          if (!sessionId) return;
          void navStore.navigateToSession(sessionId);
          void sessionsClient.sessionFocusWindow(sessionId);
        })
      : null;

    // LLM notification IPC listener
    unsubLlmNotify = eventsClient.onLlmNotify
      ? eventsClient.onLlmNotify(({ sessionId, title, content }) => {
          llmNotificationsStore.add({ sessionId, title, content });
        })
      : null;

    // Flash-attention IPC listener — skip only when the user is already looking at
    // the target (it is active AND the window has focus); a backgrounded active
    // session still flashes so the attention grab is not silently dropped.
    unsubFlashAttention = eventsClient.onFlashAttention
      ? eventsClient.onFlashAttention(({ sessionId, accentColor, textColor }) => {
          if (sessionId === state.activeSessionId && document.hasFocus()) return;
          flashAttention.start({ sessionId, accentColor, textColor });
        })
      : null;
    window.addEventListener('focus', onWindowFocusClearFlash);

    unsubAppCloseRequest = eventsClient.onAppCloseRequest
      ? eventsClient.onAppCloseRequest(() => {
          showAppCloseConfirm(
            () => { void appClient.appConfirmClose(true); },
            () => { void appClient.appConfirmClose(false); },
          );
        })
      : null;

    onViewChange((view: ViewName) => {
      activeView.value = view;
    });

    // Wire draft/plan editor callbacks
    setDraftEditorCompatibilityOpener(openDraftEditor);
    setPlanEditorCompatibilityOpener(openPlanEditor);
    setDraftEditorCompatibilityCloser(closeDraftEditor);
    setDraftEditorCompatibilityVisibilityChecker(() => draftEditorVisible.value);
    setDraftEditorCompatibilityButtonHandler(handleDraftEditorButton);
    setPlanCompatibilityChangesChecker(hasUnsavedChanges);

    setChipBarPlanEditorOpener(openPlanEditor);

    setPlanScreenPlanEditorOpener(openPlanEditor);
    setPlanScreenContextEditorOpener(openContextEditor);
    setPlanScreenDraftEditorCloser(closeDraftEditor);
    setPlanScreenDraftEditorVisibilityChecker(() => draftEditorVisible.value);
    setPlanScreenPlanChangesChecker(hasUnsavedChanges);

    await chipBarStore.refresh(state.activeSessionId ?? null);
  } catch (error) {
    console.error('[App] Startup failed:', error);
  } finally {
    try {
      await appClient.appStartupReady();
    } catch (error) {
      console.error('[App] Failed to notify main process that startup completed:', error);
    }
  }
});

onUnmounted(() => {
  for (const cleanup of keyHandlerCleanups.splice(0)) cleanup();
  uninstallKeyRouter?.();
  uninstallKeyRouter = null;
  unsubSnapOut?.();
  unsubSnapOut = null;
  unsubSnapBack?.();
  unsubSnapBack = null;
  unsubFocusSlot?.();
  unsubFocusSlot = null;
  unsubLlmNotify?.();
  unsubLlmNotify = null;
  unsubFlashAttention?.();
  unsubFlashAttention = null;
  window.removeEventListener('focus', onWindowFocusClearFlash);
  flashAttention.clearAll();
  unsubAppCloseRequest?.();
  unsubAppCloseRequest = null;
  teardown();
});
</script>

<template>
  <div class="helm-app-shell">
    <header class="app-header">
      <span class="sidebar-logo">
        <img src="./assets/helm-paper-boat.svg" alt="Helm logo" width="28" height="28">
      </span>
      <span class="sidebar-brand">
        <span class="sidebar-title">Helm</span>
        <span class="sidebar-tagline">steer your fleet of agents</span>
      </span>
      <div class="sidebar-actions">
        <DockViewMenu
          :open="dockViewMenuOpen"
          :items="dockViewItems"
          @open="dockViewMenuOpen = true"
          @close="dockViewMenuOpen = false"
          @toggle="onDockViewToggle"
          @reset="onDockLayoutReset"
        />
        <button class="sidebar-btn" title="User Guide" @click="onOpenHelp">ℹ️</button>
        <button class="sidebar-btn" title="Open Logs Folder" @click="onOpenLogsFolder">🐛</button>
        <button class="sidebar-btn" title="Settings" @click="onOpenSettings">⚙</button>
      </div>
    </header>
    <StatusStrip
      :gamepad-count="state.gamepadCount"
      :total-sessions="state.sessions.length"
      :active-sessions="state.sessions.filter(s => (state.sessionActivityLevels.get(s.id) ?? 'idle') === 'active').length"
    />
    <div class="app-workspace">
      <div class="app-main-area">
        <DraftEditor
          v-if="draftEditorVisible"
          ref="draftEditorRef"
          :visible="draftEditorVisible"
          :mode="draftEditorMode"
          :session-id="draftEditorSessionId"
          :draft-id="draftEditorDraftId"
          :initial-label="draftEditorLabel"
          :initial-text="draftEditorText"
          :plan-id="draftEditorPlanId"
          :plan-status="draftEditorPlanStatus"
          :plan-state-info="draftEditorPlanStateInfo"
          :plan-type="draftEditorPlanType"
          :plan-auto-implement="draftEditorPlanAutoImplement"
          :plan-completion-recap="draftEditorPlanCompletionRecap"
          :plan-human-id="draftEditorPlanHumanId"
          :plan-created-at="draftEditorPlanCreatedAt"
          :plan-state-updated-at="draftEditorPlanStateUpdatedAt"
          :plan-callbacks="draftEditorPlanCallbacks"
          :completion-notes="draftEditorCompletionNotes"
          :context-id="draftEditorContextId"
          :context-type="draftEditorContextType"
          :context-permission="draftEditorContextPermission"
          :context-callbacks="draftEditorContextCallbacks"
          :context-bound-plans="draftEditorContextBoundPlans"
          :context-bound-sequences="draftEditorContextBoundSequences"
          :context-pending-unbind-count="draftEditorPendingContextUnbinds.length"
          @save="onDraftSave"
          @apply="onDraftApply"
          @delete="onDraftDelete"
          @close="onDraftClose"
          @plan-save="onPlanSave"
          @plan-apply="onPlanApply"
          @plan-done="onPlanDone"
          @plan-delete="onPlanDelete"
          @context-save="(u) => draftEditorContextId && saveContextEditor(draftEditorContextId, u)"
          @context-delete="onContextDelete"
        />
        <DockWorkspace
          :layout="dockWorkspace.layout.value"
          :focused-pane-id="dockWorkspace.focusedPaneId.value"
          :revealed-pane-ids="dockWorkspace.revealedPanes.value"
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

      <div v-if="settingsVisible" class="settings-workspace-overlay">
        <SettingsPanel
          ref="settingsPanelRef"
          :visible="settingsVisible"
          :tabs="buildSettingsTabs()"
          :active-tab="settingsTab"
          @update:active-tab="settingsTab = $event"
          @close="onCloseSettings"
        >
          <template #default="{ activeTab }">
            <ToolsTab
              v-if="activeTab === 'tools'"
              :tools="settingsTools"
              @add="onToolAdd"
              @edit="onToolEdit"
              @clone="onToolClone"
              @delete="onToolDelete"
              @move="onToolReorder"
            />
            <ProjectsTab
              v-else-if="activeTab === 'projects'"
              @changed="refreshSessions"
            />
            <ChipbarActionsTab
              v-else-if="activeTab === 'chipbar-actions'"
              :actions="settingsChipbarActions"
              @add="onChipbarActionAdd"
              @edit="onChipbarActionEdit"
              @delete="onChipbarActionDelete"
              @move="onChipbarActionMove"
            />
            <TelegramTab
              v-else-if="activeTab === 'telegram'"
              :config="settingsTelegramConfig"
              :bot-running="settingsTelegramBotRunning"
              @update-field="onTelegramUpdateField"
              @start-bot="onTelegramStartBot"
              @stop-bot="onTelegramStopBot"
            />
            <McpTab
              v-else-if="activeTab === 'mcp'"
              :config="settingsMcpConfig"
              @update="onMcpUpdate"
              @generate-token="onMcpGenerateToken"
              @run-in-shell="onMcpRunInShell"
            />
            <SkillsTab
              v-else-if="activeTab === 'skills'"
              :skills="settingsSkills"
              :draft="settingsSkillDraft"
              :projects="settingsProjects"
              :body-cache="skillBodyCache"
              @select="onSkillSelect"
              @new="onSkillNew"
              @save="onSkillSave"
              @delete="onSkillDelete"
              @clone="onSkillClone"
              @clear-reviews="onSkillClearReviews"
              @reset-use-count="onSkillResetUseCount"
              @reset-all-counts="onSkillResetAllCounts"
              @load-bodies="onSkillLoadBodies"
            />
            <PeersTab
              v-else-if="activeTab === 'peers'"
            />
            <MobileTab
              v-else-if="activeTab === 'mobile'"
            />
            <BindingsTab
              v-else
              :bindings="settingsBindings"
              :cli-type="activeTab"
              :cli-label="getCliDisplayName(activeTab)"
              :addable-buttons="settingsAddableButtons"
              :copy-source-options="settingsBindingCopySources"
              :sort-field="settingsBindingSortField"
              :sort-direction="settingsBindingSortDirection"
              @add-binding="onBindingAdd"
              @edit-binding="onEditBinding($event, activeTab)"
              @delete-binding="onBindingDelete"
              @copy-from="onBindingCopyFrom"
              @sort-change="onBindingSortChange"
            />
          </template>
          </SettingsPanel>
        </div>

      </div>

    <RecycleBinModal v-model:visible="recycleBin.modalVisible.value" />
    <PeerPairingDialog />
    <MobilePairingDialog />
    <PendingHandoverModal
      :session-id="state.activeSessionId"
      :terminal-focused="dockWorkspace.focusedPaneId.value === PANE_TERMINAL"
    />

    <AppModalHost
      :cli-types="state.cliTypes"
      :has-active-session="hasActiveSession"
      :has-sequences="false"
      :has-drafts="hasDrafts"
      :is-active-session-snapped-out="state.activeSessionId ? state.snappedOutSessions.has(state.activeSessionId) : false"
      :context-menu-group-name="contextMenuGroupName"
      v-model:binding-editor-visible="bindingEditorVisible"
      :binding-editor-button="bindingEditorButton"
      :binding-editor-cli-type="bindingEditorCliType"
      :binding-editor-binding="bindingEditorBinding"
      v-model:scheduler-popup-visible="schedulerPopupVisible"
      :scheduler-popup-task-id="schedulerPopupTaskId"
      :scheduler-popup-prefill="recreatePrefill"
      @close-session="(sessionId) => void doCloseSession(sessionId)"
      @context-menu-action="onContextMenuAction"
      @draft-new-draft="onDraftNewDraft"
      @draft-apply="onDraftSubmenuApply"
      @draft-edit="onDraftSubmenuEdit"
      @draft-delete="onDraftSubmenuDelete"
      @dir-select="onDirPickerSelect"
      @binding-save="onBindingEditorSave"
      @task-created="onScheduledTaskCreated"
      @task-updated="onScheduledTaskUpdated"
      @task-cancelled="onScheduledTaskCancelled"
    />
  </div>
</template>
