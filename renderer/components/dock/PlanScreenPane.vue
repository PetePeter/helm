<script setup lang="ts">
/**
 * PlanScreenPane — the `plan-screen` view (planner canvas for one directory).
 *
 * Plan state and handlers are module singletons in `plans/plan-screen.js`; the
 * filter/pop-out actions come from the shell's plan workspace controller.
 * The pane owns the rendered-canvas lifecycle and keeps the shared canvas bound
 * to the selected session, so docked and pop-out rendering share one contract.
 */
import { onMounted, onUnmounted, watch } from 'vue';
import PlanScreen from '../panels/PlanScreen.vue';
import { useNavigationStore } from '../../stores/navigation.js';
import { useAppStore } from '../../stores/app.js';
import {
  onPlanAddContext,
  onPlanAddDependency,
  onPlanAddNode,
  onPlanAssignSequence,
  onPlanCleanup,
  onPlanContextBind,
  onPlanContextBindTarget,
  onPlanContextClick,
  onPlanContextDelete,
  onPlanContextEdit,
  onPlanContextMove,
  onPlanContextSelectPlan,
  onPlanContextUnbind,
  onPlanCreateSequence,
  onPlanDeleteSequence,
  onPlanDeleteSequenceWithPlans,
  onPlanExportDirectory,
  onPlanNodeApply,
  onPlanNodeClick,
  onPlanNodeComplete,
  onPlanNodeDelete,
  onPlanNodeEdit,
  onPlanOpenExternal,
  onPlanRemoveDependency,
  onPlanUpdateSequence,
  bindPlanScreenToDir,
  planScreenState,
  setPlanScreenPaneMounted,
} from '../../plans/plan-screen.js';
import { useHelmPaneContext } from '../../dock-pane-context.js';

const planWorkspace = useHelmPaneContext().planWorkspace;
const navStore = useNavigationStore();
const appStore = useAppStore();

onMounted(() => {
  setPlanScreenPaneMounted(true);
  void bindPlanScreenToDir(appStore.activeSessionDir);
});

// Watch the resolved directory, not the session id: on rehydrate the id is
// restored before the session list carries workingDir, so an id-only watcher
// would bind null and never fire again once the directory finally lands.
watch(() => appStore.activeSessionDir, () => {
  void bindPlanScreenToDir(appStore.activeSessionDir);
});

onUnmounted(() => { setPlanScreenPaneMounted(false); });
</script>

<template>
  <PlanScreen
    :visible="planScreenState.visible"
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
    @close="navStore.closePlan()"
    @pop-out="planWorkspace.onPlanPopOut()"
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
    @toggle-related-focus="planWorkspace.onToggleRelatedFocus"
    @toggle-type-filter="planWorkspace.onToggleTypeFilter"
    @toggle-status-filter="planWorkspace.onToggleStatusFilter"
    @reset-filters="planWorkspace.onResetFilters"
    @toggle-has-attachment-filter="planWorkspace.onToggleHasAttachmentFilter"
    @toggle-auto-filter="planWorkspace.onToggleAutoFilter"
  />
</template>
