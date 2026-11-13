<script setup lang="ts">
/**
 * One command/action template field of the Tool editor: the input, a
 * "placeholder help" chip listing every {placeholder} this field fills (and the
 * sequence keys, for sequence fields), and a red warning for unknown {tokens}.
 * The list is src/config/template-placeholders.ts — the same one Helm fills from.
 */
import { computed, ref } from 'vue';
import {
  FIELD_PLACEHOLDERS,
  SEQUENCE_FIELDS,
  unknownPlaceholders,
  type TemplateField,
} from '../../../../src/config/template-placeholders.js';
import PlaceholderHelp from '../../common/PlaceholderHelp.vue';

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
</script>

<template>
  <div class="tf">
    <div class="tf__label-row">
      <label :for="inputId" class="tf__label">{{ label }} <span v-if="note" class="tf__note">{{ note }}</span></label>
      <PlaceholderHelp :placeholders="placeholders" :sequence-keys="isSequence" :label="label" @insert="insert" />
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
.tf__input--bad { border-color: var(--danger-border); }
.tf__warn { margin: var(--spacing-xs) 0 0; font-size: var(--font-size-xs); color: var(--danger); }
</style>
