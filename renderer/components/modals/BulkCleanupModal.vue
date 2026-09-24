<script setup lang="ts">
/**
 * Bulk cleanup confirmation modal.
 *
 * Confirms a bulk deletion in a project — completed plans, empty sequences,
 * unreferenced contexts, or several at once — listing each count first.
 * Two buttons: Cancel / Clear. Gamepad D-pad toggles selection, A confirms, B cancels.
 */
import { ref } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';

const MODAL_ID = 'bulk-cleanup-confirm';

export interface CleanupLine {
  count: number;
  /** Singular noun, e.g. "completed plan". */
  noun: string;
}

defineProps<{
  visible: boolean;
  title: string;
  lines: CleanupLine[];
  dirName: string;
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
  { id: 'clear', label: 'Clear', variant: 'danger' },
] as const;

function handleButton(button: string): boolean {
  dialog.value?.syncSelectedIndex(selectedIndex.value);
  return dialog.value?.handleButton(button) ?? true;
}

function onAction(action: string): void {
  if (action === 'clear') emit('confirm');
}

defineExpose({ handleButton, selectedIndex });
</script>

<template>
  <ConfirmDialog
    ref="dialog"
    :visible="visible"
    :modal-id="MODAL_ID"
    :title="title"
    :aria-label="title"
    :buttons="buttons"
    v-model:selected-index="selectedIndex"
    cancel-action-id="cancel"
    @action="onAction"
    @cancel="emit('cancel')"
    @update:visible="emit('update:visible', $event)"
  >
    <div id="bulkCleanupBody">
      <div>In <strong>{{ dirName }}</strong>, clear:</div>
      <ul class="bulk-cleanup__lines">
        <li v-for="line in lines" :key="line.noun">
          <strong>{{ line.count }}</strong> {{ line.noun }}{{ line.count === 1 ? '' : 's' }}
        </li>
      </ul>
      <div class="modal-warning">This cannot be undone.</div>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.bulk-cleanup__lines {
  margin: 6px 0;
  padding-left: 18px;
}
</style>
