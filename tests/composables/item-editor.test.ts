import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  planScreenState: {
    items: [] as Array<{ id: string; title: string; humanId?: string; type?: 'bug' | 'feature' | 'research'; status?: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done' }>,
    sequences: [] as Array<{ id: string; title: string }>,
  },
}));

vi.mock('../../renderer/plans/plan-screen.js', () => ({ planScreenState: mocks.planScreenState }));

import { useItemEditor } from '../../renderer/composables/useItemEditor.js';

describe('useItemEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planScreenState.items = [];
    mocks.planScreenState.sequences = [];
  });

  it('opens plan mode with expected state and delegates plan actions', () => {
    const onApply = vi.fn();
    const editor = useItemEditor({ saveContext: vi.fn() });

    editor.openPlanEditor('s1', {
      id: 'p1',
      title: 'Plan title',
      description: 'Plan body',
      status: 'ready',
      stateInfo: 'go',
      type: 'feature',
      autoImplement: true,
      humanId: 'P-0001',
      createdAt: 10,
      stateUpdatedAt: 20,
      completionNotes: 'notes',
    }, { onApply });
    editor.onPlanApply();

    expect(editor.itemEditorVisible.value).toBe(false);
    expect(editor.itemEditorMode.value).toBe('plan');
    expect(editor.itemEditorPlanId.value).toBeNull();
    expect(editor.itemEditorLabel.value).toBe('Plan title');
    expect(editor.itemEditorPlanHumanId.value).toBe('P-0001');
    expect(onApply).toHaveBeenCalled();
  });

  it('queues context unbinds and passes them to save without text edits', async () => {
    const saveContext = vi.fn().mockResolvedValue(undefined);
    mocks.planScreenState.items = [{ id: 'p1', title: 'Plan 1', humanId: 'P-0001', type: 'bug', status: 'ready' }];
    mocks.planScreenState.sequences = [{ id: 'seq1', title: 'Sequence 1' }];
    const editor = useItemEditor({ saveContext });

    editor.openContextEditor({
      id: 'ctx1',
      title: 'Context',
      type: 'Knowledge',
      permission: 'writable',
      content: 'body',
      planIds: ['p1'],
      sequenceIds: ['seq1'],
    }, {});
    editor.itemEditorContextCallbacks.value?.onUnbind?.('plan', 'p1');
    await editor.saveContextEditor('ctx1', { title: 'Context' });

    expect(editor.itemEditorContextBoundPlans.value).toEqual([]);
    expect(saveContext).toHaveBeenCalledWith('ctx1', { title: 'Context' }, [{ targetType: 'plan', targetId: 'p1' }]);
    expect(editor.itemEditorPendingContextUnbinds.value).toEqual([]);
  });

  it('keeps queued context unbinds dirty until save succeeds', async () => {
    const saveContext = vi.fn().mockRejectedValue(new Error('nope'));
    mocks.planScreenState.items = [{ id: 'p1', title: 'Plan 1', humanId: 'P-0001', type: 'bug', status: 'ready' }];
    mocks.planScreenState.sequences = [{ id: 'seq1', title: 'Sequence 1' }];
    const editor = useItemEditor({ saveContext });

    editor.openContextEditor({
      id: 'ctx1',
      title: 'Context',
      type: 'Knowledge',
      permission: 'writable',
      content: 'body',
      planIds: ['p1'],
      sequenceIds: ['seq1'],
    }, {});
    editor.itemEditorContextCallbacks.value?.onUnbind?.('sequence', 'seq1');

    expect(editor.hasUnsavedChanges()).toBe(true);
    await expect(editor.saveContextEditor('ctx1', { title: 'Context' })).rejects.toThrow('nope');
    expect(editor.itemEditorPendingContextUnbinds.value).toEqual([{ targetType: 'sequence', targetId: 'seq1' }]);
    expect(editor.hasUnsavedChanges()).toBe(true);
  });
});
