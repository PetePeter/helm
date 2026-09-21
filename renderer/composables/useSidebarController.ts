import { ref, type Ref } from 'vue';
import { state } from '../state.js';
import { getActiveSessionDir } from '../stores/app.js';
import { sessionsState } from '../screens/sessions-state.js';
import { patternsClient, schedulerClient, sessionsClient } from '../ipc/clients.js';
import { setDirPickerBridge } from '../screens/sessions-spawn.js';
import { openDirPicker, dirPicker, closeConfirm, setCloseConfirmCallback } from '../stores/modal-bridge.js';
import { refreshSessions, getSortField, getSortDirection, setSortField, setSortDirection } from './useAppBootstrap.js';
import { startRename, commitRename, cancelRename } from '../sidebar/session-services.js';
import { toggleSessionOverviewVisibility, setSessionLocked, setSessionState, toggleGroupCollapse, toggleTeamViewDepartmentCollapse } from '../screens/sessions.js';
import { isAnyBridgeModalVisible } from '../stores/modal-bridge.js';
import type { ScheduledTask, ScheduledTaskHistoryEntry } from '../../src/types/scheduled-task.js';
import type { SessionSortField, SortDirection } from '../sort-logic.js';

interface NavigationController {
  closeOverview(): Promise<void> | void;
  navigateToSession(sessionId: string): Promise<void> | void;
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

  function onOverviewSelect(sessionId: string): void {
    void deps.navStore.navigateToSession(sessionId);
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

  function onTeamViewToggleDepartment(departmentId: string): void {
    void toggleTeamViewDepartmentCollapse(departmentId);
  }

  function onShowPlans(_dirPath: string): void {
    const dirPath = getActiveSessionDir();
    if (dirPath) void deps.navStore.openPlan(dirPath);
  }

  function onShowOverview(dirPath: string): void {
    void deps.navStore.openOverview(dirPath, state.activeSessionId ?? undefined);
  }

  function onToggleOverview(sessionId: string): void {
    void toggleSessionOverviewVisibility(sessionId);
  }

  function onToggleLock(sessionId: string, locked: boolean): void {
    void setSessionLocked(sessionId, locked);
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

  async function onSpawn(cliType: string): Promise<void> {
    await deps.refreshProjects();
    const dirs = sessionsState.directories;
    if (dirs && dirs.length > 0) {
      openDirPicker(cliType, buildDirPickerItems(dirs));
    } else {
      await deps.doSpawn(cliType);
    }
  }

  function onDirPickerSelect(path: string, selectedCliType = dirPicker.cliType): void {
    deps.doSpawn(selectedCliType, path);
  }

  function onSortChange(field: string, direction: 'asc' | 'desc'): void {
    setSortField(field as SessionSortField);
    setSortDirection(direction as SortDirection);
    void refreshSessions();
  }

  function installDirPickerBridge(): void {
    setDirPickerBridge((cliType, dirs, preselectedPath) => {
      openDirPicker(cliType, buildDirPickerItems(dirs), preselectedPath);
    });
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
    onOverviewSelect,
    onOverviewToggleCollapse,
    onGroupToggleCollapse,
    onTeamViewToggleDepartment,
    onShowPlans,
    onShowOverview,
    onToggleOverview,
    onToggleLock,
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
