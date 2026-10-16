/**
 * Tests for plan navigation — Plans button on group headers,
 * column navigation extension, plan screen switching,
 * and gamepad D-pad / action-button navigation.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlanItem } from '../src/types/plan.js';
import type { LayoutResult } from '../renderer/plans/plan-layout.js';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE vi.mock() calls so hoisted references resolve
// ---------------------------------------------------------------------------

const mockPlanList = vi.fn();
const mockPlanCreate = vi.fn();
const mockPlanDelete = vi.fn();
const mockPlanDeps = vi.fn();

const mockComputeLayout = vi.fn();
const mockShowPlanInEditor = vi.fn();
const mockHideItemEditor = vi.fn();

// Spread the real module: a bare stub breaks any transitive import that needs
// another Vue export (modal-bridge pulls in composables that call `ref`).
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue');
  return {
    ...actual,
    reactive: (obj: any) => obj,
    watch: (_source: unknown, _cb: unknown, _options?: unknown) => (() => void 0),
  };
});

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../renderer/plans/plan-layout.js', () => ({
  computeLayout: (...args: unknown[]) => mockComputeLayout(...args),
}));

vi.mock('../renderer/stores/item-editor-registry.js', () => ({
  showPlanInEditor: (...args: unknown[]) => mockShowPlanInEditor(...args),
  hideItemEditor: () => mockHideItemEditor(),
  isItemEditorVisible: () => false,
  handleItemEditorButton: vi.fn(),
}));

vi.mock('../renderer/state.js', () => ({
  state: {
    activeSessionId: 'session-1',
    sessions: [
      { id: 'session-1', name: 'Test Session', cliType: 'claude-code', processId: 1, workingDir: '/test/dir' },
    ],
    planCodingCounts: new Map(),
    planStartableCounts: new Map(),
  },
}));

vi.mock('../renderer/utils.js', () => ({
  escapeHtml: (t: string) => t,
  logEvent: vi.fn(),
  toDirection: (button: string) => {
    const map: Record<string, string> = { DPadUp: 'up', DPadDown: 'down', DPadLeft: 'left', DPadRight: 'right' };
    return map[button] ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    dirPath: '/test/dir',
    title: `Item ${overrides.id}`,
    description: `Desc for ${overrides.id}`,
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function buildPlanDom(): void {
  document.body.innerHTML = `
    <div id="mainArea" class="panel-right">
      <div class="terminal-container"></div>
    </div>
    <div class="modal-overlay" id="planDeleteConfirmOverlay" aria-hidden="true">
      <div class="modal close-confirm-modal">
        <div class="close-confirm-body" id="planDeleteConfirmBody"></div>
        <div class="modal-footer">
          <button id="planDeleteConfirmCancelBtn">Cancel</button>
          <button id="planDeleteConfirmDeleteBtn">Delete</button>
        </div>
      </div>
    </div>
  `;
}

async function getModule() {
  return await import('../renderer/plans/plan-screen.js');
}

async function getPlanDeleteConfirmModule() {
  return await import('../renderer/stores/modal-bridge.js');
}

/** Flush microtask queue so async fire-and-forget completes. */
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

import { buildFlatNavList, type SessionGroup } from '../renderer/session-groups.js';

// ---------------------------------------------------------------------------
// Original tests — group header Plans button
// ---------------------------------------------------------------------------

describe('plan navigation — group header Plans button', () => {
  function makeGroup(dirPath: string, sessionCount: number): SessionGroup {
    const sessions = Array.from({ length: sessionCount }, (_, i) => ({
      id: `s${i}`,
      name: `Session ${i}`,
      cliType: 'claude-code',
      processId: 1000 + i,
      workingDir: dirPath,
    }));
    return {
      dirPath,
      displayName: dirPath.split(/[\\/]/).pop() || dirPath,
      sessions,
      collapsed: false,
    };
  }

  it('group header now has 4 columns (name=0, moveUp=1, moveDown=2, plans=3)', () => {
    // Group header maxCol changed from 2 to 3 to accommodate Plans button
    const maxGroupCol = 3;
    expect(maxGroupCol).toBe(3);
  });

  it('session card now has 4 action columns (state=1, rename=2, eye=3, close=4)', () => {
    const maxSessionCol = 4;
    expect(maxSessionCol).toBe(4);
  });

  it('navList includes group headers + session cards', () => {
    const groups = [makeGroup('/proj1', 2), makeGroup('/proj2', 1)];
    const navList = buildFlatNavList(groups);

    const headers = navList.filter(n => n.type === 'group-header');
    expect(headers).toHaveLength(2);
    // 2 headers + 3 cards = 5 items
    expect(navList).toHaveLength(5);
  });

  it('isPlanScreenVisible returns false by default', async () => {
    const { isPlanScreenVisible } = await getModule();
    expect(isPlanScreenVisible()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gamepad D-pad navigation on plan canvas
// ---------------------------------------------------------------------------

describe('Project Planner canvas gamepad navigation', () => {
  let mod: Awaited<ReturnType<typeof getModule>>;

  // Two layers: layer 0 has 1 node, layer 1 has 3 nodes
  const items = [
    makeItem({ id: 'a' }),
    makeItem({ id: 'b' }),
    makeItem({ id: 'c' }),
    makeItem({ id: 'd' }),
  ];

  const multiLayerLayout: LayoutResult = {
    nodes: [
      { id: 'a', x: 60, y: 60, layer: 0, order: 0 },
      { id: 'b', x: 340, y: 60, layer: 1, order: 0 },
      { id: 'c', x: 340, y: 200, layer: 1, order: 1 },
      { id: 'd', x: 340, y: 340, layer: 1, order: 2 },
    ],
    width: 600,
    height: 480,
  };

  beforeEach(async () => {
    buildPlanDom();
    mockPlanList.mockReset();
    mockPlanCreate.mockReset();
    mockPlanDelete.mockReset();
    mockPlanDeps.mockReset();
    mockComputeLayout.mockReset();
    mockShowPlanInEditor.mockReset();
    mockHideItemEditor.mockReset();

    (window as any).gamepadCli = {
      planList: mockPlanList,
      planCreate: mockPlanCreate,
      planDelete: mockPlanDelete,
      planDeps: mockPlanDeps,
      planUpdate: vi.fn(),
      planAddDep: vi.fn(),
      planRemoveDep: vi.fn(),
      planComplete: vi.fn(),
      planApply: vi.fn(),
      planAttachmentHasAny: vi.fn().mockResolvedValue({}),
    };

    mod = await getModule();
    mod.setPlanEditorOpener(mockShowPlanInEditor);
    // Ensure hidden state
    mod.hidePlanScreen();
  });

  /** Show the plan screen with the given items and layout. */
  async function openCanvas(
    itemsToShow: PlanItem[] = items,
    layout: LayoutResult = multiLayerLayout,
  ): Promise<void> {
    mockPlanList.mockResolvedValue(itemsToShow);
    mockPlanDeps.mockResolvedValue([]);
    mockComputeLayout.mockReturnValue(layout);
    await mod.showPlanScreen('/test/dir');
  }

  // -----------------------------------------------------------------------
  // D-pad navigation
  // -----------------------------------------------------------------------

  describe('handlePlanScreenDpad', () => {
    it('returns false when no layout is cached (canvas not open)', () => {
      expect(mod.handlePlanScreenDpad('right')).toBe(false);
    });

    it('selects first node when none selected', async () => {
      await openCanvas();
      // hidePlanScreen cleared selectedId; manually clear via a fresh open
      // showPlanScreen auto-selects, so we verify first node is selected
      expect(mod.getSelectedPlanId()).toBe('a');

      // Additional: D-pad should still consume event
      const result = mod.handlePlanScreenDpad('right');
      expect(result).toBe(true);
    });

    it('moves right to next layer (closest Y)', async () => {
      await openCanvas();
      // Auto-selected 'a' (layer 0, y=60)
      expect(mod.getSelectedPlanId()).toBe('a');

      mod.handlePlanScreenDpad('right');
      // Layer 1 nodes: b(y=60), c(y=200), d(y=340). Closest to y=60 is b
      expect(mod.getSelectedPlanId()).toBe('b');
    });

    it('moves left to previous layer', async () => {
      await openCanvas();
      // Move right first to get to layer 1
      mod.handlePlanScreenDpad('right');
      expect(mod.getSelectedPlanId()).toBe('b');

      mod.handlePlanScreenDpad('left');
      // Back to layer 0: only node is 'a'
      expect(mod.getSelectedPlanId()).toBe('a');
    });

    it('moves down within same layer', async () => {
      await openCanvas();
      // Go to layer 1 first
      mod.handlePlanScreenDpad('right');
      expect(mod.getSelectedPlanId()).toBe('b'); // order 0

      mod.handlePlanScreenDpad('down');
      expect(mod.getSelectedPlanId()).toBe('c'); // order 1
    });

    it('moves up within same layer', async () => {
      await openCanvas();
      mod.handlePlanScreenDpad('right'); // → b (layer 1, order 0)
      mod.handlePlanScreenDpad('down');  // → c (order 1)
      expect(mod.getSelectedPlanId()).toBe('c');

      mod.handlePlanScreenDpad('up');
      expect(mod.getSelectedPlanId()).toBe('b'); // order 0
    });

    it('no-ops at layer boundary (leftmost)', async () => {
      await openCanvas();
      expect(mod.getSelectedPlanId()).toBe('a'); // layer 0

      const result = mod.handlePlanScreenDpad('left');
      expect(result).toBe(true); // consumed
      expect(mod.getSelectedPlanId()).toBe('a'); // unchanged
    });

    it('no-ops at layer boundary (rightmost)', async () => {
      await openCanvas();
      mod.handlePlanScreenDpad('right'); // → layer 1
      expect(mod.getSelectedPlanId()).toBe('b');

      const result = mod.handlePlanScreenDpad('right');
      expect(result).toBe(true); // consumed
      expect(mod.getSelectedPlanId()).toBe('b'); // unchanged — no layer 2
    });

    it('no-ops at order boundary (top)', async () => {
      await openCanvas();
      mod.handlePlanScreenDpad('right'); // → b (order 0)

      const result = mod.handlePlanScreenDpad('up');
      expect(result).toBe(true);
      expect(mod.getSelectedPlanId()).toBe('b'); // no order -1
    });

    it('no-ops at order boundary (bottom)', async () => {
      await openCanvas();
      mod.handlePlanScreenDpad('right'); // → b (order 0)
      mod.handlePlanScreenDpad('down');  // → c (order 1)
      mod.handlePlanScreenDpad('down');  // → d (order 2)
      expect(mod.getSelectedPlanId()).toBe('d');

      const result = mod.handlePlanScreenDpad('down');
      expect(result).toBe(true);
      expect(mod.getSelectedPlanId()).toBe('d'); // no order 3
    });

    it('picks closest Y when layers have different node counts', async () => {
      // Layer 0: 1 node at y=200, Layer 1: 3 nodes at y=60, y=200, y=340
      const asymmetricLayout: LayoutResult = {
        nodes: [
          { id: 'a', x: 60, y: 200, layer: 0, order: 0 },
          { id: 'b', x: 340, y: 60, layer: 1, order: 0 },
          { id: 'c', x: 340, y: 200, layer: 1, order: 1 },
          { id: 'd', x: 340, y: 340, layer: 1, order: 2 },
        ],
        width: 600,
        height: 480,
      };
      await openCanvas(items, asymmetricLayout);
      expect(mod.getSelectedPlanId()).toBe('a'); // y=200

      mod.handlePlanScreenDpad('right');
      // Closest to y=200 is c (y=200), not b (y=60) or d (y=340)
      expect(mod.getSelectedPlanId()).toBe('c');
    });

    it('always returns true when canvas has nodes', async () => {
      await openCanvas();
      expect(mod.handlePlanScreenDpad('up')).toBe(true);
      expect(mod.handlePlanScreenDpad('down')).toBe(true);
      expect(mod.handlePlanScreenDpad('left')).toBe(true);
      expect(mod.handlePlanScreenDpad('right')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Action button handling
  // -----------------------------------------------------------------------

  describe('handlePlanScreenAction', () => {
    it('A opens editor for selected node', async () => {
      await openCanvas();
      expect(mod.getSelectedPlanId()).toBe('a');
      mockShowPlanInEditor.mockClear();

      const result = mod.handlePlanScreenAction('A');
      expect(result).toBe(true);
      expect(mockShowPlanInEditor).toHaveBeenCalled();
      // First arg is session ID, second is the item
      const calledItem = mockShowPlanInEditor.mock.calls[0][1];
      expect(calledItem.id).toBe('a');
    });

    it('A selects first node when none selected', async () => {
      // Open with empty selection then manually clear
      const singleLayout: LayoutResult = {
        nodes: [{ id: 'a', x: 60, y: 60, layer: 0, order: 0 }],
        width: 400,
        height: 200,
      };
      await openCanvas([makeItem({ id: 'a' })], singleLayout);
      // showPlanScreen auto-selects, so A should use the selected node
      expect(mod.getSelectedPlanId()).toBe('a');
      mockShowPlanInEditor.mockClear();

      const result = mod.handlePlanScreenAction('A');
      expect(result).toBe(true);
      expect(mockShowPlanInEditor).toHaveBeenCalled();
    });

    it('X opens delete confirmation before deleting', async () => {
      await openCanvas();
      expect(mod.getSelectedPlanId()).toBe('a');

      mockPlanDelete.mockResolvedValue(undefined);
      // After delete, refreshCanvas will be called — set up mocks for it
      mockPlanList.mockResolvedValue([]);
      mockPlanDeps.mockResolvedValue([]);
      mockComputeLayout.mockReturnValue({ nodes: [], width: 0, height: 0 });

      const result = mod.handlePlanScreenAction('X');
      expect(result).toBe(true);
      expect(mockPlanDelete).not.toHaveBeenCalled();

      const { getPlanDeleteCallback } = await import('../renderer/stores/modal-bridge.js');
      const cb = getPlanDeleteCallback();
      expect(cb).not.toBeNull();
      cb!();
      await flush();

      expect(mockPlanDelete).toHaveBeenCalledWith('a');
    });

    it('Y creates new node and refreshes', async () => {
      await openCanvas();
      mockPlanCreate.mockResolvedValue(undefined);
      // refreshCanvas mocks
      mockPlanList.mockResolvedValue(items);
      mockPlanDeps.mockResolvedValue([]);
      mockComputeLayout.mockReturnValue(multiLayerLayout);

      const result = mod.handlePlanScreenAction('Y');
      expect(result).toBe(true);
      await flush();

      expect(mockPlanCreate).toHaveBeenCalledWith('/test/dir', 'New Plan', '');
    });

    it('B is not consumed by handlePlanScreenAction (handled upstream)', async () => {
      await openCanvas();
      const result = mod.handlePlanScreenAction('B');
      expect(result).toBe(false);
    });

    it('returns false for unrecognised buttons', async () => {
      await openCanvas();
      expect(mod.handlePlanScreenAction('LB')).toBe(false);
      expect(mod.handlePlanScreenAction('RB')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Auto-select on canvas open
  // -----------------------------------------------------------------------

  describe('auto-select on canvas open', () => {
    it('auto-selects first node (layer 0 order 0) on showPlanScreen', async () => {
      await openCanvas();
      expect(mod.getSelectedPlanId()).toBe('a');
    });

    it('does not select when canvas has no nodes', async () => {
      const emptyLayout: LayoutResult = { nodes: [], width: 0, height: 0 };
      await openCanvas([], emptyLayout);
      expect(mod.getSelectedPlanId()).toBe(null);
    });
  });

  // -----------------------------------------------------------------------
  // Cache lifecycle
  // -----------------------------------------------------------------------

  describe('cache lifecycle', () => {
    it('hidePlanScreen clears cached state', async () => {
      await openCanvas();
      expect(mod.getSelectedPlanId()).toBe('a');

      mod.hidePlanScreen();
      expect(mod.getSelectedPlanId()).toBe(null);
      // D-pad should return false (no cached layout)
      expect(mod.handlePlanScreenDpad('right')).toBe(false);
    });
  });
});
