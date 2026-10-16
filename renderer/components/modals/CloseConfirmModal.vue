<script setup lang="ts">
/**
 * Close session confirmation modal.
 *
 * Shows session name + optional draft warning. Two buttons: Cancel / Close.
 * Gamepad D-pad left/right toggles selection, A confirms, B cancels.
 */
import { ref, computed } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';

const MODAL_ID = 'close-confirm';

const props = defineProps<{
  visible: boolean;
  /** Session name, or the folder name in folder mode. */
  sessionName: string;
  /** Sessions about to close together (folder mode). */
  count?: number;
  mode?: 'session' | 'app' | 'folder';
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const isAppClose = computed(() => props.mode === 'app');
const isFolderClose = computed(() => props.mode === 'folder');
const sessionCount = computed(() => props.count ?? 0);

const title = computed(() => {
  if (isAppClose.value) return 'Close Helm';
  return isFolderClose.value ? 'Close Folder Sessions' : 'Close Session';
});
const ariaLabel = computed(() => {
  if (isAppClose.value) return 'Close Helm confirmation';
  return isFolderClose.value ? 'Close folder sessions confirmation' : 'Close session confirmation';
});
const prompt = computed(() => {
  if (isAppClose.value) return 'Close Helm?';
  if (isFolderClose.value) {
    const noun = sessionCount.value === 1 ? 'session' : 'sessions';
    return `Close all ${sessionCount.value} ${noun} in ${props.sessionName}?`;
  }
  return `Close session ${props.sessionName}?`;
});

const selectedIndex = ref(0);
const confirmLabel = computed(() => {
  if (isAppClose.value) return 'Close Helm';
  return isFolderClose.value ? 'Close all' : 'Close';
});
const buttons = computed(() => [
  { id: 'cancel', label: 'Cancel' },
  { id: 'close', label: confirmLabel.value, variant: 'danger' },
] as const);

function handleButton(button: string): boolean {
  dialog.value?.syncSelectedIndex(selectedIndex.value);
  return dialog.value?.handleButton(button) ?? true;
}

const dialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);

function onAction(action: string): void {
  if (action === 'close') emit('confirm');
}

defineExpose({ handleButton, selectedIndex });
</script>

<template>
  <ConfirmDialog
    ref="dialog"
    :visible="visible"
    :modal-id="MODAL_ID"
    :title="title"
    :aria-label="ariaLabel"
    :buttons="buttons"
    v-model:selected-index="selectedIndex"
    cancel-action-id="cancel"
    direction-mode="horizontal"
    @action="onAction"
    @cancel="emit('cancel')"
    @update:visible="emit('update:visible', $event)"
  >
    <div id="closeConfirmBody">
      <div>
        <template v-if="mode === 'app'">{{ prompt }}</template>
        <template v-else-if="isFolderClose">
          Close all <strong>{{ sessionCount }}</strong>
          session{{ sessionCount === 1 ? '' : 's' }} in <strong>{{ sessionName }}</strong>?
        </template>
        <template v-else>Close session <strong>{{ sessionName }}</strong>?</template>
      </div>
    </div>
  </ConfirmDialog>
</template>
