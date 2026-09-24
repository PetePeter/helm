/**
 * Plan screen bridge tests.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPlanList = vi.fn();
const mockPlanDeps = vi.fn();
const mockPlanUpdate = vi.fn();
const mockPlanDelete = vi.fn();
const mockPlanComplete = vi.fn();
const mockPlanApply = vi.fn();
const mockPlanSetState = vi.fn();
const mockPlanCreate = vi.fn();
const mockPlanAddDep = vi.fn();
const mockPlanRemoveDep = vi.fn();
const mockPlanSequenceList = vi.fn();
const mockPlanSequenceCreate = vi.fn();
const mockPlanSequenceUpdate = vi.fn();
const mockPlanSequenceAssign = vi.fn();
const mockPlanSequenceDelete = vi.fn();
const mockPlanSequenceDeleteWithPlans = vi.fn();
const mockPlanExportDirectory = vi.fn();
const mockPlanOpenExternal = vi.fn();
const mockPlanWriteFile = vi.fn();
const mockPlanReadFile = vi.fn();
const mockPlanClearCompleted = vi.fn();
const mockPlanCleanupCounts = vi.fn();
const mockPlanClearEmptySequences = vi.fn();
const mockPlanClearUnreferencedContexts = vi.fn();
const mockPlanContextList = vi.fn();
const mockPlanContextCreate = vi.fn();
const mockPlanContextUpdate = vi.fn();
const mockPlanContextDelete = vi.fn();
const mockPlanContextBind = vi.fn();
const mockPlanContextUnbind = vi.fn();
const mockPlanContextSetPosition = vi.fn();
const mockWriteTempContent = vi.fn();
const mockDialogShowSaveFile = vi.fn();
const mockDialogShowOpenFile = vi.fn();
const mockDeliverPromptSequence = vi.fn();
const mockShowPlanDeleteConfirm = vi.fn();
const mockHidePlanDeleteConfirm = vi.fn();
const mockShowPlanHelpModal = vi.fn();
const mockHidePlanHelpModal = vi.fn();
const mockIsPlanHelpVisible = vi.fn(() => false);
const mockComputeLayout = vi.fn();
const bulkCleanup = { title: '', lines: [] as { count: number; noun: string }[], dirName: '', visible: false };
let cleanupCallback: (() => Promise<void>) | null = null;
let registeredMount: ((params?: unknown, context?: { isActive: () => boolean }) => Promise<void>) | null = null;
let registeredUnmount: (() => void) | null = null;
let currentViewName = 'terminal';

// Spread the real module: a bare stub breaks any transitive import that needs
// another Vue export (modal-bridge pulls in composables that call `ref`).
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue');
  return {
    ...actual,
    reactive: (obj: unknown) => obj,
    watch: (_source: unknown, _cb: unknown, _options?: unknown) => (() => void 0),
  };
});

vi.mock('../renderer/plans/plan-layout.js', () => ({
  computeLayout: (...args: unknown[]) => mockComputeLayout(...args),
}));

vi.mock('../renderer/sequence-delivery.js', () => ({
  deliverPromptSequence: (...args: unknown[]) => mockDeliverPromptSequence(...args),
}));

vi.mock('../renderer/stores/modal-bridge.js', () => ({
  showPlanDeleteConfirm: (...args: unknown[]) => mockShowPlanDeleteConfirm(...args),
  hidePlanDeleteConfirm: (...args: unknown[]) => mockHidePlanDeleteConfirm(...args),
  bulkCleanup,
  setBulkCleanupCallback: (cb: () => Promise<void>) => { cleanupCallback = cb; },
  showPlanHelpModal: (...args: unknown[]) => mockShowPlanHelpModal(...args),
  hidePlanHelpModal: (...args: unknown[]) => mockHidePlanHelpModal(...args),
  isPlanHelpVisible: () => mockIsPlanHelpVisible(),
  planHelp: { visible: false },
}));

vi.mock('../renderer/state.js', () => ({
  state: {
    activeSessionId: 'session-1',
    sessions: [
      { id: 'session-1', workingDir: '/test/dir' },
      { id: 'session-2', workingDir: '/other/dir' },
    ],
  },
}));

vi.mock('../renderer/main-view/main-view-manager.js', () => ({
  registerView: (_name: string, handlers: { mount: typeof registeredMount; unmount: typeof registeredUnmount }) => {
    registeredMount = handlers.mount;
    registeredUnmount = handlers.unmount;
  },
  showView: async (name: string, params?: unknown) => {
    currentViewName = name;
    if (name === 'plan') {
      await registeredMount?.(params, { isActive: () => true });
    } else {
      registeredUnmount?.();
    }
  },
  currentView: () => currentViewName,
}));


function fakeLayout(ids: string[]) {
  return {
    nodes: ids.map((id, index) => ({ id, x: 60 + index * 280, y: 60, layer: index, order: 0 })),
    width: 60 + ids.length * 280 + 60,
    height: 220,
  };
}

function planItem(id: string, title = id) {
  return { id, dirPath: '/test/dir', title, description: title, status: 'planning', createdAt: 1, updatedAt: 1 };
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

let uninstallKeyRouter: (() => void) | null = null;

/**
 * Planner keys are a `pane`-scope router handler registered at module load, so
 * the router must be installed from the same module graph — after
 * `vi.resetModules()` — for dispatched events to reach it.
 */
async function getModule() {
  const mod = await import('../renderer/plans/plan-screen.js');
  const { installKeyRouter } = await import('../renderer/keyboard/router.js');
  uninstallKeyRouter?.();
  uninstallKeyRouter = installKeyRouter({
    getActiveSessionId: () => 'session-1',
    getFocusedPane: () => 'plan-screen',
    isPaneVisible: () => true,
    isModalOpen: () => false,
  });
  return mod;
}

afterEach(() => {
  uninstallKeyRouter?.();
  uninstallKeyRouter = null;
});

describe('plan screen bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    currentViewName = 'terminal';
    registeredMount = null;
    registeredUnmount = null;
    bulkCleanup.title = '';
    bulkCleanup.lines = [];
    bulkCleanup.dirName = '';
    bulkCleanup.visible = false;
    cleanupCallback = null;

    mockPlanList.mockReset();
    mockPlanDeps.mockReset();
    mockPlanUpdate.mockReset();
    mockPlanDelete.mockReset();
    mockPlanComplete.mockReset();
    mockPlanApply.mockReset();
    mockPlanSetState.mockReset();
    mockPlanCreate.mockReset();
    mockPlanAddDep.mockReset();
    mockPlanRemoveDep.mockReset();
    mockPlanSequenceList.mockReset();
    mockPlanSequenceCreate.mockReset();
    mockPlanSequenceUpdate.mockReset();
    mockPlanSequenceAssign.mockReset();
    mockPlanSequenceDelete.mockReset();
    mockPlanSequenceDeleteWithPlans.mockReset();
    mockPlanExportDirectory.mockReset();
    mockPlanOpenExternal.mockReset();
    mockPlanWriteFile.mockReset();
    mockPlanReadFile.mockReset();
    mockPlanClearCompleted.mockReset();
    mockPlanCleanupCounts.mockReset();
    mockPlanClearEmptySequences.mockReset();
    mockPlanClearUnreferencedContexts.mockReset();
    mockPlanContextList.mockReset();
    mockPlanContextCreate.mockReset();
    mockPlanContextUpdate.mockReset();
    mockPlanContextDelete.mockReset();
    mockPlanContextBind.mockReset();
    mockPlanContextUnbind.mockReset();
    mockPlanContextSetPosition.mockReset();
    mockWriteTempContent.mockReset();
    mockDialogShowSaveFile.mockReset();
    mockDialogShowOpenFile.mockReset();
    mockDeliverPromptSequence.mockReset();
    mockShowPlanDeleteConfirm.mockReset();
    mockHidePlanDeleteConfirm.mockReset();
    mockShowPlanHelpModal.mockReset();
    mockHidePlanHelpModal.mockReset();
    mockIsPlanHelpVisible.mockReturnValue(false);
    mockComputeLayout.mockReset();
    mockPlanSequenceList.mockResolvedValue([]);
    mockPlanContextList.mockResolvedValue([]);

    (window as any).gamepadCli = {
      planList: mockPlanList,
      planDeps: mockPlanDeps,
      planUpdate: mockPlanUpdate,
      planDelete: mockPlanDelete,
      planComplete: mockPlanComplete,
      planApply: mockPlanApply,
      planSetState: mockPlanSetState,
      planCreate: mockPlanCreate,
      planAddDep: mockPlanAddDep,
      planRemoveDep: mockPlanRemoveDep,
      planSequenceList: mockPlanSequenceList,
      planSequenceCreate: mockPlanSequenceCreate,
      planSequenceUpdate: mockPlanSequenceUpdate,
      planSequenceDelete: mockPlanSequenceDelete,
      planSequenceAssign: mockPlanSequenceAssign,
      planSequenceDeleteWithPlans: mockPlanSequenceDeleteWithPlans,
      planExportDirectory: mockPlanExportDirectory,
      planOpenExternal: mockPlanOpenExternal,
      planWriteFile: mockPlanWriteFile,
      planReadFile: mockPlanReadFile,
      planClearCompleted: mockPlanClearCompleted,
      planCleanupCounts: mockPlanCleanupCounts,
      planClearEmptySequences: mockPlanClearEmptySequences,
      planClearUnreferencedContexts: mockPlanClearUnreferencedContexts,
      planContextList: mockPlanContextList,
      planContextCreate: mockPlanContextCreate,
      planContextUpdate: mockPlanContextUpdate,
      planContextDelete: mockPlanContextDelete,
      planContextBind: mockPlanContextBind,
      planContextUnbind: mockPlanContextUnbind,
      planContextSetPosition: mockPlanContextSetPosition,
      planAttachmentHasAny: vi.fn().mockResolvedValue({}),
      writeTempContent: mockWriteTempContent,
      dialogShowSaveFile: mockDialogShowSaveFile,
      dialogShowOpenFile: mockDialogShowOpenFile,
      configGetPlanFilters: vi.fn().mockResolvedValue({
        types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' },
        hasAttachment: { yes: 'either', no: 'either' },
        auto: 'either',
      }),
      configSetPlanFilters: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('loads planner state when opened', async () => {
    const mod = await getModule();
    const items = [{ id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 }];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');

    expect(mod.isPlanScreenVisible()).toBe(true);
    expect(mod.getCurrentPlanDirPath()).toBe('/test/dir');
    expect(mod.getSelectedPlanId()).toBe('a');
    expect(mod.planScreenState.items).toEqual(items);
  });

  it('routes D-pad selection through the computed layout', async () => {
    const mod = await getModule();
    const items = [
      { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 },
      { id: 'b', dirPath: '/test/dir', title: 'B', description: 'Beta', status: 'planning', createdAt: 1, updatedAt: 1 },
    ];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a', 'b']));

    await mod.showPlanScreen('/test/dir');

    expect(mod.getSelectedPlanId()).toBe('a');
    expect(mod.handlePlanScreenDpad('right')).toBe(true);
    expect(mod.getSelectedPlanId()).toBe('b');
  });

  it('Escape clears multi-select bulk selection', async () => {
    const mod = await getModule();
    const items = [planItem('a'), planItem('b')];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a', 'b']));

    await mod.showPlanScreen('/test/dir');
    mod.planScreenState.selectedId = null;
    mod.planScreenState.selectedIds.add('a');
    mod.planScreenState.selectedIds.add('b');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(mod.planScreenState.selectedIds.size).toBe(0);
  });

  it('Ctrl+N creates a new plan only while the planner is visible', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const initialItems = [planItem('a')];
    const createdItems = [...initialItems, planItem('n', 'New Plan')];
    mockPlanList
      .mockResolvedValueOnce(initialItems)
      .mockResolvedValueOnce(createdItems);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockImplementation((layoutItems: typeof initialItems) => fakeLayout(layoutItems.map((item) => item.id)));
    mockPlanCreate.mockResolvedValue({ id: 'n' });
    mod.setPlanEditorOpener(opener);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushAsyncHandlers();
    expect(mockPlanCreate).not.toHaveBeenCalled();

    await mod.showPlanScreen('/test/dir');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushAsyncHandlers();

    expect(mockPlanCreate).toHaveBeenCalledWith('/test/dir', 'New Plan', '');
    expect(opener).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'n', title: 'New Plan' }),
      expect.objectContaining({ onSave: expect.any(Function), onDelete: expect.any(Function) }),
    );
  });

  it('Ctrl+N is a no-op when a plan editor is already open', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = planItem('a');
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushAsyncHandlers();

    expect(mockPlanCreate).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(mod.planScreenState.notice).toBe('Finish or cancel current edits before creating a new plan');
  });

  it('computes related focus across dependency chains in either direction', async () => {
    const mod = await getModule();
    const related = mod.computeConnectedPlanIds('b', [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
      { fromId: 'x', toId: 'y' },
    ]);

    expect([...related].sort()).toEqual(['a', 'b', 'c']);
  });

  it('dims unrelated plans without removing them from the filtered layout', async () => {
    const mod = await getModule();
    const items = [planItem('a'), planItem('b'), planItem('c'), planItem('d')];
    const deps = [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
    ];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue(deps);
    mockComputeLayout.mockImplementation((layoutItems: typeof items) => fakeLayout(layoutItems.map((item) => item.id)));

    await mod.showPlanScreen('/test/dir');
    mod.onPlanNodeClick('b');
    mod.toggleRelatedFocus();

    expect([...mod.planScreenState.relatedFocusIds].sort()).toEqual(['a', 'b', 'c']);
    expect(mod.isPlanRelatedBackground('d')).toBe(true);
    expect(mockComputeLayout).toHaveBeenLastCalledWith(items, deps);
  });

  it('keeps D-pad navigation out of unrelated background plans', async () => {
    const mod = await getModule();
    const items = [planItem('a'), planItem('b'), planItem('c')];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([{ fromId: 'a', toId: 'b' }]);
    mockComputeLayout.mockReturnValue({
      nodes: [
        { id: 'a', x: 60, y: 60, layer: 0, order: 0 },
        { id: 'c', x: 340, y: 60, layer: 1, order: 0 },
        { id: 'b', x: 340, y: 180, layer: 1, order: 1 },
      ],
      width: 620,
      height: 340,
    });

    await mod.showPlanScreen('/test/dir');
    mod.toggleRelatedFocus();

    expect(mod.handlePlanScreenDpad('right')).toBe(true);
    expect(mod.getSelectedPlanId()).toBe('b');
  });

  it('keeps new plans foreground while related focus is active until refresh or link', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const initialItems = [planItem('a'), planItem('b'), planItem('c')];
    const withNewItem = [...initialItems, planItem('n', 'New Plan')];
    mockPlanList
      .mockResolvedValueOnce(initialItems)
      .mockResolvedValueOnce(withNewItem)
      .mockResolvedValueOnce(withNewItem)
      .mockResolvedValueOnce(withNewItem);
    mockPlanDeps
      .mockResolvedValueOnce([{ fromId: 'a', toId: 'b' }])
      .mockResolvedValueOnce([{ fromId: 'a', toId: 'b' }])
      .mockResolvedValueOnce([{ fromId: 'a', toId: 'b' }])
      .mockResolvedValueOnce([{ fromId: 'a', toId: 'b' }, { fromId: 'a', toId: 'n' }]);
    mockComputeLayout.mockImplementation((layoutItems: typeof initialItems) => fakeLayout(layoutItems.map((item) => item.id)));
    mockPlanCreate.mockResolvedValue({ id: 'n' });
    mockPlanAddDep.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.toggleRelatedFocus();
    await mod.onPlanAddNode();

    expect(mod.planScreenState.relatedTransientIds.has('n')).toBe(true);
    expect(mod.isPlanRelatedBackground('n')).toBe(false);
    expect(mod.isPlanRelatedBackground('c')).toBe(true);

    await mod.refreshCanvasIfVisible();
    expect(mod.planScreenState.relatedTransientIds.has('n')).toBe(false);
    expect(mod.isPlanRelatedBackground('n')).toBe(true);

    await mod.onPlanAddDependency('a', 'n');
    expect(mod.planScreenState.relatedTransientIds.has('n')).toBe(false);
    expect(mod.planScreenState.relatedFocusIds.has('n')).toBe(true);
    expect(mod.isPlanRelatedBackground('n')).toBe(false);
  });

  it('loads and edits first-class plan sequences through the planner bridge', async () => {
    const mod = await getModule();
    const item = planItem('a');
    const sequence = {
      id: 'seq-1',
      dirPath: '/test/dir',
      title: 'Mission',
      missionStatement: 'Keep the goal visible',
      sharedMemory: 'Shared notes',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockPlanSequenceList
      .mockResolvedValueOnce([sequence])
      .mockResolvedValueOnce([sequence])
      .mockResolvedValueOnce([{ ...sequence, title: 'Updated Mission' }]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanSequenceAssign.mockResolvedValue({ ...item, sequenceId: 'seq-1' });
    mockPlanSequenceUpdate.mockResolvedValue({ ...sequence, title: 'Updated Mission' });

    await mod.showPlanScreen('/test/dir');
    expect(mod.planScreenState.sequences).toEqual([sequence]);

    await mod.onPlanAssignSequence('a', 'seq-1');
    expect(mockPlanSequenceAssign).toHaveBeenCalledWith('a', 'seq-1');

    await mod.onPlanUpdateSequence('seq-1', { title: 'Updated Mission' });
    expect(mockPlanSequenceUpdate).toHaveBeenCalledWith('seq-1', { title: 'Updated Mission' });
  });

  it('selects a related plan when a context chip targets it', async () => {
    const mod = await getModule();
    const items = [planItem('a', 'Plan A'), planItem('b', 'Plan B')];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a', 'b']));
    mockPlanContextList.mockResolvedValue([
      {
        id: 'ctx-1',
        dirPath: '/test/dir',
        title: 'Testing Strategy',
        type: 'Knowledge',
        permission: 'readonly',
        content: '',
        x: null,
        y: null,
        createdAt: 1,
        updatedAt: 1,
        sequenceIds: [],
        planIds: ['b'],
      },
    ]);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanContextClick('ctx-1');
    mod.onPlanContextSelectPlan('b');

    expect(mod.getSelectedPlanId()).toBe('b');
    expect(mod.getSelectedContextId()).toBeNull();
  });

  it('saves context edits through the planner bridge and keeps the context selected', async () => {
    const mod = await getModule();
    const initialContext = {
      id: 'ctx-1',
      dirPath: '/test/dir',
      title: 'Testing Strategy',
      type: 'Knowledge',
      permission: 'readonly',
      content: 'Before',
      x: null,
      y: null,
      createdAt: 1,
      updatedAt: 1,
      sequenceIds: [],
      planIds: [],
    };
    const updatedContext = {
      ...initialContext,
      title: 'Updated Strategy',
      content: 'After',
      updatedAt: 2,
    };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanContextList
      .mockResolvedValueOnce([initialContext])
      .mockResolvedValueOnce([updatedContext]);
    mockPlanContextUpdate.mockResolvedValue(updatedContext);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanContextClick('ctx-1');
    await mod.onPlanContextSave('ctx-1', {
      title: 'Updated Strategy',
      content: 'After',
    });

    expect(mockPlanContextUpdate).toHaveBeenCalledWith('ctx-1', {
      title: 'Updated Strategy',
      content: 'After',
    });
    expect(mod.getSelectedContextId()).toBe('ctx-1');
    expect(mod.planScreenState.contexts[0]).toEqual(updatedContext);
  });

  it('applies pending context unbinds only when context edits are saved', async () => {
    const mod = await getModule();
    const initialContext = {
      id: 'ctx-1',
      dirPath: '/test/dir',
      title: 'Testing Strategy',
      type: 'Knowledge',
      permission: 'readonly',
      content: 'Before',
      x: null,
      y: null,
      createdAt: 1,
      updatedAt: 1,
      sequenceIds: ['seq-1'],
      planIds: ['a'],
    };
    const updatedContext = {
      ...initialContext,
      title: 'Updated Strategy',
      sequenceIds: [],
      planIds: [],
      updatedAt: 2,
    };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanContextList
      .mockResolvedValueOnce([initialContext])
      .mockResolvedValueOnce([updatedContext]);
    mockPlanContextUpdate.mockResolvedValue(updatedContext);
    mockPlanContextUnbind.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    expect(mockPlanContextUnbind).not.toHaveBeenCalled();

    await mod.onPlanContextSave('ctx-1', { title: 'Updated Strategy' }, [
      { targetType: 'plan', targetId: 'a' },
      { targetType: 'sequence', targetId: 'seq-1' },
    ]);

    expect(mockPlanContextUpdate).toHaveBeenCalledWith('ctx-1', { title: 'Updated Strategy' });
    expect(mockPlanContextUnbind).toHaveBeenCalledWith('ctx-1', 'plan', 'a');
    expect(mockPlanContextUnbind).toHaveBeenCalledWith('ctx-1', 'sequence', 'seq-1');
    expect(mod.planScreenState.contexts[0]).toEqual(updatedContext);
  });

  it('routes context deletes through the confirmation bridge and clears the selection after confirm', async () => {
    const mod = await getModule();
    const context = {
      id: 'ctx-1',
      dirPath: '/test/dir',
      title: 'Testing Strategy',
      type: 'Knowledge',
      permission: 'readonly',
      content: 'Before',
      x: null,
      y: null,
      createdAt: 1,
      updatedAt: 1,
      sequenceIds: [],
      planIds: [],
    };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanContextList
      .mockResolvedValueOnce([context])
      .mockResolvedValueOnce([]);
    mockPlanContextDelete.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanContextClick('ctx-1');
    await mod.onPlanContextDelete('ctx-1');

    expect(mockPlanContextDelete).not.toHaveBeenCalled();
    expect(mockShowPlanDeleteConfirm).toHaveBeenCalledWith(
      'Testing Strategy',
      expect.any(Function),
      expect.objectContaining({ itemKind: 'context', title: 'Delete Context' }),
    );
    await mockShowPlanDeleteConfirm.mock.calls[0][1]();
    await flushAsyncHandlers();
    expect(mockPlanContextDelete).toHaveBeenCalledWith('ctx-1');
    expect(mod.getSelectedContextId()).toBeNull();
    expect(mod.planScreenState.contexts).toEqual([]);
  });

  it('routes sequence deletes through the confirmation bridge', async () => {
    const mod = await getModule();
    const sequence = { id: 'seq-1', title: 'Release Train', missionStatement: '', sharedMemory: '', planIds: [] };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockPlanSequenceList.mockResolvedValue([sequence]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanSequenceDelete.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    await mod.onPlanDeleteSequence('seq-1');

    expect(mockPlanSequenceDelete).not.toHaveBeenCalled();
    expect(mockShowPlanDeleteConfirm).toHaveBeenCalledWith(
      'Release Train',
      expect.any(Function),
      expect.objectContaining({ itemKind: 'sequence', title: 'Delete Sequence' }),
    );
    await mockShowPlanDeleteConfirm.mock.calls[0][1]();
    await flushAsyncHandlers();
    expect(mockPlanSequenceDelete).toHaveBeenCalledWith('seq-1');
  });

  it('routes sequence with plans deletes through the confirmation bridge', async () => {
    const mod = await getModule();
    const sequence = { id: 'seq-1', title: 'Release Train', missionStatement: '', sharedMemory: '', planIds: ['a'] };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockPlanSequenceList.mockResolvedValue([sequence]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanSequenceDeleteWithPlans.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    await mod.onPlanDeleteSequenceWithPlans('seq-1');

    expect(mockPlanSequenceDeleteWithPlans).not.toHaveBeenCalled();
    expect(mockShowPlanDeleteConfirm).toHaveBeenCalledWith(
      'Release Train',
      expect.any(Function),
      expect.objectContaining({ itemKind: 'sequence and all contained plans', title: 'Delete Sequence + Plans' }),
    );
    await mockShowPlanDeleteConfirm.mock.calls[0][1]();
    await flushAsyncHandlers();
    expect(mockPlanSequenceDeleteWithPlans).toHaveBeenCalledWith('seq-1');
  });

  it('refreshes bound context metadata after a planner-side bind', async () => {
    const mod = await getModule();
    const contextBefore = {
      id: 'ctx-1',
      dirPath: '/test/dir',
      title: 'Testing Strategy',
      type: 'Knowledge',
      permission: 'readonly',
      content: 'Before',
      x: null,
      y: null,
      createdAt: 1,
      updatedAt: 1,
      sequenceIds: [],
      planIds: [],
    };
    const contextAfter = {
      ...contextBefore,
      sequenceIds: ['seq-1'],
    };
    const sequence = {
      id: 'seq-1',
      dirPath: '/test/dir',
      title: 'Mission',
      missionStatement: '',
      sharedMemory: '',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockPlanSequenceList.mockResolvedValue([sequence]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanContextList
      .mockResolvedValueOnce([contextBefore])
      .mockResolvedValueOnce([contextAfter]);
    mockPlanContextBind.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    await mod.onPlanContextBind('ctx-1', 'seq-1');

    expect(mockPlanContextBind).toHaveBeenCalledWith('ctx-1', 'sequence', 'seq-1');
    expect(mod.planScreenState.contexts[0]?.sequenceIds).toEqual(['seq-1']);
  });

  it('creates a context with no bindings via onPlanAddContext', async () => {
    const mod = await getModule();
    const createdContext = {
      id: 'ctx-new',
      dirPath: '/test/dir',
      title: 'New Context',
      type: 'Knowledge',
      permission: 'readonly' as const,
      content: '',
      x: null,
      y: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sequenceIds: [],
      planIds: [],
    };
    mockPlanList.mockResolvedValue([]);
    mockPlanDeps.mockResolvedValue([]);
    mockPlanSequenceList.mockResolvedValue([]);
    mockPlanContextList
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdContext]);
    mockPlanContextCreate.mockResolvedValue(createdContext);
    mockComputeLayout.mockReturnValue({ nodes: [], width: 0, height: 0 });

    await mod.showPlanScreen('/test/dir');
    await mod.onPlanAddContext();

    expect(mockPlanContextCreate).toHaveBeenCalledWith('/test/dir', {
      title: 'New Context',
      type: 'Knowledge',
      permission: 'readonly',
      content: '',
      x: null,
      y: null,
    });
    expect(mod.getSelectedContextId()).toBe('ctx-new');
  });

  it('ignores stale planner reloads that resolve after a newer one', async () => {
    const mod = await getModule();
    // Local stand-in for Promise.withResolvers, which requires Node 22+;
    // keeps the test running on Node 20 (e.g. macOS CI/dev machines).
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    const firstList = deferred<any[]>();
    const firstDeps = deferred<any[]>();
    const secondList = deferred<any[]>();
    const secondDeps = deferred<any[]>();

    mockPlanList.mockResolvedValueOnce([planItem('initial')]);
    mockPlanDeps.mockResolvedValueOnce([]);
    mockComputeLayout.mockImplementation((layoutItems: Array<{ id: string }>) => fakeLayout(layoutItems.map((item) => item.id)));

    await mod.showPlanScreen('/test/dir');

    mockPlanList
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise);
    mockPlanDeps
      .mockReturnValueOnce(firstDeps.promise)
      .mockReturnValueOnce(secondDeps.promise);
    mockPlanSequenceList.mockResolvedValue([]);
    mockPlanContextList.mockResolvedValue([]);

    const refreshOne = mod.refreshCanvasIfVisible();
    const refreshTwo = mod.refreshCanvasIfVisible();

    secondList.resolve([planItem('fresh')]);
    secondDeps.resolve([]);
    await refreshTwo;

    firstList.resolve([planItem('stale')]);
    firstDeps.resolve([]);
    await refreshOne;

    expect(mod.planScreenState.items.map((item) => item.id)).toEqual(['fresh']);
  });

  it('opens the Vue-owned editor through the registered opener', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    expect(mod.handlePlanScreenAction('A')).toBe(true);

    expect(opener).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'a', title: 'A' }),
      expect.objectContaining({ onSave: expect.any(Function), onDelete: expect.any(Function) }),
    );
  });

  it('keeps saving the originally opened plan after selection moves to another node', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const items = [
      planItem('a', 'Plan A'),
      planItem('b', 'Plan B'),
    ];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a', 'b']));
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanNodeEdit('a');

    const callbacks = opener.mock.calls[0][2];
    mod.onPlanNodeClick('b');
    await callbacks.onSave({
      title: 'Plan A updated',
      description: 'Still editing A',
      status: 'planning',
    });

    expect(mod.getSelectedPlanId()).toBe('b');
    expect(mockPlanUpdate).toHaveBeenCalledWith('a', {
      title: 'Plan A updated',
      description: 'Still editing A',
      status: 'planning',
    });
    expect(mockPlanSetState).toHaveBeenCalledWith('a', 'planning', undefined);
  });

  it('loads and saves attachment filters without dropping them back to defaults', async () => {
    const mod = await getModule();
    const item = planItem('a');
    const configGetPlanFilters = vi.fn().mockResolvedValue({
      types: { bug: 'either', feature: 'no', research: 'either', untyped: 'either' },
      statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'no' },
      hasAttachment: { yes: 'either', no: 'yes' },
      auto: 'either',
    });
    const configSetPlanFilters = vi.fn().mockResolvedValue(undefined);
    (window as any).gamepadCli.configGetPlanFilters = configGetPlanFilters;
    (window as any).gamepadCli.configSetPlanFilters = configSetPlanFilters;
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');

    expect(mod.planScreenState.filters.hasAttachment).toEqual({ yes: 'either', no: 'yes' });

    mod.toggleHasAttachmentFilter('yes');
    await flushAsyncHandlers();
    expect(configSetPlanFilters).toHaveBeenCalledWith(expect.objectContaining({
      hasAttachment: { yes: 'yes', no: 'yes' },
    }));
  });

  it('saves status filters as a plain snapshot for IPC persistence', async () => {
    const mod = await getModule();
    const item = planItem('a');
    const configSetPlanFilters = vi.fn().mockResolvedValue(undefined);
    (window as any).gamepadCli.configSetPlanFilters = configSetPlanFilters;
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');

    mod.toggleStatusFilter('done');
    await flushAsyncHandlers();

    const saved = configSetPlanFilters.mock.calls.at(-1)?.[0];
    expect(saved.statuses.done).toBe('yes');
    expect(saved).not.toBe(mod.planScreenState.filters);
    expect(saved.statuses).not.toBe(mod.planScreenState.filters.statuses);

    mod.toggleStatusFilter('done');

    expect(saved.statuses.done).toBe('yes');
  });

  it('cycles auto filters through yes, no, and either', async () => {
    const mod = await getModule();
    const auto = { ...planItem('auto'), autoImplement: true };
    const manual = planItem('manual');
    mockPlanList.mockResolvedValue([auto, manual]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockImplementation((layoutItems: Array<{ id: string }>) => fakeLayout(layoutItems.map((item) => item.id)));

    await mod.showPlanScreen('/test/dir');
    expect(mod.planScreenState.layout.nodes.map((node) => node.id)).toEqual(['auto', 'manual']);

    mod.toggleAutoFilter();
    expect(mod.planScreenState.filters.auto).toBe('yes');
    expect(mod.planScreenState.layout.nodes.map((node) => node.id)).toEqual(['auto']);

    mod.toggleAutoFilter();
    expect(mod.planScreenState.filters.auto).toBe('no');
    expect(mod.planScreenState.layout.nodes.map((node) => node.id)).toEqual(['manual']);

    mod.toggleAutoFilter();
    expect(mod.planScreenState.filters.auto).toBe('either');
    expect(mod.planScreenState.layout.nodes.map((node) => node.id)).toEqual(['auto', 'manual']);
  });

  it('reloads persisted done filter state after planner remount', async () => {
    const mod = await getModule();
    await flushAsyncHandlers();

    const configGetPlanFilters = vi.fn()
      .mockResolvedValueOnce({
        types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'no' },
        hasAttachment: { yes: 'either', no: 'either' },
        auto: 'either',
      })
      .mockResolvedValueOnce({
        types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'no' },
        hasAttachment: { yes: 'either', no: 'either' },
        auto: 'either',
      });
    (window as any).gamepadCli.configGetPlanFilters = configGetPlanFilters;
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');
    mod.hidePlanScreen();
    await mod.showPlanScreen('/test/dir');

    expect(mod.planScreenState.filters.statuses.done).toBe('no');
  });

  it('eagerly loads persisted filter preferences on module import', async () => {
    const customFilters = {
      types: { bug: 'no', feature: 'yes', research: 'no', untyped: 'either' },
      statuses: { planning: 'no', ready: 'yes', coding: 'no', review: 'yes', blocked: 'no', done: 'no' },
      hasAttachment: { yes: 'yes', no: 'no' },
      auto: 'yes',
    };
    const configGetPlanFilters = vi.fn().mockResolvedValue(customFilters);
    const configSetPlanFilters = vi.fn().mockResolvedValue(undefined);
    (window as any).gamepadCli.configGetPlanFilters = configGetPlanFilters;
    (window as any).gamepadCli.configSetPlanFilters = configSetPlanFilters;

    const mod = await getModule();
    // Wait for the eager load to complete
    await flushAsyncHandlers();

    expect(configGetPlanFilters).toHaveBeenCalled();
    expect(mod.planScreenState.filters.types).toEqual(customFilters.types);
    expect(mod.planScreenState.filters.statuses).toEqual(customFilters.statuses);
    expect(mod.planScreenState.filters.hasAttachment).toEqual(customFilters.hasAttachment);
    expect(mod.planScreenState.filters.auto).toBe('yes');
  });

  it('coerces old boolean filter preferences to either', async () => {
    const legacyFilters = {
      types: { bug: false, feature: true, research: false, untyped: true },
      statuses: { planning: false, ready: true, coding: false, review: true, blocked: false, done: false },
      hasAttachment: { yes: true, no: false },
    };
    const configGetPlanFilters = vi.fn().mockResolvedValue(legacyFilters);
    (window as any).gamepadCli.configGetPlanFilters = configGetPlanFilters;

    const mod = await getModule();
    await flushAsyncHandlers();

    expect(mod.planScreenState.filters.types).toEqual({ bug: 'either', feature: 'either', research: 'either', untyped: 'either' });
    expect(mod.planScreenState.filters.statuses).toEqual({ planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' });
    expect(mod.planScreenState.filters.hasAttachment).toEqual({ yes: 'either', no: 'either' });
    expect(mod.planScreenState.filters.auto).toBe('either');
  });

  it('reloads filter preferences on each planner mount', async () => {
    const mod = await getModule();
    await flushAsyncHandlers();

    const secondLoadFilters = {
      types: { bug: 'no', feature: 'no', research: 'no', untyped: 'no' },
      statuses: { planning: 'yes', ready: 'no', coding: 'no', review: 'no', blocked: 'no', done: 'no' },
      hasAttachment: { yes: 'no', no: 'yes' },
      auto: 'no',
    };
    const configGetPlanFilters = vi.fn().mockResolvedValue(secondLoadFilters);
    (window as any).gamepadCli.configGetPlanFilters = configGetPlanFilters;

    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');

    expect(configGetPlanFilters).toHaveBeenCalled();
    expect(mod.planScreenState.filters.types).toEqual(secondLoadFilters.types);
    expect(mod.planScreenState.filters.statuses).toEqual(secondLoadFilters.statuses);
    expect(mod.planScreenState.filters.hasAttachment).toEqual(secondLoadFilters.hasAttachment);
    expect(mod.planScreenState.filters.auto).toBe('no');
  });

  it('saves plan edits through the editor callback', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'coding', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanUpdate.mockResolvedValue(undefined);
    mockPlanSetState.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Updated',
      description: 'Updated body',
      status: 'blocked',
      stateInfo: 'Waiting',
    });

    expect(mockPlanUpdate).toHaveBeenCalledWith('a', {
      title: 'Updated',
      description: 'Updated body',
      status: 'blocked',
      stateInfo: 'Waiting',
    });
    expect(mockPlanSetState).toHaveBeenCalledWith('a', 'blocked', 'Waiting');
  });

  it('does not assign the active session when saving an unowned plan as review', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'ready', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanUpdate.mockResolvedValue(undefined);
    mockPlanSetState.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Updated',
      description: 'Updated body',
      status: 'review',
    });

    expect(mockPlanSetState).toHaveBeenCalledWith('a', 'review', undefined);
  });

  it('saves an explicit planning status without forcing it back to ready', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'ready', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanUpdate.mockResolvedValue(undefined);
    mockPlanSetState.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Updated',
      description: 'Updated body',
      status: 'planning',
    });

    expect(mockPlanSetState).toHaveBeenCalledWith('a', 'planning', undefined);
  });

  it('saves done through planComplete with completion notes', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'review', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanUpdate.mockResolvedValue(undefined);
    mockPlanComplete.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Updated',
      description: 'Updated body',
      status: 'done',
      stateInfo: 'Reviewed and completed',
    });

    expect(mockPlanComplete).toHaveBeenCalledWith('a', 'Reviewed and completed');
    expect(mockPlanSetState).not.toHaveBeenCalled();
  });

  it('passes plan type updates through the editor save path', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'ready', type: 'bug', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanUpdate.mockResolvedValue(undefined);
    mockPlanSetState.mockResolvedValue(undefined);
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Updated',
      description: 'Updated body',
      status: 'ready',
      type: 'research',
    });

    expect(mockPlanUpdate).toHaveBeenCalledWith('a', {
      title: 'Updated',
      description: 'Updated body',
      status: 'ready',
      type: 'research',
    });
  });

  it('applies a ready plan through the editor callback', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'ready', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockWriteTempContent.mockResolvedValue({ success: true, path: '/tmp/helm-work.txt' });
    mockPlanApply.mockResolvedValue({});
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    const callbacks = opener.mock.calls[0][2];
    await callbacks.onApply();

    expect(mockWriteTempContent).toHaveBeenCalledWith('Alpha');
    expect(mockDeliverPromptSequence).toHaveBeenCalledWith('session-1', 'work for you to do is here: /tmp/helm-work.txt{Send}');
    expect(mockPlanApply).toHaveBeenCalledWith('a');
  });

  it('opens the editor in done mode from the canvas Done action', async () => {
    const mod = await getModule();
    const opener = vi.fn();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'coding', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mod.setPlanEditorOpener(opener);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanNodeComplete('a');

    expect(opener).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'a', status: 'done', stateInfo: '' }),
      expect.objectContaining({ onSave: expect.any(Function), onDelete: expect.any(Function) }),
    );
    expect(mockPlanComplete).not.toHaveBeenCalled();
  });

  it('routes delete requests through the confirmation bridge', async () => {
    const mod = await getModule();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanDelete.mockResolvedValue(undefined);

    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('X');

    expect(mockShowPlanDeleteConfirm).toHaveBeenCalled();
    const confirmCallback = mockShowPlanDeleteConfirm.mock.calls[0][1];
    await confirmCallback();
    expect(mockPlanDelete).toHaveBeenCalledWith('a');
  });

  it('adds and removes dependencies through the bridge actions', async () => {
    const mod = await getModule();
    const items = [
      { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 },
      { id: 'b', dirPath: '/test/dir', title: 'B', description: 'Beta', status: 'planning', createdAt: 1, updatedAt: 1 },
    ];
    mockPlanList.mockResolvedValue(items);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a', 'b']));

    await mod.showPlanScreen('/test/dir');
    mod.onPlanAddDependency('a', 'b');
    mod.onPlanRemoveDependency('a', 'b');

    expect(mockPlanAddDep).toHaveBeenCalledWith('a', 'b');
    expect(mockPlanRemoveDep).toHaveBeenCalledWith('a', 'b');
  });

  it('exports planner data through the save-file flow', async () => {
    const mod = await getModule();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanExportDirectory.mockResolvedValue('{"items":[]}');
    mockDialogShowSaveFile.mockResolvedValue('/tmp/plans.json');
    mockPlanWriteFile.mockResolvedValue(true);

    await mod.showPlanScreen('/test/dir');
    mod.onPlanExportDirectory();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockPlanExportDirectory).toHaveBeenCalledWith('/test/dir');
    expect(mockPlanWriteFile).toHaveBeenCalledWith('/tmp/plans.json', '{"items":[]}');
  });

  it('opens selected plan externally via planOpenExternal', async () => {
    const mod = await getModule();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanOpenExternal.mockResolvedValue({ success: true, path: '/tmp/helm-plan-export.md' });

    await mod.showPlanScreen('/test/dir');
    mod.onPlanOpenExternal();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockPlanOpenExternal).toHaveBeenCalledWith('a');
  });

  it('shows notice when no plan is selected for external open', async () => {
    const mod = await getModule();
    mockPlanList.mockResolvedValue([]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout([]));

    await mod.showPlanScreen('/test/dir');
    mod.onPlanOpenExternal();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockPlanOpenExternal).not.toHaveBeenCalled();
    expect(mod.planScreenState.notice).toContain('Select');
  });

  it('shows notice when planOpenExternal returns failure', async () => {
    const mod = await getModule();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: '', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    mockPlanOpenExternal.mockResolvedValue({ success: false, error: 'Plan not found' });

    await mod.showPlanScreen('/test/dir');
    mod.onPlanOpenExternal();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mod.planScreenState.notice).toContain('not found');
  });

  describe('bulk cleanup (P-0805)', () => {
    const counts = { donePlans: 2, emptySequences: 1, unreferencedContexts: 0, unusedContexts: 3 };

    async function openScreen() {
      const mod = await getModule();
      mockPlanList.mockResolvedValue([]);
      mockPlanDeps.mockResolvedValue([]);
      mockComputeLayout.mockReturnValue(fakeLayout([]));
      mockPlanCleanupCounts.mockResolvedValue(counts);
      await mod.showPlanScreen('/test/dir');
      return mod;
    }

    it('previews "Clear unused" with the counts it will delete, and deletes nothing yet', async () => {
      const mod = await openScreen();
      mod.onPlanCleanup('unused');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockPlanCleanupCounts).toHaveBeenCalledWith('/test/dir');
      expect(bulkCleanup).toMatchObject({
        visible: true,
        title: 'Clear unused items?',
        dirName: 'dir',
        lines: [{ count: 1, noun: 'empty sequence' }, { count: 3, noun: 'unreferenced context' }],
      });
      expect(mockPlanClearEmptySequences).not.toHaveBeenCalled();
      expect(mockPlanClearUnreferencedContexts).not.toHaveBeenCalled();
    });

    it('on confirm, "Clear unused" clears sequences before contexts and never done plans', async () => {
      const mod = await openScreen();
      const order: string[] = [];
      mockPlanClearEmptySequences.mockImplementation(async () => { order.push('sequences'); return 1; });
      mockPlanClearUnreferencedContexts.mockImplementation(async () => { order.push('contexts'); return 3; });
      mod.onPlanCleanup('unused');
      await new Promise((resolve) => setTimeout(resolve, 0));

      await cleanupCallback!();

      expect(order).toEqual(['sequences', 'contexts']);
      expect(mockPlanClearCompleted).not.toHaveBeenCalled();
    });

    it('keeps "Clear done plans" an individual action', async () => {
      const mod = await openScreen();
      mod.onPlanCleanup('done');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bulkCleanup.lines).toEqual([{ count: 2, noun: 'completed plan' }]);
      await cleanupCallback!();
      expect(mockPlanClearCompleted).toHaveBeenCalledWith('/test/dir');
      expect(mockPlanClearEmptySequences).not.toHaveBeenCalled();
      expect(mockPlanClearUnreferencedContexts).not.toHaveBeenCalled();
    });

    it('shows a notice instead of a dialog when there is nothing to clear', async () => {
      const mod = await openScreen();
      mod.onPlanCleanup('contexts');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bulkCleanup.visible).toBe(false);
      expect(mod.planScreenState.notice).toBe('Nothing to clear');
    });
  });

  it('clears planner state when hidden', async () => {
    const mod = await getModule();
    const item = { id: 'a', dirPath: '/test/dir', title: 'A', description: 'Alpha', status: 'planning', createdAt: 1, updatedAt: 1 };
    mockPlanList.mockResolvedValue([item]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));

    await mod.showPlanScreen('/test/dir');
    mod.hidePlanScreen();

    expect(mod.isPlanScreenVisible()).toBe(false);
    expect(mod.getSelectedPlanId()).toBeNull();
    expect(mod.getCurrentPlanDirPath()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut regression — Ctrl+Shift+N must not be hijacked
// ---------------------------------------------------------------------------

describe('plan screen keyboard shortcuts', () => {
  function dispatch(init: KeyboardEventInit): KeyboardEvent {
    const evt = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
    document.dispatchEvent(evt);
    return evt;
  }

  beforeEach(() => {
    vi.resetModules();
    (window as any).gamepadCli = {
      planList: vi.fn().mockResolvedValue([]),
      planDeps: vi.fn().mockResolvedValue([]),
      planContextList: vi.fn().mockResolvedValue([]),
      planSequenceList: vi.fn().mockResolvedValue([]),
      configGetPlanFilters: vi.fn().mockResolvedValue({
        types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' },
        hasAttachment: { yes: 'either', no: 'either' },
        auto: 'either',
      }),
    };
  });

  it('Ctrl+N is captured by the planner and prevented from propagating', async () => {
    const mod = await getModule();
    mod.planScreenState.visible = true;

    const evt = dispatch({ key: 'n', ctrlKey: true, shiftKey: false });

    expect(evt.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+N falls through — not captured by the planner', async () => {
    const mod = await getModule();
    mod.planScreenState.visible = true;

    const evt = dispatch({ key: 'N', ctrlKey: true, shiftKey: true });

    expect(evt.defaultPrevented).toBe(false);
  });

  it('Ctrl+Shift+n (lowercase key) also falls through', async () => {
    const mod = await getModule();
    mod.planScreenState.visible = true;

    const evt = dispatch({ key: 'n', ctrlKey: true, shiftKey: true });

    expect(evt.defaultPrevented).toBe(false);
  });

  it('plain N key is not captured', async () => {
    const mod = await getModule();
    mod.planScreenState.visible = true;

    const evt = dispatch({ key: 'n', ctrlKey: false, shiftKey: false });

    expect(evt.defaultPrevented).toBe(false);
  });
});
