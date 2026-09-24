/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const planList = vi.fn();
const planDeps = vi.fn();
const planSequenceList = vi.fn();
const planContextList = vi.fn();
const planAttachmentHasAny = vi.fn();
const fakeState = {
  activeSessionId: 'session-a',
  sessions: [
    { id: 'session-a', workingDir: 'C:/repo/a' },
    { id: 'session-b', workingDir: 'C:/repo/b' },
  ],
};

vi.mock('../renderer/state.js', () => ({ state: fakeState }));
vi.mock('../renderer/plans/plan-layout.js', () => ({
  computeLayout: (items: Array<{ id: string }>) => ({
    nodes: items.map((item, index) => ({ id: item.id, x: index, y: 0, layer: index, order: 0 })),
    width: items.length,
    height: 1,
  }),
}));
vi.mock('../renderer/stores/modal-bridge.js', () => ({
  bulkCleanup: { title: '', lines: [], dirName: '', visible: false },
  hidePlanDeleteConfirm: vi.fn(),
  showPlanDeleteConfirm: vi.fn(),
  setBulkCleanupCallback: vi.fn(),
  showPlanHelpModal: vi.fn(),
  hidePlanHelpModal: vi.fn(),
  isPlanHelpVisible: () => false,
}));
vi.mock('../renderer/main-view/main-view-manager.js', () => ({
  currentView: () => 'terminal',
  registerView: vi.fn(),
  showView: vi.fn(),
}));
const registeredKeyHandlers = vi.hoisted(() => [] as Array<{
  claims?: (ctx: any) => boolean;
  handle: (ctx: any) => boolean;
}>);
vi.mock('../renderer/keyboard/router.js', () => ({
  registerKeyHandler: vi.fn((handler) => {
    registeredKeyHandlers.push(handler);
    return vi.fn();
  }),
}));
vi.mock('../renderer/sequence-delivery.js', () => ({ deliverPromptSequence: vi.fn() }));

async function getModule() {
  return import('../renderer/plans/plan-screen.js');
}

function item(dirPath: string) {
  return { id: dirPath, dirPath, title: dirPath, description: '', status: 'planning', createdAt: 1, updatedAt: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  registeredKeyHandlers.length = 0;
  fakeState.activeSessionId = 'session-a';
  planList.mockReset();
  planDeps.mockReset().mockResolvedValue([]);
  planSequenceList.mockReset().mockResolvedValue([]);
  planContextList.mockReset().mockResolvedValue([]);
  planAttachmentHasAny.mockReset().mockResolvedValue({});
  (window as any).helmPlatform = 'win32';
  (window as any).gamepadCli = {
    planList,
    planDeps,
    planSequenceList,
    planContextList,
    planAttachmentHasAny,
    configGetPlanFilters: vi.fn().mockResolvedValue({}),
    configSetPlanFilters: vi.fn().mockResolvedValue(undefined),
  };
});

describe('plan screen session binding', () => {
  it('reloads when the selected session changes while the pane is mounted', async () => {
    planList.mockImplementation(async (dirPath: string) => [item(dirPath)]);
    const mod = await getModule();

    await mod.bindPlanScreenToDir('C:/repo/a');
    fakeState.activeSessionId = 'session-b';
    await mod.bindPlanScreenToDir('C:/repo/b');

    expect(mod.planScreenState.currentDir).toBe('C:/repo/b');
    expect(planList).toHaveBeenCalledWith('C:/repo/b');
    expect(mod.planScreenState.items).toEqual([item('C:/repo/b')]);
  });

  it('does not refetch when only case or separators differ in the same directory', async () => {
    planList.mockImplementation(async (dirPath: string) => [item(dirPath)]);
    const mod = await getModule();

    await mod.bindPlanScreenToDir('C:\\Repo\\App');
    await mod.bindPlanScreenToDir('c:/repo/app');

    expect(planList).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow load for the old session overwrite the new session', async () => {
    const oldLoad = deferred<ReturnType<typeof item>[]>();
    planList.mockImplementation((dirPath: string) => dirPath === 'C:/repo/a' ? oldLoad.promise : Promise.resolve([item(dirPath)]));
    const mod = await getModule();

    const oldBinding = mod.bindPlanScreenToDir('C:/repo/a');
    const newBinding = mod.bindPlanScreenToDir('C:/repo/b');
    await newBinding;
    oldLoad.resolve([item('C:/repo/a')]);
    await oldBinding;

    expect(mod.planScreenState.currentDir).toBe('C:/repo/b');
    expect(mod.planScreenState.items).toEqual([item('C:/repo/b')]);
  });

  it('clears the canvas when the selected session disappears', async () => {
    planList.mockImplementation(async (dirPath: string) => [item(dirPath)]);
    const mod = await getModule();

    await mod.bindPlanScreenToDir('C:/repo/a');
    await mod.bindPlanScreenToDir(null);

    expect(mod.planScreenState.currentDir).toBe('');
    expect(mod.planScreenState.items).toEqual([]);
  });

  it('routes plan shortcuts only while the focused dock pane owns the canvas', async () => {
    planList.mockImplementation(async (dirPath: string) => [item(dirPath)]);
    const mod = await getModule();
    await mod.bindPlanScreenToDir('C:/repo/a');
    mod.setPlanScreenPaneMounted(true);

    const handler = registeredKeyHandlers.find((entry) => entry.handle);
    expect(handler).toBeDefined();

    const focusedContext = {
      key: 'Escape',
      isFocused: (pane: string) => pane === 'plan-screen',
    };
    expect(handler!.claims?.(focusedContext)).toBe(true);
    expect(handler!.handle(focusedContext)).toBe(true);

    const unfocusedContext = {
      key: 'Escape',
      isFocused: () => false,
    };
    expect(handler!.claims?.(unfocusedContext)).toBe(false);
  });

  it('binds a mounted dock canvas without depending on the overlay visible flag', async () => {
    planList.mockImplementation(async (dirPath: string) => [item(dirPath)]);
    const mod = await getModule();
    mod.planScreenState.visible = false;

    await mod.bindPlanScreenToDir('C:/repo/a');

    expect(mod.planScreenState.currentDir).toBe('C:/repo/a');
    expect(mod.planScreenState.items).toEqual([item('C:/repo/a')]);
  });
});
