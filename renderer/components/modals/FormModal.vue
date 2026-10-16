<script setup lang="ts">
import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from '../../ipc/clients.js';
/**
 * Dynamic form modal — renders form fields from a descriptor array.
 *
 * Supports text, select, textarea, and checkbox field types.
 * Browse button integration for directory fields.
 * Gamepad: Escape/B cancels, Enter/Ctrl+Enter saves.
 */
import { nextTick, ref, watch } from 'vue';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import { getRequiredFormFieldError } from '../../utils.js';
import PromptTextarea from '../common/PromptTextarea.vue';

export interface FormField {
  key: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  type?: 'text' | 'select' | 'textarea' | 'checkbox';
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
  browse?: boolean;
  showLabels?: boolean;
}

const MODAL_ID = 'form-modal';

const props = defineProps<{
  visible: boolean;
  title: string;
  fields: FormField[];
}>();

const emit = defineEmits<{
  (e: 'save', values: Record<string, string>): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const formValues = ref<Record<string, string>>({});
const modalStack = useModalStack();
const overlayRef = ref<HTMLElement | null>(null);
const validationErrors = ref<Record<string, string>>({});
const { onKeydown } = useFocusTrap(overlayRef);

watch(() => props.visible, (v) => {
  if (v) {
    // Initialize form values from defaults
    const vals: Record<string, string> = {};
    for (const field of props.fields) {
      vals[field.key] = field.defaultValue ?? '';
    }
    formValues.value = vals;
    validationErrors.value = {};
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: new Set([...FORM_KEYS, 'enter']) });
  } else {
    validationErrors.value = {};
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function handleButton(button: string): boolean {
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  if (button === 'A') {
    onSave();
    return true;
  }
  return true; // swallow
}

function onSave(): void {
  if (!validateForm()) return;
  emit('save', { ...formValues.value });
  emit('update:visible', false);
}

function onCancel(): void {
  emit('cancel');
  emit('update:visible', false);
}

async function onBrowse(fieldKey: string): Promise<void> {
  const path = await dialogClient.dialogOpenFolder?.();
  if (path) {
    formValues.value[fieldKey] = path;
    revalidateFieldByKey(fieldKey);
    // Also set name field if it exists and is empty
    if (formValues.value['name'] === '' || formValues.value['name'] === undefined) {
      const parts = path.replace(/\\/g, '/').split('/');
      formValues.value['name'] = parts[parts.length - 1] || '';
      revalidateFieldByKey('name');
    }
  }
}

function getFieldByKey(fieldKey: string): FormField | undefined {
  return props.fields.find(field => field.key === fieldKey);
}

function getFieldErrorId(fieldKey: string): string {
  return `form-${fieldKey}-error`;
}

function setFieldValue(fieldKey: string, value: string): void {
  formValues.value[fieldKey] = value;
  revalidateFieldByKey(fieldKey);
}

function getFieldError(field: FormField): string | null {
  return getRequiredFormFieldError(field, formValues.value[field.key]);
}

function revalidateField(field: FormField): void {
  const error = getFieldError(field);
  if (error) {
    validationErrors.value[field.key] = error;
    return;
  }
  delete validationErrors.value[field.key];
}

function revalidateFieldByKey(fieldKey: string): void {
  const field = getFieldByKey(fieldKey);
  if (field) revalidateField(field);
}

function focusFirstInvalidField(): void {
  const firstInvalidField = props.fields.find(field => validationErrors.value[field.key]);
  if (!firstInvalidField) return;

  nextTick(() => {
    const el = document.getElementById(`form-${firstInvalidField.key}`) as HTMLElement | null;
    el?.focus();
  });
}

function validateForm(): boolean {
  const nextErrors: Record<string, string> = {};

  for (const field of props.fields) {
    const error = getFieldError(field);
    if (error) nextErrors[field.key] = error;
  }

  validationErrors.value = nextErrors;
  if (Object.keys(nextErrors).length > 0) {
    focusFirstInvalidField();
    return false;
  }

  return true;
}

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Form"
      @keydown="onKeydown"
    >
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">{{ title }}</h3>
        </div>
        <div class="modal-body" id="formModalFields">
          <div v-for="field in fields" :key="field.key" class="binding-editor-field">
            <label :for="`form-${field.key}`">
              {{ field.label }}
              <span v-if="field.required" aria-hidden="true" style="color: #c33;"> *</span>
            </label>

            <!-- Text input -->
            <div v-if="!field.type || field.type === 'text'" class="form-field-row">
              <input
                :id="`form-${field.key}`"
                :value="formValues[field.key]"
                type="text"
                :placeholder="field.placeholder"
                class="form-input"
                :aria-invalid="validationErrors[field.key] ? 'true' : undefined"
                :aria-describedby="validationErrors[field.key] ? getFieldErrorId(field.key) : undefined"
                @input="setFieldValue(field.key, ($event.target as HTMLInputElement).value)"
              />
              <button v-if="field.browse" class="btn btn--sm" @click="onBrowse(field.key)">📁</button>
            </div>

            <!-- Select -->
            <select
              v-else-if="field.type === 'select'"
              :id="`form-${field.key}`"
              :value="formValues[field.key]"
              class="form-select"
              :aria-invalid="validationErrors[field.key] ? 'true' : undefined"
              :aria-describedby="validationErrors[field.key] ? getFieldErrorId(field.key) : undefined"
              @change="setFieldValue(field.key, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>

            <!-- Textarea -->
            <PromptTextarea
              v-else-if="field.type === 'textarea'"
              :id="`form-${field.key}`"
              :model-value="formValues[field.key]"
              :label="undefined"
              :placeholder="field.placeholder"
              :rows="4"
              :min-rows="3"
              :max-rows="12"
              textarea-class="form-textarea"
              @update:model-value="setFieldValue(field.key, $event)"
            />

            <!-- Checkbox -->
            <label v-else-if="field.type === 'checkbox'" class="form-checkbox">
              <input
                :id="`form-${field.key}`"
                type="checkbox"
                :checked="formValues[field.key] === 'true'"
                :aria-invalid="validationErrors[field.key] ? 'true' : undefined"
                :aria-describedby="validationErrors[field.key] ? getFieldErrorId(field.key) : undefined"
                @change="setFieldValue(field.key, ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
              />
              {{ field.label }}
            </label>

            <p
              v-if="validationErrors[field.key]"
              :id="getFieldErrorId(field.key)"
              role="alert"
              style="color: #c33; font-size: 12px; margin: 4px 0 0;"
            >{{ validationErrors[field.key] }}</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="onCancel">Cancel</button>
          <button class="btn btn--primary" @click="onSave">Save</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.form-field-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.form-field-row .form-input {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}
</style>
