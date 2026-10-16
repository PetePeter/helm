import { defineStore } from 'pinia';
import { ref } from 'vue';
import { state } from '../state.js';
import { resolveChipbarTemplates } from '../chipbar-templates.js';
import { executeSequenceForSession } from '../bindings.js';
import type { PlanStatus, PlanType } from '../../src/types/plan.js';
import { configClient, plansClient } from '../ipc/clients.js';

let planEditorOpener: ((sessionId: string, plan: any, callbacks: any) => void) | null = null;
export function setPlanEditorOpener(fn: typeof planEditorOpener) { planEditorOpener = fn; }

export interface ChipBarPlan { id: string; humanId?: string; title: string; type?: 'bug' | 'feature' | 'research'; status: 'ready' | 'coding' | 'review' | 'blocked' | 'planning'; }
export interface ChipBarAction { label: string; sequence: string; preview: string; }
interface ChipBarActionConfig { actions: Array<{ label: string; sequence: string }>; inboxDir: string; }

const ACTIVE_PLAN_STATUSES = new Set<ChipBarPlan['status']>(['coding', 'review', 'blocked']);

export const useChipBarStore = defineStore('chip-bar', () => {
  const plans = ref<ChipBarPlan[]>([]);
  const actions = ref<ChipBarAction[]>([]);
  const activeSessionId = ref<string | null>(null);
  const inboxDir = ref('');
  let refreshGeneration = 0;

  function clear(): void {
    activeSessionId.value = null;
    plans.value = [];
    actions.value = [];
    inboxDir.value = '';
  }

  async function refresh(sessionId: string | null = state.activeSessionId): Promise<void> {
    const generation = ++refreshGeneration;
    activeSessionId.value = sessionId;
    if (!sessionId) { clear(); return; }

    const [nextPlans, actionConfig] = await Promise.all([loadPlans(sessionId), loadActionConfig()]);
    if (generation !== refreshGeneration || activeSessionId.value !== sessionId) return;

    plans.value = nextPlans;
    inboxDir.value = actionConfig.inboxDir;
    actions.value = actionConfig.actions.map((action) => ({ ...action, preview: resolveChipbarTemplates(action.sequence, buildTemplateContext(sessionId, actionConfig.inboxDir)) }));
    state.planCodingCounts.set(sessionId, nextPlans.filter((plan) => plan.status !== 'ready').length);
    state.planStartableCounts.set(sessionId, nextPlans.filter((plan) => plan.status === 'ready').length);
  }

  function invalidateActions(): void { actions.value = []; inboxDir.value = ''; }

  async function triggerAction(sequence: string): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) return;
    const resolved = resolveChipbarTemplates(sequence, buildTemplateContext(sessionId, inboxDir.value));
    await executeSequenceForSession(sessionId, resolved);
  }

  async function openPlan(planId: string): Promise<void> {
    const sessionId = activeSessionId.value;
    const plan = plans.value.find((item) => item.id === planId);
    if (!sessionId || !plan) return;

    try {
      const item = await plansClient.planGetItem(planId);
      if (!item) return;

      const onSave = async (updates: { title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; }) => {
        await plansClient.planUpdate(planId, updates);
        if (updates.status === 'done' && item.status !== 'done') {
          await plansClient.planComplete(planId, updates.stateInfo);
        } else if (item.status !== 'done') {
          await plansClient.planSetState(planId, updates.status, updates.stateInfo);
        }
        await refresh(sessionId);
      };

      const onDelete = async () => { await plansClient.planDelete(planId); await refresh(sessionId); };

      planEditorOpener?.(sessionId, item, { onSave, onDelete });
    } catch (error) {
      console.error('[ChipBarStore] Failed to open plan:', error);
    }
  }

  return { plans, actions, activeSessionId, clear, refresh, invalidateActions, triggerAction, openPlan };
});

async function loadPlans(sessionId: string): Promise<ChipBarPlan[]> {
  const session = state.sessions.find((item) => item.id === sessionId);
  const cwd = session?.workingDir ?? '';
  let activePlans: Array<{ id: string; humanId?: string; title: string; type?: string; status: string }> = [];
  let readyPlans: Array<{ id: string; humanId?: string; title: string; type?: string }> = [];
  try { activePlans = cwd ? (plansClient.planGetAllDoingForDir ? await plansClient.planGetAllDoingForDir(cwd) : await plansClient.planDoingForSession(cwd)) : []; } catch { activePlans = []; }
  try { if (cwd) readyPlans = await plansClient.planStartableForDir(cwd); } catch { readyPlans = []; }
  return [
    ...activePlans.filter((plan) => ACTIVE_PLAN_STATUSES.has(toChipStatus(plan.status))).map((plan) => ({ id: plan.id, humanId: plan.humanId, title: plan.title, type: plan.type as 'bug' | 'feature' | 'research' | undefined, status: toChipStatus(plan.status) })),
    ...readyPlans.map((plan) => ({ id: plan.id, humanId: plan.humanId, title: plan.title, type: plan.type as 'bug' | 'feature' | 'research' | undefined, status: 'ready' as const })),
  ];
}

async function loadActionConfig(): Promise<ChipBarActionConfig> {
  try { const data = await configClient.configGetChipbarActions(); return { actions: data.actions ?? [], inboxDir: data.inboxDir ?? '' }; }
  catch { return { actions: [], inboxDir: '' }; }
}

function toChipStatus(status: string): ChipBarPlan['status'] {
  if (status === 'ready' || status === 'review' || status === 'blocked' || status === 'planning') return status;
  return 'coding';
}

function buildTemplateContext(sessionId: string, inboxDir: string): { cwd: string; cliType: string; sessionName: string; inboxDir: string; } {
  const session = state.sessions.find((item) => item.id === sessionId);
  return { cwd: session?.workingDir ?? '', cliType: session?.cliType ?? '', sessionName: session?.name ?? '', inboxDir };
}
