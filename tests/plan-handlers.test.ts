/**
 * Tests for plan IPC handlers.
 *
 * Verifies plan:* channels route correctly to PlanManager methods
 * and plan:changed events forward to the renderer window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcMain before importing handler
const handlers = new Map<string, Function>();
const electronMockState = vi.hoisted(() => {
  const browserWindowInstances: Array<any> = [];
  const BrowserWindowMock = vi.fn(function BrowserWindow(this: any, options: Record<string, unknown>) {
    this.id = browserWindowInstances.length + 201;
    this.options = options;
    this.loadFile = vi.fn();
    this.on = vi.fn();
    this.webContents = { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    this.isDestroyed = vi.fn(() => false);
    this.isMinimized = vi.fn(() => false);
    this.restore = vi.fn();
    this.show = vi.fn();
    this.focus = vi.fn();
    browserWindowInstances.push(this);
  });
  const getAllWindows = vi.fn(() => []);
  return { browserWindowInstances, BrowserWindowMock, getAllWindows };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
  },
  BrowserWindow: Object.assign(electronMockState.BrowserWindowMock, {
    getAllWindows: electronMockState.getAllWindows,
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// PlanManager now self-saves — mock persistence so no disk I/O occurs
vi.mock('../src/session/persistence.js', () => ({
  savePlanFile: vi.fn(),
  deletePlanFile: vi.fn(),
  listPlanFiles: vi.fn(() => []),
  loadPlanFile: vi.fn(() => null),
  loadDependencies: vi.fn(() => []),
  saveDependencies: vi.fn(),
  cleanupOrphanDependencies: vi.fn(() => ({ removed: 0, deps: [] })),
  loadPlanSequences: vi.fn(() => []),
  savePlanSequences: vi.fn(),
  loadPlanContexts: vi.fn(() => []),
  savePlanContexts: vi.fn(),
  loadPlanContextBindings: vi.fn(() => []),
  savePlanContextBindings: vi.fn(),
}));

import { setupPlanHandlers } from '../src/electron/ipc/plan-handlers.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { ContextManager } from '../src/session/context-manager.js';

describe('plan IPC handlers', () => {
  let planManager: PlanManager;

  beforeEach(() => {
    handlers.clear();
    electronMockState.browserWindowInstances.length = 0;
    electronMockState.BrowserWindowMock.mockClear();
    electronMockState.getAllWindows.mockClear();
    planManager = new PlanManager();
    setupPlanHandlers(planManager);
  });

  // ─── Registration ─────────────────────────────────────

  it('registers all expected channels', () => {
    const expected = [
      'plan:list', 'plan:create', 'plan:update', 'plan:delete',
      'plan:addDep', 'plan:removeDep', 'plan:apply', 'plan:complete',
      'plan:setState', 'plan:startableForDir', 'plan:doingForSession', 'plan:popOut',
      'plan:getAllDoingForDir', 'plan:deps', 'plan:getItem',
    ];
    for (const channel of expected) {
      expect(handlers.has(channel), `missing handler for ${channel}`).toBe(true);
    }
  });

  // ─── CRUD ──────────────────────────────────────────────

  it('plan:create creates an item and returns it', async () => {
    const result = await handlers.get('plan:create')!({}, '/proj', 'Task 1', 'Description 1');
    expect(result).toMatchObject({ title: 'Task 1', description: 'Description 1', dirPath: '/proj' });
    expect(result.id).toBeDefined();
  });

  it('plan:list returns items for a directory', async () => {
    await handlers.get('plan:create')!({}, '/proj', 'A', '');
    await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:create')!({}, '/other', 'C', '');

    const items = await handlers.get('plan:list')!({}, '/proj');
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.title)).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('plan:update modifies title and/or description', async () => {
    const created = await handlers.get('plan:create')!({}, '/proj', 'Old', 'Old desc');
    const updated = await handlers.get('plan:update')!({}, created.id, { title: 'New' });
    expect(updated.title).toBe('New');
    expect(updated.description).toBe('Old desc');
  });

  it('plan:update returns null for unknown id', async () => {
    const result = await handlers.get('plan:update')!({}, 'nonexistent', { title: 'X' });
    expect(result).toBeNull();
  });

  it('plan:delete removes item and returns true', async () => {
    const created = await handlers.get('plan:create')!({}, '/proj', 'Gone', '');
    const result = await handlers.get('plan:delete')!({}, created.id);
    expect(result).toBe(true);

    const items = await handlers.get('plan:list')!({}, '/proj');
    expect(items).toHaveLength(0);
  });

  it('plan:delete returns false for unknown id', async () => {
    const result = await handlers.get('plan:delete')!({}, 'nonexistent');
    expect(result).toBe(false);
  });

  it('plan:getItem returns a single item or null', async () => {
    const created = await handlers.get('plan:create')!({}, '/proj', 'Find me', '');
    const found = await handlers.get('plan:getItem')!({}, created.id);
    expect(found.title).toBe('Find me');

    const missing = await handlers.get('plan:getItem')!({}, 'nope');
    expect(missing).toBeNull();
  });

  // ─── Dependencies ──────────────────────────────────────

  it('plan:addDep adds a dependency and returns true', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');

    const result = await handlers.get('plan:addDep')!({}, a.id, b.id);
    expect(result).toBe(true);
  });

  it('plan:addDep returns false for cross-directory items', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj1', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj2', 'B', '');

    const result = await handlers.get('plan:addDep')!({}, a.id, b.id);
    expect(result).toBe(false);
  });

  it('plan:removeDep removes a dependency and returns true', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:addDep')!({}, a.id, b.id);

    const result = await handlers.get('plan:removeDep')!({}, a.id, b.id);
    expect(result).toBe(true);
  });

  it('plan:removeDep returns false when dep does not exist', async () => {
    const result = await handlers.get('plan:removeDep')!({}, 'x', 'y');
    expect(result).toBe(false);
  });

  it('plan:deps returns dependency array for a directory', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:addDep')!({}, a.id, b.id);

    const deps = await handlers.get('plan:deps')!({}, '/proj');
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ fromId: a.id, toId: b.id });
  });

  it('plan:deps returns empty array for directory with no plans', async () => {
    const deps = await handlers.get('plan:deps')!({}, '/nowhere');
    expect(deps).toHaveLength(0);
  });

  // ─── Lifecycle ─────────────────────────────────────────

  it('plan:apply transitions ready → coding', async () => {
    const item = await handlers.get('plan:create')!({}, '/proj', 'Task', '');
    const applied = await handlers.get('plan:apply')!({}, item.id);
    expect(applied.status).toBe('coding');
  });

  it('plan:apply returns null for non-startable item', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:addDep')!({}, a.id, b.id);

    // B is pending (blocked by A), cannot apply
    const result = await handlers.get('plan:apply')!({}, b.id);
    expect(result).toBeNull();
  });

  it('plan:complete transitions doing → done', async () => {
    const item = await handlers.get('plan:create')!({}, '/proj', 'Task', '');
    await handlers.get('plan:apply')!({}, item.id);
    const completed = await handlers.get('plan:complete')!({}, item.id, 'Completed this task successfully');
    expect(completed.status).toBe('done');
    expect(completed.completionNotes).toBe('Completed this task successfully');
  });

  it('plan:complete returns null for non-doing item', async () => {
    const item = await handlers.get('plan:create')!({}, '/proj', 'Task', '');
    // item is startable, not doing
    const result = await handlers.get('plan:complete')!({}, item.id);
    expect(result).toBeNull();
  });

  it('plan:setState updates status and stateInfo', async () => {
    const item = await handlers.get('plan:create')!({}, '/proj', 'Task', '');
    await handlers.get('plan:apply')!({}, item.id);

    const updated = await handlers.get('plan:setState')!({}, item.id, 'blocked', 'Waiting on API');
    expect(updated.status).toBe('blocked');
    expect(updated.stateInfo).toBe('Waiting on API');
  });

  it('plan:popOut opens a detached planner window', async () => {
    const result = await handlers.get('plan:popOut')!({}, 'X:\\coding\\gamepad-cli-hub');
    expect(result).toEqual({ success: true, windowId: 201, reused: false });
    expect(electronMockState.BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(electronMockState.browserWindowInstances[0]?.loadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        query: { plannerPopOut: '1', dirPath: 'X:\\coding\\gamepad-cli-hub' },
      }),
    );
  });

  // ─── Queries ───────────────────────────────────────────

  it('plan:startableForDir returns only startable items', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:addDep')!({}, a.id, b.id);

    const startable = await handlers.get('plan:startableForDir')!({}, '/proj');
    expect(startable).toHaveLength(1);
    expect(startable[0].id).toBe(a.id);
  });

  it('plan:doingForSession returns active plans claimed by the session', async () => {
    const item = await handlers.get('plan:create')!({}, '/proj', 'Working', '');
    await handlers.get('plan:apply')!({}, item.id);
    planManager.claimPlan(item.id, 'session-abc');

    const doing = await handlers.get('plan:doingForSession')!({}, 'session-abc');
    expect(doing).toHaveLength(1);
    expect(doing[0].title).toBe('Working');
  });

  it('plan:doingForSession returns empty array when session has no claimed plans', async () => {
    await handlers.get('plan:create')!({}, '/proj', 'Pending', '');
    const doing = await handlers.get('plan:doingForSession')!({}, 'session-xyz');
    expect(doing).toHaveLength(0);
  });

  it('plan:getAllDoingForDir returns active plans', async () => {
    const first = await handlers.get('plan:create')!({}, '/proj', 'First', '');
    const second = await handlers.get('plan:create')!({}, '/proj', 'Second', '');
    await handlers.get('plan:apply')!({}, first.id);
    await handlers.get('plan:apply')!({}, second.id);

    const doing = await handlers.get('plan:getAllDoingForDir')!({}, '/proj');
    expect(doing).toHaveLength(2);
    expect(doing.map((item: any) => item.title)).toEqual(expect.arrayContaining(['First', 'Second']));
  });

  // ─── Cascading startable after completion ──────────────

  it('completing a dependency unblocks dependents', async () => {
    const a = await handlers.get('plan:create')!({}, '/proj', 'A', '');
    const b = await handlers.get('plan:create')!({}, '/proj', 'B', '');
    await handlers.get('plan:addDep')!({}, a.id, b.id);

    // B is planning (blocked by A)
    let bItem = (await handlers.get('plan:list')!({}, '/proj')).find((i: any) => i.id === b.id);
    expect(bItem.status).toBe('planning');

    // Complete A → B becomes ready
    await handlers.get('plan:apply')!({}, a.id);
    await handlers.get('plan:complete')!({}, a.id, 'Completed this task successfully');

    bItem = (await handlers.get('plan:list')!({}, '/proj')).find((i: any) => i.id === b.id);
    expect(bItem.status).toBe('ready');
  });
});

describe('plan cleanup IPC handlers (P-0805)', () => {
  let planManager: PlanManager;
  let contextManager: ContextManager;
  const projectStore = {
    resolveForPath: vi.fn((dirPath: string) => ({ id: dirPath === '/proj' ? 'project-1' : 'project-2' })),
    findByPath: vi.fn((dirPath: string) => ({ id: dirPath === '/proj' ? 'project-1' : 'project-2' })),
    getById: vi.fn((id: string) => ({ canonicalPath: id === 'project-1' ? '/proj' : '/other' })),
    save: vi.fn(),
  } as any;

  beforeEach(() => {
    handlers.clear();
    planManager = new PlanManager(projectStore);
    contextManager = new ContextManager(planManager);
    setupPlanHandlers(planManager, contextManager);
  });

  it('counts, then clears, empty sequences before unreferenced contexts', async () => {
    const item = planManager.create('/proj', 'Step', '');
    const used = planManager.createSequence('/proj', 'Used');
    planManager.assignSequence(item.id, used.id);
    const empty = planManager.createSequence('/proj', 'Empty');
    const boundToEmpty = contextManager.create('project-1', { title: 'Bound to the empty sequence' });
    contextManager.bind(boundToEmpty.id, 'sequence', empty.id);
    const boundToPlan = contextManager.create('project-1', { title: 'Bound to a plan' });
    contextManager.bind(boundToPlan.id, 'plan', item.id);
    contextManager.create('project-2', { title: 'Other project' });

    // The context bound to the empty sequence is not unreferenced YET.
    expect(await handlers.get('plan:cleanup-counts')!({}, '/proj')).toEqual({
      donePlans: 0, emptySequences: 1, unreferencedContexts: 0, unusedContexts: 1,
    });

    expect(await handlers.get('plan:clear-empty-sequences')!({}, '/proj')).toBe(1);
    // Deleting the sequence released its binding, so the context is now unreferenced.
    expect(await handlers.get('plan:cleanup-counts')!({}, '/proj')).toMatchObject({ unreferencedContexts: 1 });
    expect(await handlers.get('plan:clear-unreferenced-contexts')!({}, '/proj')).toBe(1);

    expect(planManager.getSequence(used.id)).not.toBeNull();
    expect(contextManager.get(boundToEmpty.id)).toBeNull();
    expect(contextManager.get(boundToPlan.id)).not.toBeNull();
    expect(contextManager.listForProject('project-2')).toHaveLength(1);
  });
});
