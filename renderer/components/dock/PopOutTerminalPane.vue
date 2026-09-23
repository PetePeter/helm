<script setup lang="ts">
/**
 * PopOutTerminalPane — the `terminal` view inside a snapped-out window.
 *
 * The main window's TerminalPane hands its container to the shared
 * TerminalManager, which owns every session's xterm. A pop-out has exactly one
 * session and no manager, so this pane owns its TerminalView directly: attach
 * for PTY ownership, replay, then live `pty:data`.
 *
 * The session comes from the store pin, never a prop, so this pane and every
 * other pane in the window are looking at the same session by construction.
 *
 * Closing the pane disposes xterm but deliberately does NOT release PTY
 * ownership — that belongs to snap-back, which the shell owns. Restoring the
 * pane re-attaches and replays, so a closed terminal tab is a view decision and
 * never loses output.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { TerminalView } from '../../terminal/terminal-view.js';
import { fitAndSyncPty } from '../../terminal/fit-and-sync-pty.js';
import { useTerminalKeys } from '../../composables/useTerminalKeys.js';
import { slotToIndex } from '../../composables/useNumberAccelerator.js';
import { registerKeyHandler } from '../../keyboard/router.js';
import { createNumberKeyHandlers } from '../../keyboard/handlers/number-keys.js';
import { useAppStore } from '../../stores/app.js';
import { useChipBarStore } from '../../stores/chip-bar.js';
import { deliverBulkText } from '../../paste-handler.js';
import { deliverPromptSequence } from '../../sequence-delivery.js';
import { contextMenu } from '../../stores/modal-bridge.js';
import { usePromptApplyFlow } from '../../composables/usePromptApplyFlow.js';
import TerminalChips from '../chips/TerminalChips.vue';
import ContextMenu from '../modals/ContextMenu.vue';
import { configClient, eventsClient, sessionsClient, terminalClient } from '../../ipc/clients.js';
import { initConfigCache } from '../../bindings.js';
import { state as legacyState } from '../../state.js';
import { cliTypeWantsMouseTracking } from '../../utils.js';

const appStore = useAppStore();
const chipBarStore = useChipBarStore();
const containerRef = ref<HTMLElement | null>(null);

/** The pinned session. Reading it live keeps every pane on one source of truth. */
const sessionId = computed(() => appStore.state.activeSessionId ?? '');

let view: TerminalView | null = null;
let unsubData: (() => void) | null = null;
let unsubExit: (() => void) | null = null;
let cancelFit: (() => void) | null = null;
let fitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Attach is a round trip, and closing the pane mid-flight would otherwise let
 * the continuation build an xterm and its listeners after `onUnmounted` has
 * already run — nothing would ever tear them down.
 */
let unmounted = false;
/** Held past unmount: Vue clears the template ref before `onUnmounted` runs. */
let container: HTMLElement | null = null;


const { openPromptPicker } = usePromptApplyFlow(() => sessionId.value);

async function getEscProtectionEnabled(): Promise<boolean> {
  try { return await configClient.configGetEscProtectionEnabled(); }
  catch (error) { console.error('Failed to get ESC protection setting for snapped-out window:', error); return true; }
}

useTerminalKeys({ getActiveSessionId: () => sessionId.value || null, getEscProtectionEnabled });

// Ctrl+<n>: ask the main window to focus the Nth session wherever it lives.
// Alt+<n>: fire the Nth chip action for this popped-out session.
// Resolution is async (round-trip to the main window), so Ctrl+<n> is always
// consumed here — it is reserved for navigation in a pop-out and must never
// leak a digit into the terminal, even when the slot maps to nothing. It also
// never re-targets this window, whose session is pinned.
const numberKeyHandlers = createNumberKeyHandlers({
  jumpToSession: (slot) => { void sessionsClient.sessionRequestFocusSlot(slot); return true; },
  fireChipAction: (slot) => {
    const action = chipBarStore.actions[slotToIndex(slot)];
    if (!action) return false;
    void chipBarStore.triggerAction(action.sequence);
    return true;
  },
});

function syncFit(): void {
  if (!view) return;
  cancelFit?.();
  cancelFit = fitAndSyncPty(
    sessionId.value,
    view,
    (id, cols, rows) => terminalClient.ptyResize?.(id, cols, rows),
  );
}

function debouncedFit(): void {
  if (fitDebounceTimer !== null) clearTimeout(fitDebounceTimer);
  fitDebounceTimer = setTimeout(() => { fitDebounceTimer = null; syncFit(); }, 50);
}

/**
 * The bridge state is the only flag, exactly as in the main window. A second
 * local `visible` ref used to leave `contextMenu.visible` stuck true after a
 * dismissal, which made the router treat the window as permanently modal.
 */
function onContextMenuOpen(event: MouseEvent): void {
  event.preventDefault();
  contextMenu.selectedText = view?.getSelection() ?? '';
  contextMenu.hasSelection = view?.hasSelection() ?? false;
  contextMenu.sourceSessionId = sessionId.value;
  contextMenu.visible = true;
}

async function onContextMenuAction(action: string): Promise<void> {
  contextMenu.visible = false;
  const id = sessionId.value;
  switch (action) {
    case 'copy': {
      const text = view?.getSelection() ?? '';
      if (text) navigator.clipboard.writeText(text);
      break;
    }
    case 'paste':
      navigator.clipboard.readText().then((text) => { if (text) void deliverBulkText(id, text); });
      break;
    case 'editor': {
      const { showEditorPopup } = await import('../../editor/editor-popup.js');
      showEditorPopup((text) => { void deliverPromptSequence(id, text); });
      break;
    }
    case 'prompts':
      void openPromptPicker();
      break;
    case 'snap-back':
      void snapBack();
      break;
  }
}

/** Release PTY ownership before the main window re-adopts the session. */
async function snapBack(): Promise<void> {
  const id = sessionId.value;
  try {
    await terminalClient.terminalDetach?.(id);
    await sessionsClient.sessionSnapBack(id);
  } catch (error) {
    console.error('[SnapOut] Failed to snap back:', error);
  }
}

function onContextMenuCancel(): void { contextMenu.visible = false; }

const keyHandlerCleanups: Array<() => void> = [];
let resizeObserver: ResizeObserver | null = null;
const handleWindowResize = (): void => debouncedFit();

onMounted(async () => {
  container = containerRef.value;
  const id = sessionId.value;
  if (!container || !id) return;

  // A freshly opened pop-out may mount before bootstrap filled the tools cache;
  // the mouse-tracking opt-in must be known before xterm starts parsing.
  // Awaited before attach so it cannot widen the attach→listener output race.
  if (Object.keys(legacyState.cliToolsCache ?? {}).length === 0) await initConfigCache();
  if (unmounted) return;
  const cliType = appStore.state.sessions.find((s) => s.id === id)?.cliType;

  const attachResult = await terminalClient.terminalAttach?.(id);
  if (unmounted) return;
  if (attachResult && !attachResult.success) {
    console.error('[SnapOut] Failed to attach terminal ownership:', attachResult.error);
    try { await sessionsClient.sessionSnapBack(id); }
    catch (error) { console.error('[SnapOut] Failed to recover after attach failure:', error); }
    return;
  }

  // Register the output listener before constructing xterm. The PTY can emit
  // while the child is attaching; replay from the main process covers prior
  // output and this short queue covers the handoff race.
  const pendingOutput: string[] = [];
  unsubData = eventsClient.onPtyData((eventSessionId: string, data: string) => {
    if (eventSessionId !== sessionId.value) return;
    if (view) view.write(data);
    else pendingOutput.push(data);
  });

  view = new TerminalView({
    sessionId: id,
    container,
    mouseTracking: cliTypeWantsMouseTracking(cliType),
    onData: (data) => { terminalClient.ptyWrite?.(id, data); },
    onScrollInput: (data) => { terminalClient.ptyScrollInput?.(id, data); },
    onResize: (cols, rows) => { terminalClient.ptyResize?.(id, cols, rows); },
    // Through the store rather than an event, so the shell's title watcher and
    // every other pane see the same session record.
    onTitleChange: (title) => { appStore.updateSession(id, { title }); },
  });

  if (attachResult?.replay) view.write(attachResult.replay);
  for (const data of pendingOutput) view.write(data);
  pendingOutput.length = 0;

  unsubExit = eventsClient.onPtyExit((eventSessionId: string) => {
    if (eventSessionId === sessionId.value) view?.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
  });

  syncFit();
  view.focus();
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => debouncedFit());
    resizeObserver.observe(container);
  }
  window.addEventListener('resize', handleWindowResize);
  container.addEventListener('contextmenu', onContextMenuOpen);
  for (const handler of numberKeyHandlers) keyHandlerCleanups.push(registerKeyHandler(handler));

  await chipBarStore.refresh(id);
});

onUnmounted(() => {
  unmounted = true;
  window.removeEventListener('resize', handleWindowResize);
  container?.removeEventListener('contextmenu', onContextMenuOpen);
  container = null;
  for (const cleanup of keyHandlerCleanups.splice(0)) cleanup();
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (fitDebounceTimer !== null) clearTimeout(fitDebounceTimer);
  fitDebounceTimer = null;
  cancelFit?.();
  cancelFit = null;
  unsubData?.();
  unsubData = null;
  unsubExit?.();
  unsubExit = null;
  view?.dispose();
  view = null;
});

defineExpose({ snapBack });
</script>

<template>
  <div class="popout-terminal-pane">
    <div ref="containerRef" class="popout-terminal"></div>
    <TerminalChips />
    <ContextMenu
      v-model:visible="contextMenu.visible"
      :has-selection="contextMenu.hasSelection"
      :has-active-session="true"
      :has-sequences="false"
      :has-drafts="false"
      :is-snapped-out="true"
      @action="onContextMenuAction"
      @cancel="onContextMenuCancel"
    />
  </div>
</template>

<style scoped>
.popout-terminal-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: #0a0a0a; }
.popout-terminal { flex: 1; min-width: 0; min-height: 0; position: relative; overflow: hidden; z-index: 1; }
</style>
