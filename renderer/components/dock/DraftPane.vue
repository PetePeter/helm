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
import { useChatStore } from '../../stores/chat.js';
import { useDraft } from '../../composables/useDraft.js';
import { useTimeActivity } from '../../composables/useTimeActivity.js';
import { DRAFT_MAX_BYTES, type DraftSend } from '../../../src/types/draft.js';
import { deliverBulkText } from '../../paste-handler.js';

const appStore = useAppStore();
const chatStore = useChatStore();
const state = appStore.state;
const { text, pad, loading, dirty, conflict, error, bytes, edit, flush, keepMine, takeTheirs } =
  useDraft(() => state.activeSessionId);
// Typing in a session's draft is the user's time on that session's project.
const timeActivity = useTimeActivity(() => (state.activeSessionId ? { sessionId: state.activeSessionId } : null));

const inputRef = ref<HTMLTextAreaElement | null>(null);
const view = ref<'draft' | 'history'>('draft');
const history = ref<DraftSend[]>([]);
const historyError = ref('');
const copyStatus = ref('');

async function loadHistory(sessionId: string): Promise<void> {
  historyError.value = '';
  try {
    const entries = await window.helm.sessions.draftHistory(sessionId);
    if (state.activeSessionId === sessionId) history.value = entries;
  } catch {
    if (state.activeSessionId === sessionId) historyError.value = 'Could not load send history.';
  }
}

watch(() => state.activeSessionId, sessionId => {
  history.value = [];
  copyStatus.value = '';
  view.value = 'draft';
  if (sessionId) void loadHistory(sessionId);
}, { immediate: true });

async function copySend(entry: DraftSend): Promise<void> {
  try {
    await navigator.clipboard.writeText(entry.text);
    copyStatus.value = 'Copied';
  } catch {
    copyStatus.value = 'Copy failed';
  }
}

const kb = (n: number) => (n / 1024).toFixed(1);
const size = computed(() => `${kb(bytes.value)} / ${kb(DRAFT_MAX_BYTES)} KB`);
const status = computed(() => {
  if (loading.value) return 'Loading';
  if (dirty.value) return conflict.value ? 'Not saved' : 'Saving';
  if (!pad.value?.updatedBy) return '';
  return pad.value.updatedBy === 'ai' ? 'Last edit by the AI' : 'Saved';
});
const sendViaChat = computed(() => {
  const source = appStore.activeSession?.lastUserPromptSource;
  return source === 'phone' || source === 'chat';
});
const sendTarget = computed(() => sendViaChat.value ? 'Chat' : 'the CLI');

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

/**
 * Send the pad through the medium of the last user prompt, then clear it.
 * A frozen session takes no input (docs/session-freeze.md), so the send is
 * silently dropped and the pad keeps its text for after the thaw.
 */
async function send(): Promise<void> {
  const sessionId = state.activeSessionId;
  const prompt = text.value;
  if (!sessionId || !prompt.trim() || appStore.activeSession?.frozen) return;
  const via = sendViaChat.value ? 'chat' : 'cli';
  if (via === 'chat') {
    if (!await chatStore.sendText(sessionId, prompt)) return;
  } else {
    await deliverBulkText(sessionId, prompt, { withReturn: true });
  }
  try {
    const entries = await window.helm.sessions.draftRecordSend(sessionId, prompt, via);
    if (state.activeSessionId === sessionId) history.value = entries;
  } catch {
    if (state.activeSessionId === sessionId) historyError.value = 'Sent, but could not save history.';
  }
  if (state.activeSessionId === sessionId && text.value === prompt) {
    edit('');
    await flush();
  }
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
    <nav class="draft-pane__tabs" aria-label="Draft views">
      <button type="button" :class="{ 'is-active': view === 'draft' }" @click="view = 'draft'">Draft</button>
      <button type="button" :class="{ 'is-active': view === 'history' }" @click="view = 'history'">History ({{ history.length }})</button>
    </nav>
    <div v-if="view === 'history'" class="draft-pane__history" aria-label="Sent Draft history">
      <p>Last 10 sends from Draft for this session. Copy an earlier text without changing the current draft.</p>
      <p v-if="historyError" role="alert">{{ historyError }}</p>
      <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
      <p v-if="!history.length">No Draft sends yet for this session.</p>
      <article v-for="(entry, index) in history" :key="`${entry.at}-${index}`" class="draft-pane__entry">
        <div class="draft-pane__meta"><strong>{{ new Date(entry.at).toLocaleString() }}</strong> via {{ entry.via === 'chat' ? 'Chat' : 'CLI' }}</div>
        <pre>{{ entry.text }}</pre>
        <button type="button" class="btn btn--sm" @click="copySend(entry)">Copy text</button>
      </article>
    </div>
    <template v-else>
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
        :title="`Send via ${sendTarget} and clear (Ctrl+Enter)`"
        :disabled="loading || !text.trim()"
        @click="send"
      >Send</button>
    </footer>
    </template>
  </section>
  <EmptyState v-else title="No session selected" hint="Each session has its own draft." icon="🗒" />
</template>

<style scoped>
.draft-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.draft-pane__tabs { display: flex; gap: var(--spacing-xs); padding: var(--spacing-xs) var(--spacing-sm) 0; border-bottom: 1px solid var(--border); }
.draft-pane__tabs button { border: 0; border-radius: 5px 5px 0 0; padding: var(--spacing-xs) var(--spacing-sm); background: transparent; color: var(--text-secondary); cursor: pointer; }
.draft-pane__tabs button.is-active { background: var(--bg-secondary); color: var(--text-primary); }
.draft-pane__history { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-sm); color: var(--text-secondary); font-size: var(--font-size-sm); }
.draft-pane__entry { margin-bottom: var(--spacing-sm); padding: var(--spacing-sm); border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); }
.draft-pane__meta { font-size: var(--font-size-xs); }
.draft-pane__entry pre { max-height: 80px; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-primary); font: inherit; }
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
