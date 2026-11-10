<script setup lang="ts">
/**
 * Generic confirmation dialog with shared modal-stack and gamepad handling.
 */
import { ref, watch } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';

export interface ConfirmDialogButton {
  id: string;
  label: string;
  variant?: 'default' | 'primary' | 'secondary' | 'danger' | 'ghost';
}

const props = withDefaults(defineProps<{
  visible: boolean;
  modalId: string;
  title: string;
  ariaLabel: string;
  buttons: readonly ConfirmDialogButton[];
  selectedIndex?: number;
  cancelActionId?: string;
  autoClose?: boolean;
  directionMode?: 'horizontal' | 'any';
  modalClass?: string;
}>(), {
  cancelActionId: undefined,
  autoClose: true,
  directionMode: 'any',
  modalClass: 'close-confirm-modal',
  selectedIndex: 0,
});

const emit = defineEmits<{
  (e: 'action', actionId: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
  (e: 'update:selectedIndex', value: number): void;
}>();

const modalStack = useModalStack();
const internalSelectedIndex = ref(props.selectedIndex);

watch(() => props.visible, (v) => {
  if (v) {
    syncSelectedIndex(0);
    modalStack.push({ id: props.modalId, handler: handleButton, interceptKeys: SELECTION_KEYS });
  } else {
    modalStack.pop(props.modalId);
  }
}, { immediate: true });

watch(() => props.selectedIndex, (index) => {
  internalSelectedIndex.value = clampIndex(index);
});

function clampIndex(index: number): number {
  if (props.buttons.length === 0) return 0;
  return (index + props.buttons.length) % props.buttons.length;
}

function syncSelectedIndex(index: number): void {
  const clamped = clampIndex(index);
  internalSelectedIndex.value = clamped;
  emit('update:selectedIndex', clamped);
}

function moveSelection(delta: number): void {
  syncSelectedIndex(internalSelectedIndex.value + delta);
}

function close(): void {
  emit('update:visible', false);
}

function actionForIndex(index: number): string | undefined {
  return props.buttons[clampIndex(index)]?.id;
}

function selectAction(actionId: string): void {
  if (actionId === props.cancelActionId) {
    emit('cancel');
    close();
  } else {
    emit('action', actionId);
    if (props.autoClose) close();
  }
}

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (dir && (props.directionMode === 'any' || dir === 'left' || dir === 'right')) {
    moveSelection(dir === 'left' || dir === 'up' ? -1 : 1);
    return true;
  }
  if (button === 'Tab' || button === 'ShiftTab') {
    moveSelection(button === 'ShiftTab' ? -1 : 1);
    return true;
  }
  if (button === 'A') {
    const actionId = actionForIndex(internalSelectedIndex.value);
    if (actionId) selectAction(actionId);
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    close();
    return true;
  }
  return true;
}

function onButtonClick(actionId: string): void {
  selectAction(actionId);
}

function buttonClass(button: ConfirmDialogButton, index: number): Record<string, boolean> {
  return {
    'btn--focused': internalSelectedIndex.value === index,
    'btn--primary': button.variant === 'primary',
    'btn--secondary': button.variant === 'secondary',
    'btn--danger': button.variant === 'danger',
    'btn--ghost': button.variant === 'ghost',
  };
}

function suppressActivationKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
  }
}

defineExpose({ handleButton, syncSelectedIndex, selectedIndex: internalSelectedIndex });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible"
      role="dialog"
      :aria-label="ariaLabel"
    >
      <div class="modal" :class="modalClass">
        <div class="modal-header">
          <h3 class="modal-title">{{ title }}</h3>
        </div>
        <slot />
        <div class="modal-footer">
          <button
            v-for="(button, index) in buttons"
            :key="button.id"
            class="btn"
            :class="buttonClass(button, index)"
            tabindex="-1"
            @keydown="suppressActivationKey"
            @click="onButtonClick(button.id)"
          >{{ button.label }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.close-confirm-modal {
  max-width: 320px;
  text-align: center;
}

.close-confirm-modal .modal-footer {
  gap: 12px;
}
</style>
