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
 *
 * The Helm operator's pane shows its chat over the terminal by default
 * (OperatorChat); the xterm stays mounted underneath so flipping back to the
 * raw terminal never re-adopts the container. API-tool chats cover only the
 * terminal area, so their plan/shortcut chips stay docked below. The operator
 * carries no chip bar: quick actions don't apply to it.
 */
import { computed, onBeforeUnmount } from 'vue';
import { useHelmPaneContext } from '../../dock-pane-context.js';
import TerminalChips from '../chips/TerminalChips.vue';
import MissionBar from './MissionBar.vue';
import PromptCacheBanner from './PromptCacheBanner.vue';
import { setSessionFrozen } from '../../screens/sessions.js';

function thaw(sessionId: string): void {
  void setSessionFrozen(sessionId, false);
}
import { useAppStore } from '../../stores/app.js';
import OperatorChat from './OperatorChat.vue';
import { operatorView } from '../../composables/useOperatorChat.js';

const pane = useHelmPaneContext();
/** The mission bar follows the session at the prompt, like the chips below. */
const appStore = useAppStore();
const isOperator = computed(() => appStore.activeSession?.role === 'operator');
/** Chat-pane sessions: the operator and API tools render their journal as a chat thread. */
const isChatPane = computed(() => isOperator.value || appStore.activeSession?.apiTool === true);

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
    <PromptCacheBanner
      v-if="appStore.activeSession && !isOperator"
      :frozen="appStore.activeSession.frozen"
      :cli-type="appStore.activeSession.cliType"
      :last-prompt-at="appStore.activeSession.lastPromptAt"
    />
    <div v-if="appStore.activeSession?.frozen" class="terminal-view__frozen-bar">
      <span>Scroll and select text to read. Input and paste are disabled.</span>
      <button class="btn btn--sm btn--primary focusable" type="button" @click="thaw(appStore.activeSession.id)">Unfreeze</button>
    </div>
    <div class="terminal-view__stage">
      <div class="terminal-container" id="terminalContainer" :ref="setContainer">
        <!-- xterm.js terminals rendered by TerminalManager -->
      </div>
      <OperatorChat
        v-if="isChatPane && operatorView === 'chat' && appStore.activeSession"
        :key="appStore.activeSession.id"
        :session-id="appStore.activeSession.id"
        :title="isOperator ? 'Helm operator' : appStore.activeSession.name"
        :is-operator="isOperator"
      />
      <button
        v-else-if="isChatPane"
        class="btn btn--sm btn--secondary focusable terminal-view__chat-toggle"
        type="button"
        title="Back to the chat"
        @click="operatorView = 'chat'"
      >Chat</button>
    </div>
    <!-- Repeated under the terminal, where the eyes are while typing. -->
    <PromptCacheBanner
      v-if="appStore.activeSession && !isOperator && !appStore.activeSession.frozen"
      placement="bottom"
      :frozen="appStore.activeSession.frozen"
      :cli-type="appStore.activeSession.cliType"
      :last-prompt-at="appStore.activeSession.lastPromptAt"
    />
    <TerminalChips v-if="!isOperator" />
  </div>
</template>

<style scoped>
/* The chat overlays only the terminal area, so the mission bar above and the
   chip bar below stay docked around it rather than hidden beneath it. */
.terminal-view__stage {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.terminal-view__frozen-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 4px 10px;
  color: #8cbcff;
  background: var(--bg-secondary);
  border-bottom: 1px solid #8cbcff;
}

.terminal-view__chat-toggle {
  position: absolute;
  top: var(--spacing-sm);
  right: var(--spacing-md);
  z-index: 2;
}
</style>
