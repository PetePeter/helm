<script setup lang="ts">
/**
 * TerminalPane — the `terminal` view.
 *
 * Owns the xterm container element plus the chip bar that belongs to the
 * session at the prompt. TerminalManager mounts and switches xterm instances
 * inside the container imperatively. The element ref lives on the pane context
 * so the shell's bootstrap still receives a live node (children mount before
 * the parent's onMounted), and so the element can be adopted into a new
 * position without remounting xterm.
 *
 * The chips sit below the terminal and inside the pane: their visibility is
 * simply "this pane is rendered", which the dock already decides, rather than a
 * separate view flag.
 */
import { onBeforeUnmount } from 'vue';
import { useHelmPaneContext } from '../../dock-pane-context.js';
import TerminalChips from '../chips/TerminalChips.vue';
import MissionBar from './MissionBar.vue';
import { useAppStore } from '../../stores/app.js';

const pane = useHelmPaneContext();
/** The mission bar follows the session at the prompt, like the chips below. */
const appStore = useAppStore();

function setContainer(el: unknown): void {
  pane.terminalContainerRef.value = (el as HTMLElement | null) ?? null;
}

// The container is no longer this component's root element, and Vue's teardown
// order for nested element refs is not something the terminal host should
// depend on: release it explicitly so the manager never adopts a detached node.
onBeforeUnmount(() => { pane.terminalContainerRef.value = null; });
</script>

<template>
  <div class="terminal-view">
    <MissionBar
      v-if="appStore.activeSession"
      :session-id="appStore.activeSession.id"
      :mission="appStore.activeSession.mission"
      :height="appStore.activeSession.missionBarHeight"
    />
    <div class="terminal-container" id="terminalContainer" :ref="setContainer">
      <!-- xterm.js terminals rendered by TerminalManager -->
    </div>
    <TerminalChips />
  </div>
</template>
