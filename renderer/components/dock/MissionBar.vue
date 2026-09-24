<script setup lang="ts">
/**
 * MissionBar — the session's TL;DR, pinned above its terminal.
 *
 * Why it exists: with several AI sessions running, the fastest way to know what
 * one is FOR is a line on top of it that both you and the AI keep current. The
 * AI writes through MCP `session_mission_set`, you write here; both land in the
 * same SessionManager validator (docs/mission-statement.md).
 *
 * The text may be AI-authored, so it is rendered ONLY through text
 * interpolation (invariant 9) — never v-html.
 *
 * Keyboard: the editor is a plain <textarea> outside `.xterm`, which the
 * keyboard router already classes as an editable field — terminal relay
 * handlers are skipped, so typing here never reaches the PTY.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { sessionsClient } from '../../ipc/clients.js';
import { formatElapsed } from '../../../src/utils/time-parser.js';
import { clampMissionBarHeight, MISSION_BAR_DEFAULT_PX } from '../../terminal/mission-bar-size.js';

const MAX_CHARS = 500;

const props = defineProps<{
  sessionId: string;
  mission?: { text: string; setBy: 'user' | 'ai'; setAt: number };
  height?: number;
}>();

const rootRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const editing = ref(false);
const draft = ref('');
const saving = ref(false);
const error = ref('');
const now = ref(Date.now());
const liveHeight = ref(props.height ?? MISSION_BAR_DEFAULT_PX);

let clock: ReturnType<typeof setInterval> | null = null;
let drag: { startY: number; startHeight: number } | null = null;

const meta = computed(() => {
  if (!props.mission) return '';
  const who = props.mission.setBy === 'ai' ? 'AI' : 'user';
  const elapsed = formatElapsed(now.value - props.mission.setAt);
  return `by ${who} · ${elapsed === 'just now' ? elapsed : `${elapsed} ago`}`;
});

// A different session (or a persisted height arriving) resets the view state.
watch(() => props.sessionId, () => cancelEdit());
watch(() => props.height, (h) => { if (!drag) liveHeight.value = h ?? MISSION_BAR_DEFAULT_PX; });

async function startEdit(): Promise<void> {
  draft.value = props.mission?.text ?? '';
  error.value = '';
  editing.value = true;
  await nextTick();
  textareaRef.value?.focus();
}

function cancelEdit(): void {
  editing.value = false;
  error.value = '';
}

/** Main owns validation; a rejected save keeps the editor open with the reason. */
async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const result = await sessionsClient.sessionSetMission(props.sessionId, draft.value);
    if (result?.success) cancelEdit();
    else error.value = result?.error ?? 'Could not save the mission';
  } catch (err) {
    error.value = String(err);
  } finally {
    saving.value = false;
  }
}

function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelEdit();
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void save();
  }
}

function paneHeight(): number {
  return rootRef.value?.parentElement?.clientHeight ?? 0;
}

function onResizeStart(event: MouseEvent): void {
  event.preventDefault();
  drag = { startY: event.clientY, startHeight: liveHeight.value };
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}

function onResizeMove(event: MouseEvent): void {
  if (!drag) return;
  liveHeight.value = clampMissionBarHeight(drag.startHeight + (event.clientY - drag.startY), paneHeight());
}

/** Persist once per drag, not per mousemove. */
function onResizeEnd(event: MouseEvent): void {
  onResizeMove(event);
  stopResizeListeners();
  drag = null;
  void sessionsClient.sessionSetMissionBarHeight(props.sessionId, liveHeight.value);
}

function stopResizeListeners(): void {
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
}

onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  stopResizeListeners();
});
</script>

<template>
  <section ref="rootRef" class="mission-bar" :style="{ height: `${liveHeight}px` }" aria-label="Session mission">
    <header class="mission-bar__head">
      <span class="mission-bar__label">◎ Mission</span>
      <span v-if="mission && !editing" class="mission-bar__meta">{{ meta }}</span>
      <span v-if="editing" class="mission-bar__counter">{{ draft.length }}/{{ MAX_CHARS }}</span>
      <button
        v-if="!editing"
        type="button"
        class="btn btn--ghost btn--sm mission-bar__edit"
        title="Edit mission"
        aria-label="Edit mission"
        @click="startEdit"
      >✎</button>
    </header>
    <div class="mission-bar__body">
      <template v-if="editing">
        <textarea
          ref="textareaRef"
          v-model="draft"
          class="mission-bar__input"
          :maxlength="MAX_CHARS"
          :disabled="saving"
          placeholder="What is this session meant to be doing?"
          @keydown="onEditorKeydown"
        ></textarea>
        <div v-if="error" class="mission-bar__error">{{ error }}</div>
      </template>
      <p v-else-if="mission" class="mission-bar__text" title="Click to edit" @click="startEdit">{{ mission.text }}</p>
      <p v-else class="mission-bar__text mission-bar__placeholder" @click="startEdit">No mission yet — the AI will set one, or click to write it.</p>
    </div>
    <div class="mission-bar__resize" title="Drag to resize" @mousedown="onResizeStart"></div>
  </section>
</template>

<style scoped>
.mission-bar {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 28px;
  padding: var(--spacing-xs) var(--spacing-sm) 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
}
.mission-bar__head { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 18px; }
.mission-bar__label { color: var(--accent); font-weight: 600; white-space: nowrap; }
.mission-bar__meta,
.mission-bar__counter { color: var(--text-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
.mission-bar__edit { margin-left: auto; padding: 0 var(--spacing-xs); line-height: 1; }
.mission-bar__body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: var(--spacing-xs); }
.mission-bar__text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
.mission-bar__placeholder { font-style: italic; color: var(--text-dim); }
.mission-bar__input {
  width: 100%;
  height: 100%;
  min-height: 20px;
  resize: none;
  box-sizing: border-box;
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px var(--spacing-xs);
}
.mission-bar__input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus); }
.mission-bar__error { color: var(--danger); font-size: var(--font-size-xs); }
.mission-bar__resize {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 5px;
  cursor: ns-resize;
}
.mission-bar__resize:hover { background: var(--focus); }
</style>
