<script setup lang="ts">
/**
 * ItemEditor.vue — Slide-down editor panel for plan items and contexts.
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { PlanStatus } from '../../src/types/plan.js';
import type { PlanAttachment } from '../../src/types/plan-attachment.js';
import { formatDateTime } from '../../utils/date-format.js';
import { getDisplayTitle } from '../../types.js';
import PromptTextarea from '../common/PromptTextarea.vue';
import { attachmentsClient, configClient, dialogClient } from '../../ipc/clients.js';
import { copyPlanRef } from '../../composables/useCopyPlanRef.js';

type ContextBoundPlan = {
  id: string;
  title: string;
  humanId?: string;
  type?: 'bug' | 'feature' | 'research';
  status?: PlanStatus;
};

export interface PlanCallbacks {
  onSave: (updates: { title: string; description: string; status: PlanStatus; stateInfo?: string; type?: 'bug' | 'feature' | 'research'; autoImplement?: boolean; completionRecap?: boolean }) => void;
  onDelete: () => void;
  onDone?: () => void;
  onApply?: () => void;
  onClose?: () => void;
}

export interface ContextCallbacks {
  onSave: (updates: { title: string; content: string; type: string; permission: 'readonly' | 'writable' }) => void;
  onDelete: () => void;
  onUnbind?: (targetType: 'plan' | 'sequence', targetId: string) => void;
  onClose?: () => void;
}

export interface ItemEditorProps {
  visible: boolean;
  mode: 'plan' | 'context';
  sessionId: string;
  initialLabel?: string;
  initialText?: string;
  planId?: string | null;
  planStatus?: PlanStatus;
  planStateInfo?: string;
  planHumanId?: string;
  planCreatedAt?: number | null;
  planStateUpdatedAt?: number | null;
  planType?: 'bug' | 'feature' | 'research';
  planAutoImplement?: boolean;
  planCompletionRecap?: boolean;
  planCallbacks?: PlanCallbacks | null;
  contextId?: string | null;
  contextType?: string;
  contextPermission?: 'readonly' | 'writable';
  contextCallbacks?: ContextCallbacks | null;
  contextBoundPlans?: ContextBoundPlan[];
  contextBoundSequences?: Array<{ id: string; title: string }>;
  contextPendingUnbindCount?: number;
  completionNotes?: string;
}

const props = withDefaults(defineProps<ItemEditorProps>(), {
  initialLabel: '',
  initialText: '',
  planId: null,
  planStatus: 'planning',
  planStateInfo: '',
  planHumanId: '',
  planCreatedAt: null,
  planStateUpdatedAt: null,
  planType: undefined,
  planAutoImplement: false,
  planCompletionRecap: false,
  planCallbacks: null,
  contextId: null,
  contextType: 'Knowledge',
  contextPermission: 'readonly',
  contextCallbacks: null,
  contextBoundPlans: undefined,
  contextBoundSequences: undefined,
  contextPendingUnbindCount: 0,
  completionNotes: '',
});

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  close: [];
  'plan-save': [updates: { title: string; description: string; status: PlanStatus; stateInfo?: string; type?: 'bug' | 'feature' | 'research'; autoImplement?: boolean; completionRecap?: boolean }];
  'plan-apply': [];
  'plan-done': [];
  'plan-delete': [];
  'context-save': [updates: { title: string; content: string; type: string; permission: 'readonly' | 'writable' }];
  'context-delete': [];
}>();

const label = ref(props.initialLabel);
const text = ref(props.initialText);
const status = ref<PlanStatus>(props.planStatus);
const stateInfo = ref(props.planStateInfo);
const type = ref<'bug' | 'feature' | 'research' | undefined>(props.planType);
const autoImplement = ref(Boolean(props.planAutoImplement));
const completionRecap = ref(false);
const saveStatus = ref<'clean' | 'unsaved' | 'saving' | 'saved'>('clean');
const autoSaveTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const focusIndex = ref(0);
const hydratingFromProps = ref(false);

const origLabel = ref(props.initialLabel);
const origText = ref(props.initialText);
const origStatus = ref<PlanStatus>(props.planStatus);
const origStateInfo = ref(props.planStateInfo);
const origType = ref<'bug' | 'feature' | 'research' | undefined>(props.planType);
const origAutoImplement = ref(Boolean(props.planAutoImplement));
const origCompletionRecap = ref(false);
const ctxType = ref(props.contextType);
const ctxPermission = ref<'readonly' | 'writable'>(props.contextPermission);
const origCtxType = ref(props.contextType);
const origCtxPermission = ref(props.contextPermission);
const ctxTypeInputRef = ref<HTMLInputElement | null>(null);
const ctxPermissionSelectRef = ref<HTMLSelectElement | null>(null);

const labelInputRef = ref<HTMLInputElement | null>(null);
const stateSelectRef = ref<HTMLSelectElement | null>(null);
const stateInfoRef = ref<HTMLInputElement | null>(null);
const typeSelectRef = ref<HTMLSelectElement | null>(null);
const autoImplementRef = ref<HTMLInputElement | null>(null);
const completionRecapRef = ref<HTMLInputElement | null>(null);
const bodyPromptRef = ref<InstanceType<typeof PromptTextarea> | null>(null);

const attachments = ref<PlanAttachment[]>([]);
const attachmentsLoading = ref(false);
const attachmentBusyId = ref<string | null>(null);
const attachmentError = ref('');

const heightDebounceTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const editorHeightKey = computed(() => isContext.value ? 'contextEditorHeight' : 'planEditorHeight');
// Plans and contexts are large content editors — let the body textarea grow up
// to 75% of the viewport when dragged.
const tallEditorMaxHeightPx = computed(() => Math.round(window.innerHeight * 0.75));

const isPlan = computed(() => props.mode === 'plan');
const isContext = computed(() => props.mode === 'context');
const hasContextBindings = computed(() =>
  isContext.value && ((props.contextBoundPlans?.length ?? 0) + (props.contextBoundSequences?.length ?? 0)) > 0,
);
const activePlanStatus = computed<PlanStatus>(() => (
  stateSelectRef.value?.disabled ? props.planStatus : status.value
));

const titleText = computed(() => {
  if (isContext.value) return 'Edit Context';
  const statusLabels: Record<string, string> = {
    planning: '⏸ Planning', ready: '▶ Ready', coding: '🔄 Coding', review: '⏳ Review', blocked: '⛔ Blocked', done: '✓ Done',
  };
  return `🗺️ Edit Plan · ${statusLabels[activePlanStatus.value] ?? activePlanStatus.value}`;
});

const showPlanStateSelect = computed(() => isPlan.value);
const showPlanStateInfo = computed(() => isPlan.value);
const requiresStateInfo = computed(() => isPlan.value && (status.value === 'blocked' || status.value === 'done'));
const canSavePlan = computed(() => {
  if (!requiresStateInfo.value) return true;
  const trimmed = stateInfo.value.trim();
  return status.value === 'done' ? trimmed.length >= 10 : trimmed.length > 0;
});

const showDoneButton = computed(() => isPlan.value && !!props.planCallbacks?.onDone && (activePlanStatus.value === 'coding' || activePlanStatus.value === 'review'));
const showApplyButton = computed(() => (!!props.planCallbacks?.onApply && (activePlanStatus.value === 'ready' || activePlanStatus.value === 'coding' || activePlanStatus.value === 'review')));
const applyButtonText = computed(() => (activePlanStatus.value === 'coding' || activePlanStatus.value === 'review') ? '↻ Apply Again' : '▶ Apply');

const STATUS_ICONS: Record<PlanStatus, string> = {
  planning: '⚪',
  ready: '🔵',
  coding: '🟢',
  review: '⏳',
  blocked: '⛔',
  done: '✅',
};

const hasUnsavedChanges = computed(() => {
  if (isContext.value) return label.value !== origLabel.value || text.value !== origText.value || ctxType.value !== origCtxType.value || ctxPermission.value !== origCtxPermission.value || props.contextPendingUnbindCount > 0;
  return label.value !== origLabel.value || text.value !== origText.value || status.value !== origStatus.value || stateInfo.value !== origStateInfo.value || type.value !== origType.value || autoImplement.value !== origAutoImplement.value || completionRecap.value !== origCompletionRecap.value;
});

const saveStatusText = computed(() => ({ unsaved: '● Unsaved', saving: '◑ Saving…', saved: '✓ Saved' }[saveStatus.value] ?? ''));

const planMetaText = computed(() => {
  if (!isPlan.value) return '';
  const parts: string[] = [];
  if (props.planHumanId) parts.push(props.planHumanId);
  if (props.planCreatedAt) parts.push(`Created ${formatDateTime(props.planCreatedAt)}`);
  if (props.planStateUpdatedAt) parts.push(`State ${formatDateTime(props.planStateUpdatedAt)}`);
  return parts.join('  ·  ');
});

type FocusableTarget = HTMLElement | { focus: () => void };

const focusableElements = computed<FocusableTarget[]>(() => {
  const elements: (HTMLElement | null)[] = [labelInputRef.value];
  if (showPlanStateSelect.value) {
    elements.push(typeSelectRef.value);
    elements.push(stateSelectRef.value);
    if (showPlanStateInfo.value) elements.push(stateInfoRef.value);
    elements.push(autoImplementRef.value);
    elements.push(completionRecapRef.value);
  }
  if (isContext.value) {
    elements.push(ctxTypeInputRef.value);
    elements.push(ctxPermissionSelectRef.value);
  }
  const focusables: FocusableTarget[] = elements.filter(Boolean) as HTMLElement[];
  if (bodyPromptRef.value) focusables.push(bodyPromptRef.value);
  return focusables;
});

watch(() => props.visible, (visible) => {
  if (visible) {
    hydratingFromProps.value = true;
    label.value = props.initialLabel;
    text.value = props.initialText;
    status.value = props.planStatus;
    stateInfo.value = props.planStateInfo;
    type.value = props.planType;
    autoImplement.value = Boolean(props.planAutoImplement);
    completionRecap.value = props.planCompletionRecap ?? false;
    origLabel.value = props.initialLabel;
    origText.value = props.initialText;
    origStatus.value = props.planStatus;
    origStateInfo.value = props.planStateInfo;
    origType.value = props.planType;
    origAutoImplement.value = Boolean(props.planAutoImplement);
    origCompletionRecap.value = props.planCompletionRecap ?? false;
    if (isContext.value) {
      ctxType.value = props.contextType;
      ctxPermission.value = props.contextPermission;
      origCtxType.value = props.contextType;
      origCtxPermission.value = props.contextPermission;
    }
    saveStatus.value = 'clean';
    focusIndex.value = 0;
    nextTick(() => {
      hydratingFromProps.value = false;
      applyFocus();
      void applyPersistedHeight();
    });
  } else {
    hydratingFromProps.value = false;
    teardownHeightPersistence();
    if (autoSaveTimer.value) {
      clearTimeout(autoSaveTimer.value);
      autoSaveTimer.value = null;
    }
  }
}, { immediate: true });

watch(() => props.initialLabel, (val) => { if (props.visible) label.value = val; });
watch(() => props.initialText, (val) => { if (props.visible) text.value = val; });
watch(() => props.planId, () => {
  if (!props.visible || !isPlan.value) return;
  hydratingFromProps.value = true;
  label.value = props.initialLabel;
  text.value = props.initialText;
  status.value = props.planStatus;
  stateInfo.value = props.planStateInfo;
  type.value = props.planType;
  autoImplement.value = Boolean(props.planAutoImplement);
  completionRecap.value = (props as any).planCompletionRecap ?? false;
  origLabel.value = props.initialLabel;
  origText.value = props.initialText;
  origStatus.value = props.planStatus;
  origStateInfo.value = props.planStateInfo;
  origType.value = props.planType;
  origAutoImplement.value = Boolean(props.planAutoImplement);
  origCompletionRecap.value = (props as any).planCompletionRecap ?? false;
  saveStatus.value = 'clean';
  nextTick(() => { hydratingFromProps.value = false; });
});

watch(() => props.contextId, () => {
  if (!props.visible || !isContext.value) return;
  hydratingFromProps.value = true;
  label.value = props.initialLabel;
  text.value = props.initialText;
  ctxType.value = props.contextType;
  ctxPermission.value = props.contextPermission;
  origLabel.value = props.initialLabel;
  origText.value = props.initialText;
  origCtxType.value = props.contextType;
  origCtxPermission.value = props.contextPermission;
  saveStatus.value = 'clean';
  nextTick(() => { hydratingFromProps.value = false; });
});

watch([label, text, status, stateInfo, type, autoImplement, completionRecap, ctxType, ctxPermission, () => props.contextPendingUnbindCount], () => {
  if (!props.visible || hydratingFromProps.value) return;
  if (saveStatus.value === 'clean' || saveStatus.value === 'saved') saveStatus.value = 'unsaved';
  scheduleAutoSave();
}, { flush: 'post' });

function applyFocus(): void {
  const elements = focusableElements.value;
  if (focusIndex.value >= elements.length) focusIndex.value = 0;
  elements[focusIndex.value]?.focus();
}

function handleButton(button: string): boolean {
  const dir = button === 'DPadUp' || button === 'ArrowUp' ? 'up' : button === 'DPadDown' || button === 'ArrowDown' ? 'down' : null;
  if (dir === 'down') { focusIndex.value = (focusIndex.value + 1) % focusableElements.value.length; applyFocus(); return true; }
  if (dir === 'up') { const len = focusableElements.value.length; focusIndex.value = (focusIndex.value - 1 + len) % len; applyFocus(); return true; }
  if (button === 'A') { const active = document.activeElement; if (active?.tagName === 'BUTTON') (active as HTMLButtonElement).click(); return true; }
  if (button === 'B') { emit('close'); return true; }
  return false;
}

function onSave(): void {
  if (isContext.value) {
    emit('context-save', { title: label.value, content: text.value, type: ctxType.value, permission: ctxPermission.value });
    emit('close');
  } else {
    if (!canSavePlan.value) { stateInfoRef.value?.focus(); return; }
    emit('plan-save', { title: label.value, description: text.value, status: status.value, stateInfo: stateInfo.value.trim(), type: type.value, autoImplement: autoImplement.value, completionRecap: completionRecap.value });
    emit('close');
  }
}

function onApply(): void {
  emit('plan-apply');
}

function onDone(): void {
  status.value = 'done';
  if (!canSavePlan.value) { stateInfoRef.value?.focus(); return; }
  emit('plan-save', { title: label.value, description: text.value, status: 'done', stateInfo: stateInfo.value.trim(), type: type.value, autoImplement: autoImplement.value, completionRecap: completionRecap.value });
  emit('close');
}

function onDelete(): void {
  if (isContext.value) emit('context-delete');
  else emit('plan-delete');
}

function onContextUnbind(targetType: 'plan' | 'sequence', targetId: string): void {
  props.contextCallbacks?.onUnbind?.(targetType, targetId);
}
function onCancel(): void { emit('close'); }

function getBoundPlanStatus(plan: ContextBoundPlan): PlanStatus {
  return plan.status ?? 'planning';
}

function getBoundPlanLabel(plan: ContextBoundPlan): string {
  const title = getDisplayTitle(plan.title, plan.type);
  return plan.humanId ? `${plan.humanId} ${title}` : title;
}

function scheduleAutoSave(): void {
  if (autoSaveTimer.value) clearTimeout(autoSaveTimer.value);
  autoSaveTimer.value = setTimeout(() => {
    autoSaveTimer.value = null;
    if (hasUnsavedChanges.value) doAutoSave();
  }, 500);
}

function doAutoSave(): void {
  if (isContext.value) {
    if (!props.contextCallbacks?.onSave) return;
    saveStatus.value = 'saving';
    props.contextCallbacks.onSave({ title: label.value, content: text.value, type: ctxType.value, permission: ctxPermission.value });
    origLabel.value = label.value; origText.value = text.value; origCtxType.value = ctxType.value; origCtxPermission.value = ctxPermission.value; saveStatus.value = 'saved';
  } else {
    if (!props.planCallbacks?.onSave || !canSavePlan.value) return;
    saveStatus.value = 'saving';
    props.planCallbacks.onSave({ title: label.value, description: text.value, status: status.value, stateInfo: stateInfo.value.trim(), type: type.value, autoImplement: autoImplement.value, completionRecap: completionRecap.value });
    origLabel.value = label.value; origText.value = text.value; origStatus.value = status.value; origStateInfo.value = stateInfo.value.trim(); origType.value = type.value; origAutoImplement.value = autoImplement.value; origCompletionRecap.value = completionRecap.value; saveStatus.value = 'saved';
  }
  setTimeout(() => { if (saveStatus.value === 'saved') saveStatus.value = 'clean'; }, 2000);
}

function getHasUnsavedChanges(): boolean { return hasUnsavedChanges.value; }

function onKeyDown(e: KeyboardEvent): void {
  if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave(); }
  else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
}

function onLabelKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); }
  else onKeyDown(e);
}

function onStateSelectChange(): void {}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}

async function loadAttachments(): Promise<void> {
  const planId = props.planId;
  if (!planId || !isPlan.value) { attachments.value = []; return; }
  attachmentsLoading.value = true; attachmentError.value = '';
  try { attachments.value = await attachmentsClient.planAttachmentList?.(planId) ?? []; }
  catch { attachmentError.value = 'Could not load attachments'; attachments.value = []; }
  finally { attachmentsLoading.value = false; }
}

async function addAttachment(): Promise<void> {
  const planId = props.planId;
  if (!planId) return;
  attachmentError.value = '';
  const filePath = await dialogClient.dialogShowOpenFile?.([{ name: 'All Files', extensions: ['*'] }]);
  if (!filePath) return;
  const result = await attachmentsClient.planAttachmentAddFile?.(planId, filePath);
  if (!result) { attachmentError.value = 'Could not attach file (max 10 MB)'; return; }
  await loadAttachments();
}

async function openAttachment(att: PlanAttachment): Promise<void> {
  const planId = props.planId;
  if (!planId) return;
  attachmentBusyId.value = att.id; attachmentError.value = '';
  try { const ok = await attachmentsClient.planAttachmentOpen?.(planId, att.id); if (!ok) attachmentError.value = 'Could not open attachment'; }
  finally { attachmentBusyId.value = null; }
}

async function deleteAttachment(att: PlanAttachment): Promise<void> {
  const planId = props.planId;
  if (!planId) return;
  attachmentBusyId.value = att.id; attachmentError.value = '';
  try { const ok = await attachmentsClient.planAttachmentDelete?.(planId, att.id); if (!ok) { attachmentError.value = 'Could not delete attachment'; return; } await loadAttachments(); }
  finally { attachmentBusyId.value = null; }
}

watch([() => props.planId, () => props.visible], ([, visible]) => {
  if (visible && isPlan.value) void loadAttachments();
  else attachments.value = [];
}, { immediate: true });

async function applyPersistedHeight(): Promise<void> {
  const prefs = await configClient.configGetEditorPrefs?.() ?? {};
  const key = editorHeightKey.value as keyof typeof prefs;
  const heightPx = prefs[key] as number | undefined;
  if (Number.isFinite(heightPx) && heightPx! > 0 && bodyPromptRef.value) {
    bodyPromptRef.value.setHeight(heightPx);
  }
}
function scheduleHeightSave(heightPx: number): void {
  if (heightDebounceTimer.value) clearTimeout(heightDebounceTimer.value);
  heightDebounceTimer.value = setTimeout(async () => {
    heightDebounceTimer.value = null;
    if (!Number.isFinite(heightPx) || heightPx <= 0) return;
    await configClient.configSetEditorPrefs?.({ [editorHeightKey.value]: Math.round(heightPx) });
  }, 300);
}
function teardownHeightPersistence(): void {
  if (heightDebounceTimer.value) { clearTimeout(heightDebounceTimer.value); heightDebounceTimer.value = null; }
}

onMounted(() => { if (props.visible) void applyPersistedHeight(); });
onUnmounted(() => { teardownHeightPersistence(); });

defineExpose({ handleButton, hasUnsavedChanges: getHasUnsavedChanges });
</script>

<template>
  <div
    v-if="visible"
    class="item-editor"
    :class="{ 'item-editor--plan': isPlan, 'item-editor--context': isContext }"
  >
    <div class="item-editor-header">
      <span class="item-editor-title">{{ titleText }}</span>
      <div class="item-editor-actions">
        <span v-if="saveStatus !== 'clean'" class="plan-save-status" :class="`plan-save-status--${saveStatus}`">{{ saveStatusText }}</span>
        <button v-if="isPlan && planHumanId" class="btn btn--secondary btn--sm" :title="`Copy reference ${planHumanId}`" @click="copyPlanRef(planHumanId, label)">⧉ Copy ref</button>
        <button class="btn btn--primary btn--sm" @click="onSave">Save</button>
        <button v-if="showApplyButton" class="btn btn--primary btn--sm" @click="onApply">{{ applyButtonText }}</button>
        <button v-if="showDoneButton" class="btn btn--success btn--sm" @click="onDone">✓ Done</button>
        <button class="btn btn--danger btn--sm" @click="onDelete">Delete</button>
        <button class="btn btn--secondary btn--sm" @click="onCancel">Cancel</button>
      </div>
    </div>
    <div v-if="planMetaText" class="item-editor-plan-meta">{{ planMetaText }}</div>

    <div class="plan-edit-rows">
      <!-- Row 1: Title -->
      <div class="plan-edit-row-title">
        <input ref="labelInputRef" v-model="label" type="text" class="item-editor-label" placeholder="Title..." maxlength="100" @keydown="onLabelKeyDown" />
      </div>

      <!-- Row 2: Controls — Feature | State | State context | Auto-implement | Completion recap -->
      <div class="plan-edit-row-controls">
        <select v-if="isPlan" ref="typeSelectRef" v-model="type" class="item-editor-plan-select item-editor-type-select">
          <option :value="undefined">None</option><option value="bug">Bug</option><option value="feature">Feature</option><option value="research">Research</option>
        </select>
        <select v-if="showPlanStateSelect" ref="stateSelectRef" v-model="status" class="item-editor-plan-select item-editor-status-select" @change="onStateSelectChange">
          <option value="planning">⏸ Planning</option><option value="ready">▶ Ready</option><option value="coding">🔄 Coding</option><option value="review">⏳ Review</option><option value="blocked">⛔ Blocked</option><option value="done">✓ Done</option>
        </select>
        <input v-if="showPlanStateInfo" ref="stateInfoRef" v-model="stateInfo" type="text" class="item-editor-plan-info" :placeholder="status === 'done' ? 'Required completion notes...' : requiresStateInfo ? 'Required blocker reason...' : 'Add state context...'" maxlength="200" />
        <label v-if="isPlan" class="item-editor-plan-checkbox">
          <input ref="autoImplementRef" v-model="autoImplement" type="checkbox">
          <span>Auto-implement</span>
        </label>
        <label v-if="isPlan" class="item-editor-plan-checkbox" title="When this plan is marked done, the hub verifies you recently read the plan, then writes its Acceptance Criteria into your terminal — forcing re-verification">
          <input ref="completionRecapRef" v-model="completionRecap" type="checkbox">
          <span>Completion recap <span class="tooltip-icon">ⓘ</span></span>
        </label>
        <!-- Context type (free text with datalist) -->
        <input v-if="isContext" ref="ctxTypeInputRef" v-model="ctxType" type="text" class="item-editor-plan-select item-editor-type-select" placeholder="Type..." maxlength="50" list="context-type-options" />
        <datalist id="context-type-options">
          <option value="Testing" /><option value="Coding" /><option value="Review" /><option value="Knowledge" />
        </datalist>
        <!-- Context permission select -->
        <select v-if="isContext" ref="ctxPermissionSelectRef" v-model="ctxPermission" class="item-editor-plan-select item-editor-permission-select">
          <option value="readonly">readonly</option><option value="writable">writable</option>
        </select>
      </div>

      <!-- Row 3: Content -->
      <PromptTextarea
        ref="bodyPromptRef"
        v-model="text"
        placeholder="Enter your prompt..."
        :rows="4"
        :min-rows="4"
        :max-rows="18"
        :max-height-px="tallEditorMaxHeightPx"
        textarea-class="item-editor-content"
        @resized="scheduleHeightSave"
      />
    </div>

    <div v-if="isContext && hasContextBindings" class="context-bound">
      <div class="context-bound__header"><span class="context-bound__title">Bound To</span></div>
      <div class="context-bound-list">
        <div
          v-for="plan in (contextBoundPlans ?? [])"
          :key="`bp-${plan.id}`"
          class="context-bound-chip context-bound-chip--plan plan-chip"
          :class="`plan-chip--${getBoundPlanStatus(plan)}`"
          :title="getBoundPlanLabel(plan)"
        >
          <span>{{ STATUS_ICONS[getBoundPlanStatus(plan)] }}</span>
          <span class="context-bound-chip-label">{{ getBoundPlanLabel(plan) }}</span>
          <button type="button" class="context-bound-chip-remove" @click="onContextUnbind('plan', plan.id)">&times;</button>
        </div>
        <div v-for="seq in (contextBoundSequences ?? [])" :key="`bs-${seq.id}`" class="context-bound-chip">
          <span class="context-bound-chip-label">{{ seq.title }}</span>
          <button type="button" class="context-bound-chip-remove" @click="onContextUnbind('sequence', seq.id)">&times;</button>
        </div>
      </div>
    </div>

    <div v-if="isPlan && planId" class="item-editor-attachments">
      <div class="item-editor-attachments__header"><span class="item-editor-attachments__title">Attachments</span><button class="btn btn--secondary btn--sm" @click="addAttachment">Attach File</button></div>
      <div v-if="attachmentError" class="item-editor-attachments__error">{{ attachmentError }}</div>
      <div v-if="attachmentsLoading" class="item-editor-attachments__empty">Loading…</div>
      <div v-else-if="attachments.length === 0" class="item-editor-attachments__empty">No attachments</div>
      <div v-else class="item-editor-attachments__list">
        <div v-for="att in attachments" :key="att.id" class="item-editor-attachments__row">
          <span class="item-editor-attachments__name">{{ att.filename }}</span><span class="item-editor-attachments__size">{{ formatAttachmentSize(att.sizeBytes) }}</span>
          <button class="btn btn--secondary btn--sm" :disabled="attachmentBusyId === att.id" @click="openAttachment(att)">Open</button>
          <button class="btn btn--danger btn--sm" :disabled="attachmentBusyId === att.id" @click="deleteAttachment(att)">Delete</button>
        </div>
      </div>
    </div>

    <div v-if="mode === 'plan' && planStatus === 'done' && completionNotes" class="item-editor__completion-notes">
      <label>Completion Notes</label>
      <p class="item-editor__completion-notes-text">{{ completionNotes }}</p>
    </div>
  </div>
</template>

<style scoped>
.item-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: #1e1e2e;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  position: relative;
  z-index: 20;
  max-height: 55vh;
  overflow-y: auto;
}

.item-editor--plan,
.item-editor--context {
  max-height: 82vh;
}

.item-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.item-editor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.item-editor-plan-meta {
  color: var(--text-secondary);
  font-size: 11px;
  margin: 0 0 8px;
}

.item-editor-actions {
  display: flex;
  gap: 4px;
}

.item-editor-plan-state {
  display: flex;
  gap: 6px;
}

.item-editor-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-editor-title-row .item-editor-plan-select {
  min-width: 110px;
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.item-editor-title-row .item-editor-label { flex: 1; }

.item-editor-plan-select,
.item-editor-plan-info {
  padding: 4px 8px;
  background: #252535;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.item-editor-plan-select:focus,
.item-editor-plan-info:focus {
  border-color: var(--accent);
}

.item-editor-plan-select { min-width: 150px; }
.item-editor-plan-info { flex: 1; min-width: 0; }

.item-editor-label {
  padding: 4px 8px;
  background: #252535;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.item-editor-label:focus { border-color: var(--accent); }

.plan-save-status {
  font-size: 11px;
  color: var(--text-dim);
  margin-right: 4px;
  white-space: nowrap;
}

.plan-save-status--hidden { display: none; }
.plan-save-status--unsaved { color: var(--status-blocked); }
.plan-save-status--saving { color: var(--text-dim); }
.plan-save-status--saved { color: var(--status-coding); }

.plan-edit-rows { display: flex; flex-direction: column; gap: 6px; }
.plan-edit-row-title input { width: 100%; }
.plan-edit-row-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tooltip-icon { color: var(--text-dim); font-size: 11px; cursor: help; }
.item-editor-plan-checkbox:hover .tooltip-icon { color: var(--accent, #58a6ff); }
.item-editor-attachments { border-top: 1px solid #2a2a2a; padding-top: 10px; margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }
.item-editor-attachments__header { display: flex; align-items: center; justify-content: space-between; }
.item-editor-attachments__title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.item-editor-attachments__empty, .item-editor-attachments__error { font-size: 12px; color: #666; }
.item-editor-attachments__error { color: #ff9a9a; }
.item-editor-attachments__list { display: flex; flex-direction: column; gap: 4px; }
.item-editor-attachments__row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 6px; padding: 5px 8px; background: #151515; border: 1px solid #2a2a2a; border-radius: 4px; }
.item-editor-attachments__name { font-size: 12px; color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-editor-attachments__size { font-size: 11px; color: #666; white-space: nowrap; }
.item-editor-plan-checkbox { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.item-editor__completion-notes { margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border-radius: 4px; border-left: 3px solid var(--status-coding); }
.item-editor__completion-notes label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.item-editor__completion-notes-text { margin: 0; font-size: 0.9rem; color: var(--text-primary); white-space: pre-wrap; line-height: 1.5; }
.context-bound { border-top: 1px solid #2a2a2a; padding-top: 10px; margin-top: 4px; }
.context-bound__header { display: flex; align-items: center; justify-content: space-between; }
.context-bound__title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.context-bound-list { display: flex; flex-wrap: wrap; gap: 8px; }
.context-bound-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(255, 158, 84, 0.12); border: 1px solid rgba(255, 158, 84, 0.35); color: #ffd1ab; }
.context-bound-chip--plan { padding: 2px 8px; background: var(--bg-tertiary); color: var(--text-primary); max-width: 220px; }
.context-bound-chip--plan.plan-chip--coding { border-color: var(--status-coding); }
.context-bound-chip--plan.plan-chip--ready { border-color: var(--status-ready); }
.context-bound-chip--plan.plan-chip--review { border-color: var(--status-review); }
.context-bound-chip--plan.plan-chip--blocked { border-color: var(--status-blocked); }
.context-bound-chip--plan.plan-chip--planning { border-color: var(--status-planning); }
.context-bound-chip--plan.plan-chip--done { border-color: var(--status-done); }
.context-bound-chip-label { border: 0; background: transparent; color: inherit; font: inherit; cursor: default; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-bound-chip-remove { border: 0; background: transparent; color: inherit; font-size: 16px; cursor: pointer; line-height: 1; padding: 0 0 0 4px; opacity: 0.6; }
.context-bound-chip-remove:hover { opacity: 1; }
</style>
