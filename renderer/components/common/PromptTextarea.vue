<script setup lang="ts">
/**
 * PromptTextarea — reusable editor for prompt/sequence fields that support
 * non-text commands such as {Enter}, {Send}, {Wait 500}, and {Ctrl+C}.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getSequenceSyntaxHelpText } from '../../utils.js';

const props = withDefaults(defineProps<{
  modelValue: string;
  id?: string;
  label?: string;
  placeholder?: string;
  rows?: number;
  minRows?: number;
  maxRows?: number;
  maxHeightPx?: number;
  textareaClass?: string;
  fill?: boolean;
}>(), {
  modelValue: '',
  rows: 3,
  minRows: 3,
  maxRows: 14,
  maxHeightPx: undefined,
  textareaClass: '',
  fill: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'resized', heightPx: number): void;
}>();

const syntaxHelpExpanded = ref(false);
const syntaxHelpText = getSequenceSyntaxHelpText();
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const manualHeight = ref<number | null>(null);
let activeResizePointerId: number | null = null;
let resizeStartY = 0;
let resizeStartHeight = 0;

function autosize(): void {
  const el = textareaRef.value;
  if (!el) return;
  if (props.fill) {
    el.style.height = '100%';
    el.style.overflowY = 'auto';
    return;
  }
  el.style.height = 'auto';
  const parsedLineHeight = parseFloat(getComputedStyle(el).lineHeight || '18');
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : 18;
  const minHeight = lineHeight * props.minRows;
  const maxHeight = props.maxHeightPx ?? lineHeight * props.maxRows;
  const contentFloor = manualHeight.value != null ? 0 : el.scrollHeight;
  const nextHeight = Math.min(Math.max(contentFloor, manualHeight.value ?? 0, minHeight), maxHeight);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > nextHeight ? 'auto' : 'hidden';
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
  nextTick(autosize);
}

function insertToken(token: string): void {
  const el = textareaRef.value;
  const value = props.modelValue ?? '';
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + token + value.slice(end);
  emit('update:modelValue', next);

  nextTick(() => {
    textareaRef.value?.focus();
    const pos = start + token.length;
    textareaRef.value?.setSelectionRange(pos, pos);
    autosize();
  });
}

function clampHeight(height: number): number {
  const el = textareaRef.value;
  if (!el) return height;
  const parsedLineHeight = parseFloat(getComputedStyle(el).lineHeight || '18');
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : 18;
  const maxHeight = props.maxHeightPx ?? lineHeight * props.maxRows;
  return Math.min(Math.max(height, lineHeight * props.minRows), maxHeight);
}

function onResizeMove(event: PointerEvent): void {
  if (activeResizePointerId !== null && event.pointerId !== activeResizePointerId) return;
  manualHeight.value = clampHeight(resizeStartHeight + event.clientY - resizeStartY);
  autosize();
}

function stopResize(): void {
  activeResizePointerId = null;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', stopResize);
  window.removeEventListener('pointercancel', stopResize);
  if (manualHeight.value !== null) emit('resized', manualHeight.value);
}

function startResize(event: PointerEvent): void {
  const el = textareaRef.value;
  if (!el) return;
  event.preventDefault();
  activeResizePointerId = event.pointerId;
  resizeStartY = event.clientY;
  resizeStartHeight = el.getBoundingClientRect().height;
  manualHeight.value = resizeStartHeight;
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', stopResize, { once: true });
  window.addEventListener('pointercancel', stopResize, { once: true });
  try { (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId); } catch { /* optional optimisation */ }
}

function focus(): void {
  textareaRef.value?.focus();
}

/** Focus the textarea and place the caret at the very end of the content. */
function focusEnd(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.focus();
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

function setHeight(heightPx: number): void {
  manualHeight.value = clampHeight(heightPx);
  autosize();
}

onMounted(autosize);
onBeforeUnmount(stopResize);
watch(() => props.modelValue, () => nextTick(autosize));

defineExpose({ focus, focusEnd, setHeight });
</script>

<template>
  <div class="prompt-textarea" :class="{ 'prompt-textarea--fill': props.fill }">
    <label v-if="label" :for="id" class="prompt-textarea__label">{{ label }}</label>

    <div class="prompt-textarea__editor-shell" :class="{ 'prompt-textarea__editor-shell--fill': props.fill }">
      <textarea
        :id="id"
        ref="textareaRef"
        :value="modelValue"
        :placeholder="placeholder"
        :rows="rows"
        class="prompt-textarea__editor"
        :class="[textareaClass, { 'prompt-textarea__editor--fill': props.fill }]"
        spellcheck="false"
        @input="onInput"
      />
      <button
        type="button"
        class="prompt-textarea__info"
        title="Prompt syntax help"
        aria-label="Prompt syntax help"
        @click="syntaxHelpExpanded = !syntaxHelpExpanded"
      >i</button>
      <div
        v-if="!props.fill"
        class="prompt-textarea__resize-grip"
        role="separator"
        aria-label="Resize prompt field vertically"
        aria-orientation="horizontal"
        title="Resize prompt field"
        @pointerdown="startResize"
      >
        <span></span>
      </div>
    </div>

    <div class="prompt-textarea__chips" aria-label="Insert prompt command">
      <button type="button" class="prompt-textarea__chip" @click="insertToken('{Send}')">Send</button>
      <button type="button" class="prompt-textarea__chip" @click="insertToken('{Enter}')">Enter</button>
      <button type="button" class="prompt-textarea__chip" @click="insertToken('{Wait 500}')">Wait</button>
      <button type="button" class="prompt-textarea__chip" @click="insertToken('{Ctrl+C}')">Ctrl+C</button>
    </div>

    <pre v-if="syntaxHelpExpanded" class="prompt-textarea__syntax-content">{{ syntaxHelpText }}</pre>
  </div>
</template>

<style scoped>
.prompt-textarea {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.prompt-textarea--fill {
  flex: 1 1 auto;
  min-height: 0;
}

.prompt-textarea__label {
  font-size: var(--font-size-sm);
  color: var(--accent);
  font-weight: 600;
}

.prompt-textarea__editor-shell {
  position: relative;
  min-width: 0;
}

.prompt-textarea__editor-shell--fill {
  flex: 1 1 auto;
  min-height: 0;
}

.prompt-textarea__editor {
  display: block;
  width: 100%;
  min-height: 0;
  resize: none;
  background: linear-gradient(180deg, rgba(100, 160, 255, 0.08), rgba(100, 160, 255, 0.025)), var(--bg-tertiary);
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  border-left: 4px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: var(--font-size-sm);
  line-height: 1.45;
  padding: var(--spacing-sm) 34px 18px var(--spacing-md);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.025);
}

.prompt-textarea__editor--fill {
  height: 100%;
}

.prompt-textarea__editor:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}

/* ItemEditor passes this class to the textarea rendered here. Keeping its
   style with the DOM owner preserves it under scoped CSS. */
.item-editor-content {
  padding: 6px 8px;
  background: #252535;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: 'Consolas', 'Courier New', monospace;
  min-height: 60px;
  outline: none;
  line-height: 1.4;
}

.item-editor-content:focus { border-color: var(--accent); }

.prompt-textarea__info {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 20px;
  height: 20px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  font-family: serif;
  line-height: 18px;
  cursor: pointer;
}

.prompt-textarea__info:hover {
  background: var(--accent);
  color: var(--bg-primary);
}

.prompt-textarea__resize-grip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
  z-index: 1;
}

.prompt-textarea__resize-grip span {
  width: 42px;
  height: 4px;
  border-top: 1px solid color-mix(in srgb, var(--accent) 65%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  opacity: 0.75;
}

.prompt-textarea__resize-grip:hover span {
  opacity: 1;
  border-color: var(--accent);
}

.prompt-textarea__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.prompt-textarea__chip {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  padding: 2px 8px;
  font-size: 0.72rem;
  cursor: pointer;
}

.prompt-textarea__chip:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

.prompt-textarea__syntax-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--spacing-sm) 10px;
  margin: 0;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
</style>
