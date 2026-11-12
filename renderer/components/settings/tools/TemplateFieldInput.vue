<script setup lang="ts">
/**
 * One command/action template field of the Tool editor: the input, a
 * "placeholder help" chip listing every {placeholder} this field fills (and the
 * sequence keys, for sequence fields), and a red warning for unknown {tokens}.
 * The list is src/config/template-placeholders.ts — the same one Helm fills from.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  FIELD_PLACEHOLDERS,
  SEQUENCE_FIELDS,
  SEQUENCE_KEY_HELP,
  unknownPlaceholders,
  type TemplateField,
} from '../../../../src/config/template-placeholders.js';

const props = defineProps<{
  field: TemplateField;
  inputId: string;
  label: string;
  note?: string;
  placeholder?: string;
  title?: string;
}>();
const model = defineModel<string>({ required: true });

const input = ref<HTMLInputElement | null>(null);
const root = ref<HTMLElement | null>(null);
const open = ref(false);

const placeholders = computed(() => FIELD_PLACEHOLDERS[props.field]);
const isSequence = computed(() => SEQUENCE_FIELDS.has(props.field));
/** `{name}` — built in script: a `}}` inside a template mustache ends it early. */
const braced = (name: string): string => `{${name}}`;
const unknown = computed(() => unknownPlaceholders(props.field, model.value ?? ''));

function insert(token: string): void {
  const el = input.value;
  const value = model.value ?? '';
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? start;
  model.value = value.slice(0, start) + token + value.slice(end);
  requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(start + token.length, start + token.length);
  });
}

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
  <div ref="root" class="tf">
    <div class="tf__label-row">
      <label :for="inputId" class="tf__label">{{ label }} <span v-if="note" class="tf__note">{{ note }}</span></label>
      <button type="button" class="tf__help focusable" :class="{ 'tf__help--open': open }" :aria-expanded="open" @mousedown.prevent @click="toggle">placeholder help</button>
    </div>
    <input
      :id="inputId"
      ref="input"
      v-model="model"
      type="text"
      :title="title"
      :placeholder="placeholder"
      class="focusable tf__input"
      :class="{ 'tf__input--bad': unknown.length }"
    />
    <p v-if="unknown.length" class="tf__warn" role="alert">
      Unknown placeholder {{ unknown.map(braced).join(', ') }} — it will be sent literally.
    </p>
    <div v-if="open" class="tf__pop" role="dialog" :aria-label="`${label} placeholders`">
      <h4>Placeholders</h4>
      <p v-if="!placeholders.length" class="tf__none">None for this field.</p>
      <button v-for="p in placeholders" :key="p.name" type="button" class="tf__row" @mousedown.prevent @click="insert(braced(p.name))">
        <code>{{ braced(p.name) }}</code><span>{{ p.meaning }}</span>
      </button>
      <template v-if="isSequence">
        <h4>Keys (sequence syntax)</h4>
        <button v-for="k in SEQUENCE_KEY_HELP" :key="k.token" type="button" class="tf__row" @mousedown.prevent @click="insert(k.token)">
          <code>{{ k.token }}</code><span>{{ k.meaning }}</span>
        </button>
      </template>
      <p class="tf__foot">Click to insert at the cursor · Esc to close</p>
    </div>
  </div>
</template>

<style scoped>
.tf { position: relative; display: flex; flex-direction: column; gap: var(--spacing-xs); }
.tf__label { font-size: var(--font-size-sm); color: var(--text-secondary); font-weight: 500; }
.tf__note { color: var(--text-dim); font-weight: 400; font-size: 0.85em; margin-left: var(--spacing-xs); }
.tf__input {
  width: 100%; padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: var(--font-size-sm);
}
.tf__input:focus { border-color: var(--accent); outline: none; }
.tf__label-row { display: flex; align-items: center; gap: var(--spacing-sm); }
.tf__help {
  font: var(--font-size-xs) var(--font-mono); padding: 1px var(--spacing-sm); border-radius: 10px; cursor: pointer;
  background: var(--accent-tint); color: var(--accent); border: 1px solid rgba(var(--accent-rgb), 0.3);
}
.tf__help:hover, .tf__help--open { background: var(--accent); color: var(--accent-contrast); }
.tf__input--bad { border-color: var(--danger-border); }
.tf__warn { margin: var(--spacing-xs) 0 0; font-size: var(--font-size-xs); color: var(--danger); }
.tf__pop {
  position: absolute; z-index: 20; top: 24px; left: 0; width: min(440px, 100%);
  padding: var(--spacing-sm); border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--bg-hover); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
}
.tf__pop h4 { margin: var(--spacing-xs); font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.tf__row {
  display: grid; grid-template-columns: 150px 1fr; gap: var(--spacing-sm); width: 100%; align-items: baseline;
  padding: 5px 6px; border: 0; border-radius: var(--radius-sm); background: none; text-align: left; cursor: pointer;
}
.tf__row:hover, .tf__row:focus-visible { background: var(--bg-tertiary); }
.tf__row code { font: var(--font-size-sm) var(--font-mono); color: var(--accent); }
.tf__row span { font-size: var(--font-size-xs); color: var(--text-secondary); }
.tf__none, .tf__foot { margin: var(--spacing-xs); font-size: var(--font-size-xs); color: var(--text-dim); }
</style>
