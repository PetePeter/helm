<script setup lang="ts">
/**
 * DraftPane: the `draft` tool window, one pad per session.
 *
 * Bound to the active session like the Artifacts pane. You type here; the
 * session's LLM reads and writes the same pad through MCP, and its edits show
 * up as they land (docs/draft.md).
 *
 * The pad may hold AI-authored text, so it is only ever a <textarea> value,
 * never markup (invariant 9). A plain <textarea> outside `.xterm` is also what
 * keeps typing here away from the PTY (docs/keyboard-routing.md).
 */
import { computed, nextTick, ref, watch } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import { useAppStore } from '../../stores/app.js';
import { useDraft } from '../../composables/useDraft.js';
import { useTimeActivity } from '../../composables/useTimeActivity.js';
import { DRAFT_MAX_BYTES } from '../../../src/types/draft.js';
import { deliverBulkText } from '../../paste-handler.js';

const state = useAppStore().state;
const { text, pad, loading, dirty, conflict, error, bytes, edit, flush, keepMine, takeTheirs } =
  useDraft(() => state.activeSessionId);
// Typing in a session's draft is the user's time on that session's project.
const timeActivity = useTimeActivity(() => (state.activeSessionId ? { sessionId: state.activeSessionId } : null));

const inputRef = ref<HTMLTextAreaElement | null>(null);

const kb = (n: number) => (n / 1024).toFixed(1);
const size = computed(() => `${kb(bytes.value)} / ${kb(DRAFT_MAX_BYTES)} KB`);
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

/** Send the pad to the session's CLI as a prompt (submitted), then clear it. */
async function send(): Promise<void> {
  const sessionId = state.activeSessionId;
  const prompt = text.value;
  if (!sessionId || !prompt.trim()) return;
  await deliverBulkText(sessionId, prompt, { withReturn: true });
  edit('');
  await flush();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !event.ctrlKey) return;
  event.preventDefault();
  void send();
}
</script>

<template>
  <section
    v-if="state.activeSessionId"
    class="draft-pane"
    aria-label="Session draft"
    @keydown="timeActivity.onKeydown"
  >
    <div v-if="conflict" class="draft-pane__conflict" role="alert">
      <span>The draft was changed while you were typing.</span>
      <button type="button" class="btn btn--sm" data-draft-keep-mine @click="keepMine">Keep mine</button>
      <button type="button" class="btn btn--sm" data-draft-take-theirs @click="takeTheirs">Take theirs</button>
    </div>
    <textarea
      ref="inputRef"
      class="draft-pane__input"
      data-autofocus
      :value="text"
      :disabled="loading"
      spellcheck="false"
      aria-label="Draft text"
      placeholder="Notes for this session. You type here; the session's AI can read and write it too."
      @input="onInput"
      @keydown="onKeydown"
      @blur="flush"
    ></textarea>
    <footer class="draft-pane__status">
      <span v-if="error" class="draft-pane__error" role="alert">{{ error }}</span>
      <span v-else>{{ status }}</span>
      <span class="draft-pane__size" :class="{ 'is-over': bytes > DRAFT_MAX_BYTES }">{{ size }}</span>
      <button
        type="button"
        class="btn btn--primary btn--sm"
        data-draft-send
        title="Send to the session's CLI and clear (Ctrl+Enter)"
        :disabled="loading || !text.trim()"
        @click="send"
      >Send</button>
    </footer>
  </section>
  <EmptyState v-else title="No session selected" hint="Each session has its own draft." icon="🗒" />
</template>

<style scoped>
.draft-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.draft-pane__conflict {
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
.draft-pane__input {
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
.draft-pane__input:focus { outline: none; box-shadow: inset 0 0 0 1px var(--accent); }
.draft-pane__status {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: 2px var(--spacing-sm);
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}
.draft-pane__size { margin-left: auto; white-space: nowrap; }
.draft-pane__error,
.draft-pane__size.is-over { color: var(--danger); }
</style>
