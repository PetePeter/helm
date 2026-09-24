<script setup lang="ts">
import { useEditorPopupStore } from '../../stores/editor-popup.js';
import {
  closeConfirm, getCloseConfirmCallback, setCloseConfirmCallback,
  getCloseConfirmCancelCallback, setCloseConfirmCancelCallback,
  contextMenu,
  planDeleteConfirm, getPlanDeleteCallback, setPlanDeleteCallback,
  bulkCleanup, getBulkCleanupCallback,
  promptTree, getPromptTreeCallback, hidePromptTree,
  quickSpawn, getQuickSpawnCallback, closeQuickSpawn,
  dirPicker, closeDirPicker,
  draftSubmenu,
  formModal, getFormModalResolve,
  toolEditor, getToolEditorCallback,
  planHelp, hidePlanHelpModal,
  runtimeGroupName, getRuntimeGroupNameCallback, closeRuntimeGroupNameModal,
  runtimeGroupClose, getRuntimeGroupCloseCallback, closeRuntimeGroupCloseModal,
  runtimeGroupMove, closeRuntimeGroupMoveSubmenu,
} from '../../stores/modal-bridge.js';
import { useRuntimeGroupActions } from '../../composables/useRuntimeGroupActions.js';
import type { ScheduledTask, ScheduledTaskHistoryEntry } from '../../../src/types/scheduled-task.js';
import CloseConfirmModal from '../modals/CloseConfirmModal.vue';
import PlanDeleteConfirmModal from '../modals/PlanDeleteConfirmModal.vue';
import PromptTreeModal from '../modals/PromptTreeModal.vue';
import QuickSpawnModal from '../modals/QuickSpawnModal.vue';
import ContextMenu from '../modals/ContextMenu.vue';
import DraftSubmenu from '../modals/DraftSubmenu.vue';
import DirPickerModal from '../modals/DirPickerModal.vue';
import FormModal from '../modals/FormModal.vue';
import ToolEditorModal from '../modals/ToolEditorModal.vue';
import EditorPopup from '../modals/EditorPopup.vue';
import BindingEditorModal from '../modals/BindingEditorModal.vue';
import EscProtectionModal from '../modals/EscProtectionModal.vue';
import PlanHelpModal from '../modals/PlanHelpModal.vue';
import BulkCleanupModal from '../modals/BulkCleanupModal.vue';
import RuntimeGroupNameModal from '../modals/RuntimeGroupNameModal.vue';
import RuntimeGroupCloseDialog from '../modals/RuntimeGroupCloseDialog.vue';
import RuntimeGroupMoveSubmenu from '../modals/RuntimeGroupMoveSubmenu.vue';
import ScheduledTasksTab from '../sidebar/ScheduledTasksTab.vue';
import ToastNotification from '../ToastNotification.vue';

defineProps<{
  cliTypes: string[];
  hasActiveSession: boolean;
  hasSequences: boolean;
  hasDrafts: boolean;
  isActiveSessionSnappedOut: boolean;
  contextMenuGroupName?: string | null;
  bindingEditorVisible: boolean;
  bindingEditorButton: string;
  bindingEditorCliType: string;
  bindingEditorBinding: any;
  schedulerPopupVisible: boolean;
  schedulerPopupTaskId: string | null;
  schedulerPopupPrefill?: Partial<ScheduledTaskHistoryEntry> | null;
}>();

const emit = defineEmits<{
  'close-session': [sessionId: string];
  'context-menu-action': [action: string];
  'draft-new-draft': [];
  'draft-apply': [draft: { id: string; text: string }];
  'draft-edit': [draft: { id: string; label: string; text: string }];
  'draft-delete': [draft: { id: string }];
  'dir-select': [path: string, cliType: string];
  'update:bindingEditorVisible': [visible: boolean];
  'binding-save': [binding: any];
  'update:schedulerPopupVisible': [visible: boolean];
  'task-created': [task: ScheduledTask];
  'task-updated': [task: ScheduledTask];
  'task-cancelled': [taskId: string];
}>();

const editorPopupStore = useEditorPopupStore();

function onCancelClose(): void {
  closeConfirm.visible = false;
  closeConfirm.mode = 'session';
  getCloseConfirmCancelCallback()?.();
  setCloseConfirmCallback(null);
  setCloseConfirmCancelCallback(null);
}

function onConfirmClose(): void {
  closeConfirm.visible = false;
  const cb = getCloseConfirmCallback();
  if (cb) {
    cb(closeConfirm.sessionId);
  } else {
    emit('close-session', closeConfirm.sessionId);
  }
  closeConfirm.mode = 'session';
  setCloseConfirmCallback(null);
  setCloseConfirmCancelCallback(null);
}

function onPlanDeleteConfirm(): void {
  planDeleteConfirm.visible = false;
  const cb = getPlanDeleteCallback();
  setPlanDeleteCallback(null);
  cb?.();
}

function onPlanDeleteCancel(): void {
  planDeleteConfirm.visible = false;
  setPlanDeleteCallback(null);
}

function onBulkCleanupConfirm(): void {
  bulkCleanup.visible = false;
  getBulkCleanupCallback()?.();
}



function onPromptTreeSelect(templateId: string): void {
  // Capture the callback BEFORE hiding — hidePromptTree() clears the stored
  // callback, so reading it afterwards would lose the caller's onSelect.
  const cb = getPromptTreeCallback();
  hidePromptTree();
  cb?.(templateId);
}

function onQuickSpawnSelect(cliType: string): void {
  const cb = getQuickSpawnCallback();
  closeQuickSpawn();
  cb?.(cliType);
}

function onDirPickerSelect(path: string): void {
  const cliType = dirPicker.cliType;
  closeDirPicker();
  emit('dir-select', path, cliType);
}

function onFormModalSave(values: Record<string, string>): void {
  formModal.visible = false;
  getFormModalResolve()?.(values);
}

function onFormModalCancel(): void {
  formModal.visible = false;
  getFormModalResolve()?.(null);
}

function onToolEditorSave(values: any): void {
  toolEditor.visible = false;
  getToolEditorCallback()?.(values);
}

function onRuntimeGroupNameSubmit(name: string): void {
  const cb = getRuntimeGroupNameCallback();
  closeRuntimeGroupNameModal();
  cb?.(name);
}

function onRuntimeGroupNameCancel(): void {
  closeRuntimeGroupNameModal();
}

function onRuntimeGroupCloseConfirm(mode: 'keep' | 'closeAll'): void {
  const cb = getRuntimeGroupCloseCallback();
  closeRuntimeGroupCloseModal();
  cb?.(mode);
}

function onRuntimeGroupCloseCancel(): void {
  closeRuntimeGroupCloseModal();
}

const runtimeGroupActions = useRuntimeGroupActions();

function onRuntimeGroupMovePick(groupId: string): void {
  const sessionId = runtimeGroupMove.sessionId;
  closeRuntimeGroupMoveSubmenu();
  if (sessionId) void runtimeGroupActions.moveToGroup(groupId, sessionId);
}

function onRuntimeGroupMoveNewGroup(): void {
  const sessionId = runtimeGroupMove.sessionId;
  closeRuntimeGroupMoveSubmenu();
  if (sessionId) runtimeGroupActions.promptCreate(sessionId);
}

function onRuntimeGroupMoveCancel(): void {
  closeRuntimeGroupMoveSubmenu();
}
</script>

<template>
  <CloseConfirmModal
    v-model:visible="closeConfirm.visible"
    :session-name="closeConfirm.sessionName"
    :draft-count="closeConfirm.draftCount"
    :count="closeConfirm.count"
    :mode="closeConfirm.mode"
    @confirm="onConfirmClose"
    @cancel="onCancelClose"
  />

  <PlanDeleteConfirmModal
    v-model:visible="planDeleteConfirm.visible"
    :plan-title="planDeleteConfirm.planTitle"
    :item-kind="planDeleteConfirm.itemKind"
    :title="planDeleteConfirm.title"
    :message="planDeleteConfirm.message"
    :confirm-label="planDeleteConfirm.confirmLabel"
    @confirm="onPlanDeleteConfirm"
    @cancel="onPlanDeleteCancel"
  />

  <BulkCleanupModal
    v-model:visible="bulkCleanup.visible"
    :title="bulkCleanup.title"
    :lines="bulkCleanup.lines"
    :dir-name="bulkCleanup.dirName"
    @confirm="onBulkCleanupConfirm"
    @cancel="bulkCleanup.visible = false"
  />

  <PromptTreeModal
    v-model:visible="promptTree.visible"
    :tree="promptTree.tree"
    @select="onPromptTreeSelect"
    @cancel="hidePromptTree()"
  />

  <QuickSpawnModal
    v-model:visible="quickSpawn.visible"
    :cli-types="cliTypes"
    :preselected-cli-type="quickSpawn.preselectedCliType"
    @select="onQuickSpawnSelect"
    @cancel="closeQuickSpawn()"
  />

  <ContextMenu
    v-model:visible="contextMenu.visible"
    :has-selection="contextMenu.hasSelection"
    :has-active-session="hasActiveSession"
    :has-sequences="hasSequences"
    :has-drafts="hasDrafts"
    :is-snapped-out="isActiveSessionSnappedOut"
    :current-group-name="contextMenuGroupName ?? null"
    @action="emit('context-menu-action', $event)"
    @cancel="contextMenu.visible = false"
  />

  <DraftSubmenu
    v-model:visible="draftSubmenu.visible"
    :drafts="draftSubmenu.items"
    @new-draft="emit('draft-new-draft')"
    @apply="emit('draft-apply', $event)"
    @edit="emit('draft-edit', $event)"
    @delete="emit('draft-delete', $event)"
    @cancel="draftSubmenu.visible = false"
  />

  <DirPickerModal
    v-model:visible="dirPicker.visible"
    :cli-type="dirPicker.cliType"
    :items="dirPicker.items"
    :preselected-path="dirPicker.preselectedPath"
    @select="onDirPickerSelect"
    @cancel="closeDirPicker()"
  />

  <FormModal
    v-model:visible="formModal.visible"
    :title="formModal.title"
    :fields="formModal.fields"
    @save="onFormModalSave"
    @cancel="onFormModalCancel"
  />

  <ToolEditorModal
    v-model:visible="toolEditor.visible"
    :mode="toolEditor.mode"
    :edit-key="toolEditor.editKey"
    :initial-data="toolEditor.initialData"
    :validate-name="toolEditor.validateName ?? undefined"
    @save="onToolEditorSave"
    @cancel="toolEditor.visible = false"
  />

  <EditorPopup
    :visible="editorPopupStore.visible"
    :initial-text="editorPopupStore.initialText"
    :has-prefill="editorPopupStore.hasPrefill"
    :select-node-id="editorPopupStore.selectNodeId"
    @update:visible="editorPopupStore.setVisible"
    @send="editorPopupStore.handleSend"
    @close="editorPopupStore.handleClose"
  />

  <BindingEditorModal
    :visible="bindingEditorVisible"
    :button-name="bindingEditorButton"
    :cli-type="bindingEditorCliType"
    :binding="bindingEditorBinding"
    @update:visible="emit('update:bindingEditorVisible', $event)"
    @save="emit('binding-save', $event)"
    @cancel="emit('update:bindingEditorVisible', false)"
  />

  <RuntimeGroupNameModal
    :visible="runtimeGroupName.visible"
    :mode="runtimeGroupName.mode"
    :initial-name="runtimeGroupName.initialName"
    @submit="onRuntimeGroupNameSubmit"
    @cancel="onRuntimeGroupNameCancel"
    @update:visible="runtimeGroupName.visible = $event"
  />

  <RuntimeGroupCloseDialog
    :visible="runtimeGroupClose.visible"
    :group-name="runtimeGroupClose.groupName"
    :member-count="runtimeGroupClose.memberCount"
    @confirm="onRuntimeGroupCloseConfirm"
    @cancel="onRuntimeGroupCloseCancel"
    @update:visible="runtimeGroupClose.visible = $event"
  />

  <RuntimeGroupMoveSubmenu
    :visible="runtimeGroupMove.visible"
    :current-group-id="runtimeGroupMove.currentGroupId"
    :groups="runtimeGroupMove.groups"
    @pick="onRuntimeGroupMovePick"
    @new-group="onRuntimeGroupMoveNewGroup"
    @cancel="onRuntimeGroupMoveCancel"
    @update:visible="runtimeGroupMove.visible = $event"
  />

  <EscProtectionModal />

  <PlanHelpModal v-if="planHelp.visible" @dismiss="hidePlanHelpModal()" />

  <div
    v-if="schedulerPopupVisible"
    class="scheduler-popup-backdrop"
    @click.self="emit('update:schedulerPopupVisible', false)"
  >
    <div class="scheduler-popup">
      <ScheduledTasksTab
        popup
        :initial-create="schedulerPopupTaskId === null"
        :initial-edit-task-id="schedulerPopupTaskId"
        :initial-prefill="schedulerPopupPrefill ?? null"
        @task-created="emit('task-created', $event)"
        @task-updated="emit('task-updated', $event)"
        @task-cancelled="emit('task-cancelled', $event)"
        @close="emit('update:schedulerPopupVisible', false)"
      />
    </div>
  </div>

  <ToastNotification />
</template>

<style scoped>
.scheduler-popup-backdrop {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}

.scheduler-popup {
  width: min(760px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
}
</style>
