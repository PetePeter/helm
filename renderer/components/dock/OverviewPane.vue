<script setup lang="ts">
/**
 * The stable `overview` pane id is retained for persisted dock layouts, while
 * its content is now the people-only Team View. Terminal ownership remains in
 * TerminalPane; this pane only receives clipped text tails through its model.
 */
import TeamView from '../panels/TeamView.vue';
import { useAppStore } from '../../stores/app.js';
import { useTeamViewProjection } from '../../composables/useTeamViewProjection.js';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';

const pane = useHelmMainPaneContext();
const state = useAppStore().state;
const projection = useTeamViewProjection({ tailLineLimit: 4 });
</script>

<template>
  <TeamView
    :projection="projection"
    :active-session-id="state.activeSessionId"
    @toggle-department="pane.sidebar.onTeamViewToggleDepartment"
    @select="pane.sidebar.onOverviewSelect"
    @rename="pane.sidebar.onCommitRename"
    @toggle-lock="pane.sidebar.onToggleLock"
    @toggle-visibility="pane.sidebar.onToggleOverview"
    @request-close="pane.sidebar.onRequestClose"
    @show-artifacts="pane.showArtifactsForSession"
  />
</template>
