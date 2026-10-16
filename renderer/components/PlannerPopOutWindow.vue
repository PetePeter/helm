<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import PlanScreen from './panels/PlanScreen.vue';
import ItemEditor from './panels/ItemEditor.vue';
import { useItemEditor } from '../composables/useItemEditor.js';
import { eventsClient, sessionsClient } from '../ipc/clients.js';
import {
  showPlanScreen,
  hidePlanScreen,
  refreshCanvasIfVisible,
  planScreenState,
  planSessionNames,
  watchTaskTimers,
  openPlanRef,
  onPlanAddDependency,
  onPlanAddContext,
  onPlanAddNode,
  onPlanAssignSequence,
  onPlanCleanup,
  onPlanContextBind,
  onPlanContextBindTarget,
  onPlanContextClick,
  onPlanContextDelete,
  onPlanContextMove,
  onPlanContextSave,
  onPlanContextSelectPlan,
  onPlanContextUnbind,
  onPlanCreateSequence,
  onPlanDeleteSequence,
  onPlanDeleteSequenceWithPlans,
  onPlanExportDirectory,
  onPlanOpenExternal,
  onPlanNodeApply,
  onPlanNodeClick,
  onPlanNodeComplete,
  onPlanNodeDelete,
  onPlanNodeEdit,
  onPlanRemoveDependency,
  onPlanUpdateSequence,
  toggleAutoFilter,
  toggleHasAttachmentFilter,
  toggleRelatedFocus,
  toggleStatusFilter,
  toggleTypeFilter,
  resetFilters,
  setPlanEditorOpener,
  setItemEditorCloser,
  setItemEditorVisibilityChecker,
  setPlanChangesChecker,
  setPlanScreenContextEditorOpener,
  onPlanContextEdit,
} from '../plans/plan-screen.js';
import { useAppStore } from '../stores/app.js';
import { loadStoredSessions } from '../session-store.js';

const props = defineProps<{ dirPath: string }>();
const appStore = useAppStore();

const {
  itemEditorVisible,
  itemEditorMode,
  itemEditorSessionId,
  itemEditorLabel,
  itemEditorText,
  itemEditorPlanId,
  itemEditorPlanStatus,
  itemEditorPlanStateInfo,
  itemEditorPlanType,
  itemEditorPlanAutoImplement,
  itemEditorPlanCompletionRecap,
  itemEditorPlanHumanId,
  itemEditorPlanCreatedAt,
  itemEditorPlanStateUpdatedAt,
  itemEditorPlanCallbacks,
  itemEditorCompletionNotes,
  itemEditorContextId,
  itemEditorContextType,
  itemEditorContextPermission,
  itemEditorContextCallbacks,
  itemEditorContextBoundPlans,
  itemEditorContextBoundSequences,
  itemEditorPendingContextUnbinds,
  itemEditorRef,
  openPlanEditor,
  openContextEditor,
  closeItemEditor,
  saveContextEditor,
  onPlanSave,
  onPlanApply,
  onPlanDone,
  onPlanDelete,
  onContextDelete,
  hasUnsavedChanges,
} = useItemEditor({
  saveContext: (id, updates, pendingUnbinds) => onPlanContextSave(id, updates, pendingUnbinds),
});

let offPlanChanged: (() => void) | null = null;
let offSessionUpdated: (() => void) | null = null;
let offSessionSpawned: (() => void) | null = null;

async function loadSessions(): Promise<void> {
  appStore.setSessions(await loadStoredSessions());
  appStore.setActiveSessionId((await sessionsClient.sessionGetActive())?.id ?? null);
}

async function closeWindow(): Promise<void> {
  hidePlanScreen();
  window.close();
}

onMounted(async () => {
  document.title = `${props.dirPath} - Plans`;
  setPlanEditorOpener(openPlanEditor);
  setPlanScreenContextEditorOpener(openContextEditor);
  setItemEditorCloser(closeItemEditor);
  setItemEditorVisibilityChecker(() => itemEditorVisible.value);
  setPlanChangesChecker(hasUnsavedChanges);

  await loadSessions();
  await showPlanScreen(props.dirPath);

  offPlanChanged = eventsClient.onPlanChanged((dirPath: string) => {
    if (dirPath.toLowerCase() === planScreenState.currentDir.toLowerCase()) {
      void refreshCanvasIfVisible();
    }
  });
  offSessionUpdated = eventsClient.onSessionUpdated?.(() => {
    void loadSessions();
  }) ?? null;
  offSessionSpawned = eventsClient.onSessionSpawned?.(() => {
    void loadSessions();
  }) ?? null;
  window.addEventListener('focus', loadSessions);
});

const stopTaskTimers = watchTaskTimers();
onUnmounted(() => {
  stopTaskTimers();
  offPlanChanged?.();
  offSessionUpdated?.();
  offSessionSpawned?.();
  window.removeEventListener('focus', loadSessions);
  closeItemEditor();
  hidePlanScreen();
});
</script>

<template>
  <div class="planner-popout-window">
    <ItemEditor
      v-if="itemEditorVisible"
      ref="itemEditorRef"
      :visible="itemEditorVisible"
      :mode="itemEditorMode"
      :session-id="itemEditorSessionId"
      :initial-label="itemEditorLabel"
      :initial-text="itemEditorText"
      :plan-id="itemEditorPlanId"
      :plan-status="itemEditorPlanStatus"
      :plan-state-info="itemEditorPlanStateInfo"
      :plan-type="itemEditorPlanType"
      :plan-auto-implement="itemEditorPlanAutoImplement"
      :plan-completion-recap="itemEditorPlanCompletionRecap"
      :plan-human-id="itemEditorPlanHumanId"
      :plan-created-at="itemEditorPlanCreatedAt"
      :plan-state-updated-at="itemEditorPlanStateUpdatedAt"
      :plan-callbacks="itemEditorPlanCallbacks"
      :completion-notes="itemEditorCompletionNotes"
      :context-id="itemEditorContextId"
      :context-type="itemEditorContextType"
      :context-permission="itemEditorContextPermission"
      :context-callbacks="itemEditorContextCallbacks"
      :context-bound-plans="itemEditorContextBoundPlans"
      :context-bound-sequences="itemEditorContextBoundSequences"
      :context-pending-unbind-count="itemEditorPendingContextUnbinds.length"
      @close="closeItemEditor"
      @plan-save="onPlanSave"
      @plan-apply="onPlanApply"
      @plan-done="onPlanDone"
      @plan-delete="onPlanDelete"
      @context-save="(u) => itemEditorContextId && saveContextEditor(itemEditorContextId, u)"
      @context-delete="onContextDelete"
    />
    <PlanScreen
      :visible="true"
      :dir-path="planScreenState.currentDir"
      :items="planScreenState.items"
      :deps="planScreenState.deps"
      :sequences="planScreenState.sequences"
      :contexts="planScreenState.contexts"
      :layout="planScreenState.layout"
      :selected-id="planScreenState.selectedId"
      :selected-context-id="planScreenState.selectedContextId"
      :selected-ids="planScreenState.selectedIds"
      :notice="planScreenState.notice"
      :related-focus-root-id="planScreenState.relatedFocusRootId"
      :related-focus-ids="planScreenState.relatedFocusIds"
      :related-transient-ids="planScreenState.relatedTransientIds"
      :filters="planScreenState.filters"
      :attachment-has-any="planScreenState.attachmentHasAny"
      :task-next-checks="planScreenState.taskNextChecks"
      :session-names="planSessionNames()"
      :can-open-session="false"
      @task-watch="openPlanRef"
      :can-pop-out="false"
      @close="closeWindow()"
      @add-node="onPlanAddNode()"
      @add-context="onPlanAddContext()"
      @export-dir="onPlanExportDirectory()"
      @open-plan-external="onPlanOpenExternal()"
      @cleanup="onPlanCleanup($event)"
      @create-sequence="onPlanCreateSequence"
      @assign-sequence="onPlanAssignSequence"
      @update-sequence="onPlanUpdateSequence"
      @delete-sequence="onPlanDeleteSequence"
      @delete-sequence-with-plans="onPlanDeleteSequenceWithPlans"
      @node-click="onPlanNodeClick"
      @context-click="onPlanContextClick"
      @context-move="onPlanContextMove"
      @context-bind="onPlanContextBind"
      @context-bind-target="onPlanContextBindTarget"
      @context-unbind="onPlanContextUnbind"
      @context-select-plan="onPlanContextSelectPlan"
      @context-edit="onPlanContextEdit"
      @context-delete="onPlanContextDelete"
      @edit-node="onPlanNodeEdit"
      @apply-node="onPlanNodeApply"
      @complete-node="onPlanNodeComplete"
      @delete-node="onPlanNodeDelete"
      @add-dep="onPlanAddDependency"
      @remove-dep="onPlanRemoveDependency"
      @toggle-related-focus="toggleRelatedFocus()"
      @toggle-type-filter="toggleTypeFilter"
      @toggle-status-filter="toggleStatusFilter"
      @toggle-has-attachment-filter="toggleHasAttachmentFilter"
      @toggle-auto-filter="toggleAutoFilter"
      @reset-filters="resetFilters()"
    />
  </div>
</template>

<style scoped>
.planner-popout-window {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
