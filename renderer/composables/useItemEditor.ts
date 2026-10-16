import { ref } from 'vue';
import type ItemEditor from '../components/panels/ItemEditor.vue';
import type { PlanStatus, PlanType } from '../../src/types/plan.js';
import type { ContextCallbacks, PlanCallbacks } from '../components/panels/ItemEditor.vue';
import { planScreenState } from '../plans/plan-screen.js';

type ContextUnbind = { targetType: 'plan' | 'sequence'; targetId: string };

export interface ItemEditorDeps {
  saveContext: (
    id: string,
    updates: { title?: string; content?: string; type?: string; permission?: 'readonly' | 'writable' },
    pendingUnbinds: ContextUnbind[],
  ) => Promise<void>;
}

export function useItemEditor(deps: ItemEditorDeps) {
  const itemEditorVisible = ref(false);
  const itemEditorMode = ref<'plan' | 'context'>('plan');
  const itemEditorSessionId = ref('');
  const itemEditorLabel = ref('');
  const itemEditorText = ref('');
  const itemEditorPlanId = ref<string | null>(null);
  const itemEditorPlanStatus = ref<PlanStatus>('planning');
  const itemEditorPlanStateInfo = ref('');
  const itemEditorPlanType = ref<PlanType | undefined>(undefined);
  const itemEditorPlanAutoImplement = ref(false);
  const itemEditorPlanCompletionRecap = ref(false);
  const itemEditorPlanHumanId = ref('');
  const itemEditorPlanCreatedAt = ref<number | null>(null);
  const itemEditorPlanStateUpdatedAt = ref<number | null>(null);
  const itemEditorPlanCallbacks = ref<PlanCallbacks | null>(null);
  const itemEditorCompletionNotes = ref('');
  const itemEditorContextId = ref<string | null>(null);
  const itemEditorContextType = ref('Knowledge');
  const itemEditorContextPermission = ref<'readonly' | 'writable'>('readonly');
  const itemEditorContextCallbacks = ref<ContextCallbacks | null>(null);
  const itemEditorContextBoundPlans = ref<Array<{ id: string; title: string; humanId?: string; type?: PlanType; status?: PlanStatus }>>([]);
  const itemEditorContextBoundSequences = ref<Array<{ id: string; title: string }>>([]);
  const itemEditorPendingContextUnbinds = ref<ContextUnbind[]>([]);
  const itemEditorRef = ref<InstanceType<typeof ItemEditor> | null>(null);

  function openPlanEditor(
    sessionId: string,
    plan: { id: string; title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean; humanId?: string; createdAt?: number; stateUpdatedAt?: number; completionNotes?: string },
    callbacks: PlanCallbacks,
  ): void {
    itemEditorMode.value = 'plan';
    itemEditorSessionId.value = sessionId;
    itemEditorPlanId.value = plan.id;
    itemEditorPlanStatus.value = plan.status;
    itemEditorPlanStateInfo.value = plan.stateInfo ?? '';
    itemEditorPlanType.value = plan.type;
    itemEditorPlanAutoImplement.value = Boolean(plan.autoImplement);
    itemEditorPlanCompletionRecap.value = Boolean(plan.completionRecap);
    itemEditorPlanHumanId.value = plan.humanId ?? '';
    itemEditorPlanCreatedAt.value = plan.createdAt ?? null;
    itemEditorPlanStateUpdatedAt.value = plan.stateUpdatedAt ?? plan.createdAt ?? null;
    itemEditorCompletionNotes.value = plan.completionNotes ?? '';
    itemEditorLabel.value = plan.title;
    itemEditorText.value = plan.description;
    itemEditorPlanCallbacks.value = callbacks;
    itemEditorContextCallbacks.value = null;
    itemEditorVisible.value = true;
  }

  function closeItemEditor(): void {
    itemEditorPlanCallbacks.value?.onClose?.();
    itemEditorContextCallbacks.value?.onClose?.();
    itemEditorPlanId.value = null;
    itemEditorContextId.value = null;
    itemEditorPendingContextUnbinds.value = [];
    itemEditorVisible.value = false;
  }

  function queueContextUnbind(targetType: 'plan' | 'sequence', targetId: string): void {
    if (targetType === 'plan') {
      itemEditorContextBoundPlans.value = itemEditorContextBoundPlans.value.filter((plan) => plan.id !== targetId);
    } else {
      itemEditorContextBoundSequences.value = itemEditorContextBoundSequences.value.filter((sequence) => sequence.id !== targetId);
    }
    if (!itemEditorPendingContextUnbinds.value.some((entry) => entry.targetType === targetType && entry.targetId === targetId)) {
      itemEditorPendingContextUnbinds.value = [...itemEditorPendingContextUnbinds.value, { targetType, targetId }];
    }
  }

  function openContextEditor(
    context: { id: string; title: string; type: string; permission: 'readonly' | 'writable'; content: string; planIds?: string[]; sequenceIds?: string[] },
    callbacks: ContextCallbacks,
  ): void {
    itemEditorMode.value = 'context';
    itemEditorSessionId.value = '';
    itemEditorContextId.value = context.id;
    itemEditorContextType.value = context.type;
    itemEditorContextPermission.value = context.permission;
    itemEditorLabel.value = context.title;
    itemEditorText.value = context.content;
    itemEditorPlanCallbacks.value = null;
    itemEditorPendingContextUnbinds.value = [];
    itemEditorContextCallbacks.value = {
      ...callbacks,
      onSave: (updates) => {
        void saveContextEditor(context.id, updates);
      },
      onUnbind: queueContextUnbind,
    };
    itemEditorContextBoundPlans.value = (context.planIds ?? [])
      .map((pid) => planScreenState.items.find((item) => item.id === pid))
      .filter(Boolean)
      .map((item) => ({
        id: item!.id,
        title: item!.title,
        humanId: item!.humanId,
        type: item!.type,
        status: item!.status,
      }));
    itemEditorContextBoundSequences.value = (context.sequenceIds ?? [])
      .map((sid) => planScreenState.sequences.find((seq) => seq.id === sid))
      .filter(Boolean) as Array<{ id: string; title: string }>;
    itemEditorVisible.value = true;
  }

  async function saveContextEditor(
    id: string,
    updates: { title?: string; content?: string; type?: string; permission?: 'readonly' | 'writable' },
  ): Promise<void> {
    const pendingUnbinds = [...itemEditorPendingContextUnbinds.value];
    await deps.saveContext(id, updates, pendingUnbinds);
    const savedKeys = new Set(pendingUnbinds.map((entry) => `${entry.targetType}:${entry.targetId}`));
    itemEditorPendingContextUnbinds.value = itemEditorPendingContextUnbinds.value.filter((entry) => !savedKeys.has(`${entry.targetType}:${entry.targetId}`));
  }

  function onItemEditorClose(): void {
    closeItemEditor();
  }

  async function onPlanSave(updates: { title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean }): Promise<void> {
    await itemEditorPlanCallbacks.value?.onSave?.(updates);
  }

  function onPlanApply(): void {
    itemEditorPlanCallbacks.value?.onApply?.();
    closeItemEditor();
  }

  function onPlanDone(): void {
    itemEditorPlanCallbacks.value?.onDone?.();
    closeItemEditor();
  }

  function onPlanDelete(): void {
    itemEditorPlanCallbacks.value?.onDelete?.();
    closeItemEditor();
  }

  function onContextDelete(): void {
    itemEditorContextCallbacks.value?.onDelete?.();
    closeItemEditor();
  }

  function hasUnsavedChanges(): boolean {
    return itemEditorPendingContextUnbinds.value.length > 0 || (itemEditorRef.value?.hasUnsavedChanges?.() ?? false);
  }

  function handleButton(button: string): void {
    itemEditorRef.value?.handleButton(button);
  }

  return {
    itemEditorVisible,
    itemEditorMode,
    itemEditorSessionId,
    itemEditorLabel,
    itemEditorText,
    itemEditorPlanId,
    itemEditorPlanStatus,
    itemEditorPlanStateInfo,
    itemEditorPlanType,
    itemEditorPlanAutoImplement,
    itemEditorPlanCompletionRecap,
    itemEditorPlanHumanId,
    itemEditorPlanCreatedAt,
    itemEditorPlanStateUpdatedAt,
    itemEditorPlanCallbacks,
    itemEditorCompletionNotes,
    itemEditorContextId,
    itemEditorContextType,
    itemEditorContextPermission,
    itemEditorContextCallbacks,
    itemEditorContextBoundPlans,
    itemEditorContextBoundSequences,
    itemEditorPendingContextUnbinds,
    itemEditorRef,
    openPlanEditor,
    openContextEditor,
    closeItemEditor,
    saveContextEditor,
    queueContextUnbind,
    onItemEditorClose,
    onPlanSave,
    onPlanApply,
    onPlanDone,
    onPlanDelete,
    onContextDelete,
    hasUnsavedChanges,
    handleButton,
  };
}
