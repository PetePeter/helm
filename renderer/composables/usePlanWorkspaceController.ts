import { plansClient } from '../ipc/clients.js';
import {
  planScreenState,
  resetFilters,
  toggleAutoFilter,
  toggleHasAttachmentFilter,
  toggleRelatedFocus,
  toggleStatusFilter,
  toggleTypeFilter,
} from '../plans/plan-screen.js';

export function usePlanWorkspaceController() {
  async function onPlanPopOut(): Promise<void> {
    if (!planScreenState.currentDir) return;
    const result = await plansClient.planPopOut(planScreenState.currentDir);
    if (!result?.success) {
      console.error('[PlanWorkspace] Failed to pop out planner:', result?.error ?? 'unknown error');
    }
  }

  function onToggleTypeFilter(type: 'bug' | 'feature' | 'research' | 'untyped'): void {
    toggleTypeFilter(type);
  }

  function onToggleStatusFilter(status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done' | 'suggested'): void {
    toggleStatusFilter(status);
  }

  function onResetFilters(): void {
    resetFilters();
  }

  function onToggleHasAttachmentFilter(value: 'yes' | 'no'): void {
    toggleHasAttachmentFilter(value);
  }

  function onToggleAutoFilter(): void {
    toggleAutoFilter();
  }

  function onToggleRelatedFocus(): void {
    toggleRelatedFocus();
  }

  return {
    onPlanPopOut,
    onToggleTypeFilter,
    onToggleStatusFilter,
    onResetFilters,
    onToggleHasAttachmentFilter,
    onToggleAutoFilter,
    onToggleRelatedFocus,
  };
}
