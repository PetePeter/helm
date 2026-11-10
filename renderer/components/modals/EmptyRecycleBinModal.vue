<script setup lang="ts">
/**
 * Empty recycle bin confirmation modal.
 *
 * Emptying deletes every binned session and its artifacts with no way back, so
 * it is gated behind an explicit confirm. Two buttons: Cancel / Empty bin.
 * Gamepad D-pad toggles selection, A confirms, B cancels.
 */
import { ref } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';

const MODAL_ID = 'empty-recycle-bin-confirm';

defineProps<{
  visible: boolean;
  count: number;
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const dialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);
const buttons = [
  { id: 'cancel', label: 'Cancel' },
  { id: 'empty', label: 'Empty bin', variant: 'danger' },
] as const;

function handleButton(button: string): boolean {
  dialog.value?.syncSelectedIndex(selectedIndex.value);
  return dialog.value?.handleButton(button) ?? true;
}

function onAction(action: string): void {
  if (action === 'empty') emit('confirm');
}

defineExpose({ handleButton, selectedIndex });
</script>

<template>
  <ConfirmDialog
    ref="dialog"
    :visible="visible"
    :modal-id="MODAL_ID"
    title="Empty Recycle Bin"
    aria-label="Empty recycle bin confirmation"
    :buttons="buttons"
    :auto-close="false"
    v-model:selected-index="selectedIndex"
    cancel-action-id="cancel"
    @action="onAction"
    @cancel="emit('cancel')"
    @update:visible="emit('update:visible', $event)"
  >
    <div id="emptyRecycleBinBody">
      <div>
        Permanently delete <strong>{{ count }}</strong> closed
        session{{ count === 1 ? '' : 's' }} and their artifacts?
      </div>
      <div class="modal-warning">This cannot be undone.</div>
    </div>
  </ConfirmDialog>
</template>
