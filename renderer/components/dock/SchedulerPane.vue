<script setup lang="ts">
/**
 * SchedulerPane — the `scheduler` tool window.
 *
 * Owns the scheduler list plus the run-history modal it raises. The task editor
 * popup stays in the app modal host: it is raised from several places, not just
 * this pane.
 *
 * The pane renders content only. Titling and collapse belong to the dock — the
 * tab names it and the rail collapses it — so there is no section header here.
 */
import DockPaneBody from './DockPaneBody.vue';
import SchedulerSection from '../sidebar/SchedulerSection.vue';
import ScheduledTaskHistoryModal from '../sidebar/ScheduledTaskHistoryModal.vue';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';

const sidebar = useHelmMainPaneContext().sidebar;
</script>

<template>
  <DockPaneBody>
    <SchedulerSection
      @open="sidebar.openSchedulerPopup"
      @delete="sidebar.deleteScheduledTask"
      @history="sidebar.openSchedulerHistory"
    />
    <ScheduledTaskHistoryModal
      v-model:visible="sidebar.historyModalVisible.value"
      @recreate="sidebar.recreateFromHistory"
    />
  </DockPaneBody>
</template>
