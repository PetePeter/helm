<script setup lang="ts">
/**
 * "placeholder help" chip + popup: the {placeholders} a field fills and/or the
 * sequence keys, each click-to-insert. The host owns the input and the cursor,
 * so it receives `insert` and splices the token itself. Rows swallow mousedown
 * so the host input keeps its focus and selection.
 */
import { onBeforeUnmount, ref } from 'vue';
import { SEQUENCE_KEY_HELP } from '../../../src/config/template-placeholders.js';

defineProps<{
  /** `{name}` placeholders this field fills; omit for sequence-only editors. */
  placeholders?: readonly { name: string; meaning: string }[];
  /** List the sequence keys ({Enter}, {Wait 500}, …). */
  sequenceKeys?: boolean;
  label?: string;
}>();

const emit = defineEmits<{ insert: [token: string] }>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
/** `{name}` — built in script: a `}}` inside a template mustache ends it early. */
const braced = (name: string): string => `{${name}}`;

function onOutside(event: MouseEvent): void {
  if (!root.value?.contains(event.target as Node)) close();
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); close(); }
}
function toggle(): void {
  if (open.value) { close(); return; }
  open.value = true;
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}
function close(): void {
  open.value = false;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
onBeforeUnmount(close);
</script>

<template>
  <span ref="root" class="ph-help">
    <button type="button" class="ph-help__btn focusable" :class="{ 'ph-help__btn--open': open }" :aria-expanded="open" @mousedown.prevent @click="toggle">placeholder help</button>
    <div v-if="open" class="ph-help__pop" role="dialog" :aria-label="label ? `${label} placeholders` : 'Placeholders'">
      <template v-if="placeholders">
        <h4>Placeholders</h4>
        <p v-if="!placeholders.length" class="ph-help__none">None for this field.</p>
        <button v-for="p in placeholders" :key="p.name" type="button" class="ph-help__row" @mousedown.prevent @click="emit('insert', braced(p.name))">
          <code>{{ braced(p.name) }}</code><span>{{ p.meaning }}</span>
        </button>
      </template>
      <template v-if="sequenceKeys">
        <h4>Keys (sequence syntax)</h4>
        <button v-for="k in SEQUENCE_KEY_HELP" :key="k.token" type="button" class="ph-help__row" @mousedown.prevent @click="emit('insert', k.token)">
          <code>{{ k.token }}</code><span>{{ k.meaning }}</span>
        </button>
      </template>
      <p class="ph-help__foot">Click to insert at the cursor · Esc to close</p>
    </div>
  </span>
</template>

<style scoped>
.ph-help { position: relative; display: inline-flex; }
.ph-help__btn {
  font: var(--font-size-xs) var(--font-mono); padding: 1px var(--spacing-sm); border-radius: 10px; cursor: pointer;
  background: var(--accent-tint); color: var(--accent); border: 1px solid rgba(var(--accent-rgb), 0.3);
}
.ph-help__btn:hover, .ph-help__btn--open { background: var(--accent); color: var(--accent-contrast); }
.ph-help__pop {
  position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: min(440px, 90vw);
  padding: var(--spacing-sm); border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--bg-hover); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
}
.ph-help__pop h4 { margin: var(--spacing-xs); font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.ph-help__row {
  display: grid; grid-template-columns: 150px 1fr; gap: var(--spacing-sm); width: 100%; align-items: baseline;
  padding: 5px 6px; border: 0; border-radius: var(--radius-sm); background: none; text-align: left; cursor: pointer;
}
.ph-help__row:hover, .ph-help__row:focus-visible { background: var(--bg-tertiary); }
.ph-help__row code { font: var(--font-size-sm) var(--font-mono); color: var(--accent); }
.ph-help__row span { font-size: var(--font-size-xs); color: var(--text-secondary); }
.ph-help__none, .ph-help__foot { margin: var(--spacing-xs); font-size: var(--font-size-xs); color: var(--text-dim); }
</style>
