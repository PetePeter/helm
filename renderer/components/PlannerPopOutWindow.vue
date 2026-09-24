<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import PlanScreen from './panels/PlanScreen.vue';
import DraftEditor from './panels/DraftEditor.vue';
import { useDraftPlanContextEditor } from '../composables/useDraftPlanContextEditor.js';
import { eventsClient, sessionsClient } from '../ipc/clients.js';
import {
  showPlanScreen,
  hidePlanScreen,
  refreshCanvasIfVisible,
  planScreenState,
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
  setDraftEditorCloser,
  setDraftEditorVisibilityChecker,
  setPlanChangesChecker,
  setPlanScreenContextEditorOpener,
  onPlanContextEdit,
} from '../plans/plan-screen.js';
import { useAppStore } from '../stores/app.js';
import { loadStoredSessions } from '../session-store.js';

const props = defineProps<{ dirPath: string }>();
const appStore = useAppStore();

const {
  draftEditorVisible,
  draftEditorMode,
  draftEditorSessionId,
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
  openPlanEditor,
  openContextEditor,
  closeDraftEditor,
  saveContextEditor,
  onPlanSave,
  onPlanApply,
  onPlanDone,
  onPlanDelete,
  onContextDelete,
  hasUnsavedChanges,
} = useDraftPlanContextEditor({
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
  setDraftEditorCloser(closeDraftEditor);
  setDraftEditorVisibilityChecker(() => draftEditorVisible.value);
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

onUnmounted(() => {
  offPlanChanged?.();
  offSessionUpdated?.();
  offSessionSpawned?.();
  window.removeEventListener('focus', loadSessions);
  closeDraftEditor();
  hidePlanScreen();
});
</script>

<template>
  <div class="planner-popout-window">
    <DraftEditor
      v-if="draftEditorVisible"
      ref="draftEditorRef"
      :visible="draftEditorVisible"
      :mode="draftEditorMode"
      :session-id="draftEditorSessionId"
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
      @close="closeDraftEditor"
      @plan-save="onPlanSave"
      @plan-apply="onPlanApply"
      @plan-done="onPlanDone"
      @plan-delete="onPlanDelete"
      @context-save="(u) => draftEditorContextId && saveContextEditor(draftEditorContextId, u)"
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
