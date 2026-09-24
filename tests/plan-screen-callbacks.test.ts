/**
 * Plan screen callback registry tests — window-keyed isolation.
 *
 * Verifies that main window and pop-out window do not fight over
 * global singleton editor callbacks.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const mockPlanExportDirectory = vi.fn();
const mockPlanWriteFile = vi.fn();
const mockPlanReadFile = vi.fn();
const mockPlanClearCompleted = vi.fn();
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

async function getModule() {
  return await import('../renderer/plans/plan-screen.js');
}

describe('plan screen window-keyed callbacks', () => {
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
    mockPlanExportDirectory.mockReset();
    mockPlanWriteFile.mockReset();
    mockPlanReadFile.mockReset();
    mockPlanClearCompleted.mockReset();
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
      planSequenceAssign: mockPlanSequenceAssign,
      planExportDirectory: mockPlanExportDirectory,
      planWriteFile: mockPlanWriteFile,
      planReadFile: mockPlanReadFile,
      planClearCompleted: mockPlanClearCompleted,
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

    // Default to main window
    Object.defineProperty(window, 'location', {
      value: { search: '' },
      writable: true,
    });
  });

  it('keeps main and pop-out editor callbacks isolated', async () => {
    const mod = await getModule();
    const mainOpener = vi.fn();
    const popoutOpener = vi.fn();

    // Main window registers its opener
    Object.defineProperty(window, 'location', { value: { search: '' }, writable: true });
    mod.setPlanEditorOpener(mainOpener);

    // Pop-out window registers its own opener
    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/test/dir' }, writable: true });
    mod.setPlanEditorOpener(popoutOpener);

    // Simulate a plan node click in the main window
    Object.defineProperty(window, 'location', { value: { search: '' }, writable: true });
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    // Main opener should have been called, not pop-out
    expect(mainOpener).toHaveBeenCalled();
    expect(popoutOpener).not.toHaveBeenCalled();

    // Now simulate in the pop-out window
    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/test/dir' }, writable: true });
    // Note: we need to remount because showPlanScreen was already called in main context
    // The callback lookup happens at invocation time, so this should work
    mod.handlePlanScreenAction('A');

    expect(popoutOpener).toHaveBeenCalled();
  });

  it('keeps draft editor closers isolated per window', async () => {
    const mod = await getModule();
    const mainCloser = vi.fn();
    const popoutCloser = vi.fn();

    Object.defineProperty(window, 'location', { value: { search: '' }, writable: true });
    mod.setDraftEditorCloser(mainCloser);

    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/test/dir' }, writable: true });
    mod.setDraftEditorCloser(popoutCloser);

    // Trigger Escape key handler in main window
    Object.defineProperty(window, 'location', { value: { search: '' }, writable: true });
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    await mod.showPlanScreen('/test/dir');
    mod.planScreenState.editingId = 'a';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(mainCloser).toHaveBeenCalled();
    expect(popoutCloser).not.toHaveBeenCalled();
  });

  // The registry keys on the full window identity, so two planner pop-outs on
  // different directories are two windows, not one shared "popout" bucket.
  it('keeps two planner pop-outs on different directories isolated', async () => {
    const mod = await getModule();
    const firstOpener = vi.fn();
    const secondOpener = vi.fn();

    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/dir/one' }, writable: true });
    mod.setPlanEditorOpener(firstOpener);

    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/dir/two' }, writable: true });
    mod.setPlanEditorOpener(secondOpener);

    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1&dirPath=/dir/one' }, writable: true });
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    expect(firstOpener).toHaveBeenCalled();
    expect(secondOpener).not.toHaveBeenCalled();
  });

  // A pop-out flag with no dirPath has no target to key on; falling back to the
  // main window's callbacks is what keeps it from stranding its editors.
  it('treats a targetless pop-out URL as the main window', async () => {
    const mod = await getModule();
    const mainOpener = vi.fn();

    Object.defineProperty(window, 'location', { value: { search: '' }, writable: true });
    mod.setPlanEditorOpener(mainOpener);

    Object.defineProperty(window, 'location', { value: { search: '?plannerPopOut=1' }, writable: true });
    mockPlanList.mockResolvedValue([planItem('a')]);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(fakeLayout(['a']));
    await mod.showPlanScreen('/test/dir');
    mod.handlePlanScreenAction('A');

    expect(mainOpener).toHaveBeenCalled();
  });
});
