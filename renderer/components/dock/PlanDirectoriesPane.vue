<script setup lang="ts">
/**
 * PlanDirectoriesPane — the `plan-projects` tool window.
 *
 * Directory navigation only: picking a directory activates the PlanScreen view
 * for it (via the sidebar controller's onShowPlans), it never renders a canvas
 * of its own.
 *
 * Content only — the dock tab titles it and the rail collapses it.
 */
import { computed } from 'vue';
import PlansGrid from '../sidebar/PlansGrid.vue';
import { sessionsState } from '../../screens/sessions-state.js';
import { useAppStore } from '../../stores/app.js';
import { buildPlannerDirectories, buildPlannerDirectorySource } from '../../screens/planner-directories.js';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';
import { useNavigationStore } from '../../stores/navigation.js';

const sidebar = useHelmMainPaneContext().sidebar;
const appStore = useAppStore();
// Not sidebar.onShowPlans: that always opens the ACTIVE session's directory.
const navStore = useNavigationStore();
const state = appStore.state;

// The operator's own project holds its tasks; found through the running
// operator rather than by project name, which the user may rename.
const operatorDir = computed(() => state.sessions.find((session) => session.role === 'operator')?.workingDir);

const directories = computed(() => {
  const plannerDirectories = buildPlannerDirectories(
    buildPlannerDirectorySource(sessionsState.directories, state.projects ?? []),
  );
  return plannerDirectories.map((directory) => ({
    name: directory.name,
    path: directory.path,
    startableCount: state.planDirStartableCounts.get(directory.path) ?? 0,
    codingCount: state.planDirCodingCounts.get(directory.path) ?? 0,
    blockedCount: state.planDirBlockedCounts.get(directory.path) ?? 0,
    reviewCount: state.planDirReviewCounts.get(directory.path) ?? 0,
    planningCount: state.planDirPlanningCounts.get(directory.path) ?? 0,
  }));
});
</script>

<template>
  <div class="dock-pane-body">
    <button
      v-if="operatorDir"
      class="spawn-btn plans-tasks-btn focusable"
      title="The operator's in-flight tasks"
      @click="navStore.openPlan(operatorDir)"
    >
      <span class="spawn-icon">🧭</span>
      <span class="spawn-label">Operator tasks</span>
    </button>
    <PlansGrid
      :directories="directories"
      :focus-index="sessionsState.plansFocusIndex"
      :is-active="sessionsState.activeFocus === 'plans'"
      @show-plans="sidebar.onShowPlans"
    />
  </div>
</template>

<style scoped>
.plans-tasks-btn {
  width: 100%;
  margin-bottom: 8px;
}
</style>
