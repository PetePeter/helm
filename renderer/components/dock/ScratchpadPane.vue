<script setup lang="ts">
/**
 * ScratchpadPane: the `scratchpad` tool window, one pad per session.
 *
 * Bound to the active session like the Artifacts pane. You type here; the
 * session's LLM reads and writes the same pad through MCP, and its edits show
 * up as they land (docs/scratchpad.md).
 *
 * The pad may hold AI-authored text, so it is only ever a <textarea> value,
 * never markup (invariant 9). A plain <textarea> outside `.xterm` is also what
 * keeps typing here away from the PTY (docs/keyboard-routing.md).
 */
import { computed, nextTick, ref, watch } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import { useAppStore } from '../../stores/app.js';
import { useScratchpad } from '../../composables/useScratchpad.js';
import { useTimeActivity } from '../../composables/useTimeActivity.js';
import { SCRATCHPAD_MAX_BYTES } from '../../../src/types/scratchpad.js';

const state = useAppStore().state;
const { text, pad, loading, dirty, conflict, error, bytes, edit, flush, keepMine, takeTheirs } =
  useScratchpad(() => state.activeSessionId);
// Typing in a session's scratchpad is the user's time on that session's project.
const timeActivity = useTimeActivity(() => (state.activeSessionId ? { sessionId: state.activeSessionId } : null));

const inputRef = ref<HTMLTextAreaElement | null>(null);

const kb = (n: number) => (n / 1024).toFixed(1);
const size = computed(() => `${kb(bytes.value)} / ${kb(SCRATCHPAD_MAX_BYTES)} KB`);
const status = computed(() => {
  if (loading.value) return 'Loading';
  if (dirty.value) return conflict.value ? 'Not saved' : 'Saving';
  if (!pad.value?.updatedBy) return '';
  return pad.value.updatedBy === 'ai' ? 'Last edit by the AI' : 'Saved';
});

// Setting a textarea's value drops the caret at the end. When the text changes
// under the user (an LLM edit), put the caret back where it was.
watch(text, async (next) => {
  const el = inputRef.value;
  if (!el || el.value === next) return; // the user's own keystroke: the DOM is already there
  const { selectionStart, selectionEnd } = el;
  await nextTick();
  el.setSelectionRange(Math.min(selectionStart, next.length), Math.min(selectionEnd, next.length));
}, { flush: 'pre' });

function onInput(event: Event): void {
  edit((event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <section
    v-if="state.activeSessionId"
    class="scratchpad-pane"
    aria-label="Session scratchpad"
    @keydown="timeActivity.onKeydown"
  >
    <div v-if="conflict" class="scratchpad-pane__conflict" role="alert">
      <span>The scratchpad was changed while you were typing.</span>
      <button type="button" class="btn btn--sm" data-scratchpad-keep-mine @click="keepMine">Keep mine</button>
      <button type="button" class="btn btn--sm" data-scratchpad-take-theirs @click="takeTheirs">Take theirs</button>
    </div>
    <textarea
      ref="inputRef"
      class="scratchpad-pane__input"
      :value="text"
      :disabled="loading"
      spellcheck="false"
      aria-label="Scratchpad text"
      placeholder="Notes for this session. You type here; the session's AI can read and write it too."
      @input="onInput"
      @blur="flush"
    ></textarea>
    <footer class="scratchpad-pane__status">
      <span v-if="error" class="scratchpad-pane__error" role="alert">{{ error }}</span>
      <span v-else>{{ status }}</span>
      <span class="scratchpad-pane__size" :class="{ 'is-over': bytes > SCRATCHPAD_MAX_BYTES }">{{ size }}</span>
    </footer>
  </section>
  <EmptyState v-else title="No session selected" hint="Each session has its own scratchpad." icon="🗒" />
</template>

<style scoped>
.scratchpad-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.scratchpad-pane__conflict {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}
.scratchpad-pane__input {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 0;
  padding: var(--spacing-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
.scratchpad-pane__input:focus { outline: none; box-shadow: inset 0 0 0 1px var(--accent); }
.scratchpad-pane__status {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: 2px var(--spacing-sm);
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}
.scratchpad-pane__size { margin-left: auto; white-space: nowrap; }
.scratchpad-pane__error,
.scratchpad-pane__size.is-over { color: var(--danger); }
</style>
