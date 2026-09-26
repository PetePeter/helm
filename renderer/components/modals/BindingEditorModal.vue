<script setup lang="ts">
/**
 * Binding editor modal — complex form for editing gamepad button bindings.
 *
 * Action types: keyboard, voice, scroll, context-menu, prompt-tree, new-draft.
 * Each action type renders different parameter fields.
 */
import { ref, watch, computed } from 'vue';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import { getCliDisplayName } from '../../utils.js';
import PromptTextarea from '../common/PromptTextarea.vue';

const MODAL_ID = 'binding-editor';

const ACTION_TYPES = [
  { value: 'keyboard', label: 'Keyboard sequence' },
  { value: 'voice', label: 'Voice key' },
  { value: 'voice-talk', label: 'Talk to Helm (hold)' },
  { value: 'voice-call', label: 'Call Helm (hands-free)' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'context-menu', label: 'Context menu' },
  { value: 'prompt-tree', label: 'Prompt tree' },
  { value: 'new-draft', label: 'New draft' },
] as const;

interface Binding {
  action: string;
  sequence?: string;
  key?: string;
  mode?: string;
  target?: string;
  direction?: string;
  lines?: number;
}

const props = defineProps<{
  visible: boolean;
  buttonName: string;
  cliType: string;
  binding: Binding | null;
}>();

const emit = defineEmits<{
  (e: 'save', binding: Binding): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const actionType = ref('keyboard');
const sequence = ref('');
const voiceKey = ref('');
const voiceMode = ref('tap');
const voiceTarget = ref('');
const scrollDirection = ref('up');
const scrollLines = ref(5);
const modalStack = useModalStack();
const overlayRef = ref<HTMLElement | null>(null);
const { onKeydown } = useFocusTrap(overlayRef);

watch(() => props.visible, (v) => {
  if (v) {
    // Populate from existing binding
    const b = props.binding;
    actionType.value = b?.action ?? 'keyboard';
    sequence.value = b?.sequence ?? '';
    voiceKey.value = b?.key ?? '';
    voiceMode.value = b?.mode ?? 'tap';
    voiceTarget.value = b?.target ?? '';
    scrollDirection.value = b?.direction ?? 'up';
    scrollLines.value = b?.lines ?? 5;
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: FORM_KEYS });
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function handleButton(button: string): boolean {
  if (button === 'A') {
    onSave();
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  return true; // swallow
}

function onSave(): void {
  const binding: Binding = { action: actionType.value };
  switch (actionType.value) {
    case 'keyboard':
      binding.sequence = sequence.value;
      break;
    case 'voice':
      binding.key = voiceKey.value;
      binding.mode = voiceMode.value;
      if (voiceTarget.value) binding.target = voiceTarget.value;
      break;
    case 'scroll':
      binding.direction = scrollDirection.value;
      binding.lines = scrollLines.value;
      break;
  }
  emit('save', binding);
  emit('update:visible', false);
}

function onCancel(): void {
  emit('cancel');
  emit('update:visible', false);
}

const title = computed(() =>
  `${props.buttonName} — ${getCliDisplayName(props.cliType)}`,
);

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Edit binding"
      @keydown="onKeydown"
    >
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">{{ title }}</h3>
        </div>
        <div class="modal-body" id="bindingEditorForm">
          <!-- Button name (read-only) -->
          <div class="binding-editor-field">
            <label>Button</label>
            <input type="text" :value="buttonName" readonly class="form-input" />
          </div>

          <!-- Action type -->
          <div class="binding-editor-field">
            <label for="be-action">Action</label>
            <select id="be-action" v-model="actionType" class="form-select">
              <option v-for="at in ACTION_TYPES" :key="at.value" :value="at.value">
                {{ at.label }}
              </option>
            </select>
          </div>

          <!-- Keyboard params -->
          <template v-if="actionType === 'keyboard'">
            <div class="binding-editor-field">
              <PromptTextarea
                id="be-sequence"
                v-model="sequence"
                label="Sequence"
                placeholder="{Send}, text, {Ctrl+C}"
                :rows="3"
              />
            </div>
          </template>

          <!-- Voice params -->
          <template v-if="actionType === 'voice'">
            <div class="binding-editor-field">
              <label for="be-key">Key</label>
              <input id="be-key" v-model="voiceKey" type="text" placeholder="F1" class="form-input" />
            </div>
            <div class="binding-editor-field">
              <label for="be-mode">Mode</label>
              <select id="be-mode" v-model="voiceMode" class="form-select">
                <option value="tap">Tap</option>
                <option value="hold">Hold</option>
              </select>
            </div>
            <div class="binding-editor-field">
              <label for="be-target">Target</label>
              <select id="be-target" v-model="voiceTarget" class="form-select">
                <option value="">OS (default)</option>
                <option value="terminal">Terminal (PTY)</option>
              </select>
            </div>
          </template>

          <!-- Scroll params -->
          <template v-if="actionType === 'scroll'">
            <div class="binding-editor-field">
              <label for="be-direction">Direction</label>
              <select id="be-direction" v-model="scrollDirection" class="form-select">
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </div>
            <div class="binding-editor-field">
              <label for="be-lines">Lines</label>
              <input id="be-lines" v-model.number="scrollLines" type="number" min="1" max="50" class="form-input" />
            </div>
          </template>

          <!-- Context menu / prompt-tree / new-draft / voice-talk / voice-call — no extra params -->
          <template v-if="actionType === 'context-menu' || actionType === 'prompt-tree' || actionType === 'new-draft' || actionType === 'voice-talk' || actionType === 'voice-call'">
            <div class="binding-editor-field">
              <span class="form-help">No additional parameters needed.</span>
            </div>
          </template>
        </div>

        <div class="modal-footer">
          <button class="btn" @click="onCancel">Cancel</button>
          <button class="btn btn--primary" @click="onSave">Save</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
