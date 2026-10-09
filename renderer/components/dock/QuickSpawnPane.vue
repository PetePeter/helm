<script setup lang="ts">
/**
 * QuickSpawnPane — the `quick-spawn` tool window.
 *
 * Content only: the dock tab names the pane and the rail collapses it, so the
 * pane owns neither a header nor a collapse toggle. The keyboard hint lives on
 * the pane descriptor and surfaces as the tab's tooltip.
 */
import { computed, onBeforeUnmount, watch } from 'vue';
import SpawnGrid from '../sidebar/SpawnGrid.vue';
import QuickSpawnMachineTabs from '../common/QuickSpawnMachineTabs.vue';
import { sessionsState } from '../../screens/sessions-state.js';
import { useHelmMainPaneContext } from '../../dock-pane-context.js';
import { useQuickSpawnStore } from '../../stores/quick-spawn.js';
import { useSessionsScreenStore } from '../../stores/sessions-screen.js';

const sidebar = useHelmMainPaneContext().sidebar;
const quickSpawn = useQuickSpawnStore();
const sessionsScreen = useSessionsScreenStore();

const items = computed(() => quickSpawn.tools);

function onMachineTabsFocus(): void {
  quickSpawn.setMachineTabsFocused(true);
  sessionsScreen.setFocus('spawn');
}

function onMachineTabsBlur(): void {
  quickSpawn.setMachineTabsFocused(false);
}

watch(() => quickSpawn.hasRemoteTargets, hasTargets => {
  if (!hasTargets) onMachineTabsBlur();
});

onBeforeUnmount(onMachineTabsBlur);
</script>

<template>
  <div class="dock-pane-body">
    <QuickSpawnMachineTabs
      :machines="quickSpawn.machines"
      :active-machine-id="quickSpawn.machineId"
      :visible="quickSpawn.hasRemoteTargets"
      :loading="quickSpawn.loading"
      :error="quickSpawn.error"
      @select="quickSpawn.selectMachine"
      @tabs-focus="onMachineTabsFocus"
      @tabs-blur="onMachineTabsBlur"
    />
    <SpawnGrid
      v-if="!quickSpawn.loading && !quickSpawn.error"
      :items="items"
      :focus-index="sessionsState.spawnFocusIndex"
      :is-active="sessionsState.activeFocus === 'spawn'"
      @spawn="sidebar.onSpawn"
    />
  </div>
</template>
