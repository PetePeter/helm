import { ref, type Ref } from 'vue';
import { state } from '../state.js';
import { getActiveSessionDir } from '../stores/app.js';
import { sessionsState } from '../screens/sessions-state.js';
import { patternsClient, schedulerClient, sessionsClient } from '../ipc/clients.js';
import { setDirPickerBridge } from '../screens/sessions-spawn.js';
import { openDirPicker, dirPicker, closeConfirm, setCloseConfirmCallback } from '../stores/modal-bridge.js';
import { usePeers } from './usePeers.js';
import { useToast } from './useToast.js';
import { refreshSessions, getSortField, getSortDirection, setSortField, setSortDirection } from './useAppBootstrap.js';
import { startRename, commitRename, cancelRename } from '../sidebar/session-services.js';
import { setSessionState, toggleGroupCollapse } from '../screens/sessions.js';
import { isAnyBridgeModalVisible } from '../stores/modal-bridge.js';
import type { ScheduledTask, ScheduledTaskHistoryEntry } from '../../src/types/scheduled-task.js';
import type { SessionSortField, SortDirection } from '../sort-logic.js';
import type { ActivationResult } from '../stores/navigation.js';

interface NavigationController {
  closeOverview(): Promise<void> | void;
  navigateToSession(sessionId: string): Promise<ActivationResult | void> | ActivationResult | void;
  openPlan(dirPath: string): Promise<void> | void;
  openOverview(dirPath: string | null, sessionId?: string): Promise<void> | void;
}

export interface SidebarControllerDeps {
  activeView: Ref<'terminal' | 'overview' | 'plan'>;
  navStore: NavigationController;
  refreshProjects: () => Promise<void>;
  doSpawn: (cliType: string, dirPath?: string) => void | Promise<void>;
  doCloseSession: (sessionId: string) => void | Promise<void>;
}


export function useSidebarController(deps: SidebarControllerDeps) {
  const { listPeerDirs, spawnOnPeer, ensureSubscribed: ensurePeersSubscribed } = usePeers();
  const overviewCollapsedIds = ref<Set<string>>(new Set());
  const overviewGroupLabel = ref('');
  const schedulerPopupVisible = ref(false);
  const schedulerPopupTaskId = ref<string | null>(null);
  const historyModalVisible = ref(false);
  const recreatePrefill = ref<ScheduledTaskHistoryEntry | null>(null);

  function buildDirPickerItems(dirs: Array<{ name: string; path: string; projectId?: string; projectName?: string; isCanonical?: boolean }>) {
    return dirs;
  }

  async function onSessionClick(sessionId: string): Promise<void> {
    if (isAnyBridgeModalVisible()) return;
    if (deps.activeView.value === 'overview') {
      await deps.navStore.closeOverview();
    }
    await deps.navStore.navigateToSession(sessionId);
  }

  function onSessionRename(sessionId: string): void {
    startRename(sessionId);
  }

  async function onCommitRename(sessionId: string, newName: string): Promise<void> {
    await commitRename(sessionId, newName);
  }

  function onCancelRename(): void {
    cancelRename();
  }

  function onRequestClose(sessionId: string, displayName: string): void {
    closeConfirm.sessionId = sessionId;
    closeConfirm.sessionName = displayName;
    closeConfirm.draftCount = state.draftCounts.get(sessionId) ?? 0;
    closeConfirm.visible = true;
    setCloseConfirmCallback((targetSessionId: string) => {
      void deps.doCloseSession(targetSessionId);
    });
  }

  async function onSessionStateChange(sessionId: string, newState: string): Promise<void> {
    await setSessionState(sessionId, newState);
  }

  function onOverviewToggleCollapse(sessionId: string): void {
    if (overviewCollapsedIds.value.has(sessionId)) {
      overviewCollapsedIds.value.delete(sessionId);
    } else {
      overviewCollapsedIds.value.add(sessionId);
    }
  }

  function onGroupToggleCollapse(dirPath: string): void {
    void toggleGroupCollapse(dirPath);
  }

  function onShowPlans(_dirPath: string): void {
    const dirPath = getActiveSessionDir();
    if (dirPath) void deps.navStore.openPlan(dirPath);
  }

  function onShowOverview(dirPath: string): void {
    void deps.navStore.openOverview(dirPath, state.activeSessionId ?? undefined);
  }

  async function onCancelSchedule(sessionId: string): Promise<void> {
    try {
      await patternsClient.patternCancelSchedule(sessionId);
    } catch { /* ignore */ }
  }

  async function onSessionSnapOut(sessionId: string): Promise<void> {
    try {
      await sessionsClient.sessionSnapOut(sessionId);
    } catch (error) {
      console.error('Failed to snap out session:', error);
    }
  }

  async function onSessionSnapBack(sessionId: string): Promise<void> {
    try {
      await sessionsClient.sessionSnapBack(sessionId);
    } catch (error) {
      console.error('Failed to snap back session:', error);
    }
  }

  function openSchedulerPopup(taskId: string | null): void {
    schedulerPopupTaskId.value = taskId;
    schedulerPopupVisible.value = true;
  }

  function openSchedulerHistory(): void {
    historyModalVisible.value = true;
  }

  function recreateFromHistory(entry: ScheduledTaskHistoryEntry): void {
    recreatePrefill.value = entry;
    historyModalVisible.value = false;
    schedulerPopupTaskId.value = null;
    schedulerPopupVisible.value = true;
  }

  async function deleteScheduledTask(task: ScheduledTask): Promise<void> {
    const confirmed = window.confirm(`Delete scheduled task "${task.title}"?`);
    if (!confirmed) return;
    await schedulerClient.scheduledTaskDelete(task.id);
  }

  async function openSpawnPicker(
    cliType: string,
    dirs: Parameters<typeof buildDirPickerItems>[0],
    preselectedPath?: string,
    machineId = '',
  ): Promise<void> {
    if (!machineId) {
      openDirPicker(cliType, buildDirPickerItems(dirs), preselectedPath, '');
      return;
    }

    const requestId = openDirPicker(cliType, [], preselectedPath, machineId);
    dirPicker.loading = true;
    try {
      const peerDirs = await listPeerDirs(machineId);
      if (!dirPicker.visible || dirPicker.requestId !== requestId) return;
      dirPicker.items = buildDirPickerItems(peerDirs);
      if (peerDirs.length === 0) dirPicker.error = 'No directories on that machine.';
    } catch (error) {
      if (dirPicker.visible && dirPicker.requestId === requestId) {
        dirPicker.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (dirPicker.visible && dirPicker.requestId === requestId) dirPicker.loading = false;
    }
  }

  async function onSpawn(cliType: string, machineId = ''): Promise<void> {
    if (machineId) {
      await openSpawnPicker(cliType, [], undefined, machineId);
      return;
    }
    await deps.refreshProjects();
    const dirs = sessionsState.directories ?? [];
    if (dirs.length === 0) { await deps.doSpawn(cliType); return; }
    await openSpawnPicker(cliType, dirs);
  }

  /** The directory picker carries the machine selected before tool selection. */
  async function onDirPickerSelect(path: string, selectedCliType = dirPicker.cliType, machineId = ''): Promise<void> {
    if (!machineId) { await deps.doSpawn(selectedCliType, path); return; }

    let remoteSessionId: string;
    try {
      const result = await spawnOnPeer(machineId, selectedCliType, path);
      if (!result.ok || !result.sessionId) {
        throw new Error(result.error ?? 'The peer did not return a session id.');
      }
      remoteSessionId = result.sessionId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      useToast().addToast({
        message: `Remote spawn failed: ${reason}`,
        type: 'error',
        persistent: true,
        key: 'remote-spawn-error',
      });
      return;
    }

    await refreshSessions();
    await deps.navStore.navigateToSession(remoteSessionId);
  }

  function onSortChange(field: string, direction: 'asc' | 'desc'): void {
    setSortField(field as SessionSortField);
    setSortDirection(direction as SortDirection);
    void refreshSessions();
  }

  function installDirPickerBridge(): void {
    // Keep fleet status live for the shared machine tabs.
    ensurePeersSubscribed();
    setDirPickerBridge(openSpawnPicker);
  }

  return {
    overviewCollapsedIds,
    overviewGroupLabel,
    schedulerPopupVisible,
    schedulerPopupTaskId,
    historyModalVisible,
    recreatePrefill,
    getSortField,
    getSortDirection,
    buildDirPickerItems,
    onSessionClick,
    onSessionRename,
    onCommitRename,
    onCancelRename,
    onRequestClose,
    onSessionStateChange,
    onOverviewToggleCollapse,
    onGroupToggleCollapse,
    onShowPlans,
    onShowOverview,
    onCancelSchedule,
    onSessionSnapOut,
    onSessionSnapBack,
    openSchedulerPopup,
    openSchedulerHistory,
    recreateFromHistory,
    deleteScheduledTask,
    onSpawn,
    onDirPickerSelect,
    onSortChange,
    installDirPickerBridge,
  };
}
