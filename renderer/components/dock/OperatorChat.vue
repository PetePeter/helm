<script setup lang="ts">
/**
 * OperatorChat — the Helm operator's pane as a chat thread, the desktop twin of
 * the phone's operator screen. Bubbles come from the chat journal
 * (useOperatorChat); Terminal flips back to the raw PTY; Call is the same
 * hands-free call as the sidebar's. The PTT key (Settings → Operator) or the
 * mic button is held to dictate into the composer.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { operatorPttKey as pttKey, operatorView, useOperatorChat } from '../../composables/useOperatorChat.js';
import { useVoiceCall } from '../../composables/useVoiceCall.js';
import { composerKeyAction } from '../../operator/operator-chat.js';
import { configClient, dialogClient } from '../../ipc/clients.js';
import { registerKeyHandler } from '../../keyboard/router.js';

const chat = useOperatorChat();
const { bubbles, draft, attachment, sending, recording, transcribing, error } = chat;
const { inCall, handsFree, toggleCall, hangUp } = useVoiceCall();

const thread = ref<HTMLElement | null>(null);
const attachmentName = computed(() => attachment.value?.split(/[\\/]/).pop() ?? '');
const pttLabel = computed(() => pttKey.value.toUpperCase());

function onCallClick(): void {
  if (inCall.value && !handsFree.value) hangUp();
  else void toggleCall();
}

function onComposerKey(event: KeyboardEvent): void {
  const action = composerKeyAction(event);
  if (action !== 'send') return; // newline: the textarea's default
  event.preventDefault();
  void chat.send();
}

async function pickAttachment(): Promise<void> {
  const selected = await dialogClient.dialogShowOpenFile?.([{ name: 'All Files', extensions: ['*'] }]);
  if (selected) attachment.value = selected;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Keep the newest message in view.
watch(() => bubbles.value.length, async () => {
  await nextTick();
  thread.value?.scrollTo({ top: thread.value.scrollHeight });
});

// Hold-to-talk key: pressed through the one key router, released on its keyup.
let releaseKey: string | null = null;
function releasePtt(): void {
  releaseKey = null;
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', releasePtt);
  void chat.pttStop();
}
function onKeyUp(event: KeyboardEvent): void {
  if (event.key === releaseKey) releasePtt();
}
const unregister = registerKeyHandler({
  id: 'operator-chat-ptt',
  scope: 'global',
  allowInEditable: true,
  claims: (ctx) => ctx.combo === pttKey.value && !ctx.event.repeat,
  handle: (ctx) => {
    if (releaseKey === null) {
      releaseKey = ctx.event.key;
      window.addEventListener('keyup', onKeyUp, true);
      // Alt-Tab mid-hold swallows the keyup: losing focus releases too.
      window.addEventListener('blur', releasePtt);
      void chat.pttStart();
    }
    return true;
  },
});

onMounted(async () => {
  void chat.open();
  pttKey.value = (await configClient.configGetOperatorConfig()).pttKey;
});

onBeforeUnmount(() => {
  unregister();
  releasePtt();
  chat.close();
});
</script>

<template>
  <div class="operator-chat">
    <div class="operator-chat__header">
      <span class="operator-chat__title">Helm operator</span>
      <button
        class="btn btn--sm focusable"
        :class="inCall ? 'btn--danger' : 'btn--secondary'"
        type="button"
        @click="onCallClick"
      >{{ inCall ? 'Hang up' : 'Call' }}</button>
      <button class="btn btn--sm btn--secondary focusable" type="button" title="Show the operator's terminal" @click="operatorView = 'terminal'">Terminal</button>
    </div>

    <div ref="thread" class="operator-chat__thread">
      <div v-if="bubbles.length === 0" class="operator-chat__empty">No messages yet. Ask Helm anything.</div>
      <div
        v-for="bubble in bubbles"
        :key="bubble.seq"
        class="operator-chat__bubble"
        :class="`operator-chat__bubble--${bubble.from}`"
      >
        <div class="operator-chat__text">{{ bubble.text }}</div>
        <div class="operator-chat__time">{{ time(bubble.at) }}</div>
      </div>
    </div>

    <div v-if="error" class="operator-chat__error" role="alert">{{ error }}</div>

    <div class="operator-chat__composer">
      <button class="btn btn--sm btn--secondary focusable" type="button" title="Attach a file" @click="pickAttachment">📎</button>
      <div class="operator-chat__input-wrap">
        <div v-if="attachment" class="operator-chat__attachment">
          📎 {{ attachmentName }}
          <button type="button" class="operator-chat__attachment-clear" title="Remove attachment" @click="attachment = null">✕</button>
        </div>
        <textarea
          v-model="draft"
          class="operator-chat__input"
          rows="2"
          placeholder="Message the operator…"
          @keydown="onComposerKey"
        />
      </div>
      <button
        class="operator-chat__ptt focusable"
        :class="{ 'operator-chat__ptt--live': recording }"
        type="button"
        :title="`Hold to talk (or hold ${pttLabel})`"
        @pointerdown.prevent="chat.pttStart()"
        @pointerup="chat.pttStop()"
        @pointerleave="chat.pttStop()"
      >{{ transcribing ? '…' : '🎤' }}</button>
      <button
        class="btn btn--sm btn--primary focusable"
        type="button"
        :disabled="sending || !draft.trim()"
        @click="chat.send()"
      >Send</button>
    </div>
    <div class="operator-chat__hint">Enter to send · Shift/Ctrl+Enter for a new line · Hold 🎤 or {{ pttLabel }} to talk</div>
  </div>
</template>

<style scoped>
.operator-chat {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.operator-chat__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}

.operator-chat__title {
  flex: 1;
  font-weight: 600;
}

.operator-chat__thread {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
}

.operator-chat__empty {
  margin: auto;
  color: var(--text-dim);
}

.operator-chat__bubble {
  max-width: 70%;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.operator-chat__bubble--you {
  align-self: flex-end;
  background: var(--accent);
  color: var(--accent-contrast);
  border-bottom-right-radius: 3px;
}

.operator-chat__bubble--helm {
  align-self: flex-start;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}

.operator-chat__time {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  opacity: 0.65;
}

.operator-chat__error {
  padding: var(--spacing-xs) var(--spacing-md);
  color: var(--danger);
}

.operator-chat__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-xs);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border);
}

.operator-chat__input-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.operator-chat__input {
  width: 100%;
  resize: none;
  padding: var(--spacing-sm);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font: inherit;
}

.operator-chat__input:focus {
  outline: none;
  border-color: var(--accent);
}

.operator-chat__attachment {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  align-self: flex-start;
  padding: 2px var(--spacing-sm);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
}

.operator-chat__attachment-clear {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.operator-chat__ptt {
  width: 40px;
  height: 36px;
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent);
  cursor: pointer;
  user-select: none;
}

.operator-chat__ptt--live {
  background: var(--accent);
  color: var(--accent-contrast);
}

.operator-chat__hint {
  padding: 0 var(--spacing-md) var(--spacing-sm);
  background: var(--bg-tertiary);
  color: var(--text-dim);
  font-size: var(--font-size-xs);
}
</style>
