import { describe, it, expect } from 'vitest';
import {
  createDefaultLayout,
  listPanes,
  listFocusablePanes,
  isDockCollapsed,
  findPaneGroup,
  isPaneHidden,
  movePane,
  dockPaneToEdge,
  canDropPane,
  canDockPaneToEdge,
  canReorderTab,
  reorderTab,
  setActiveTab,
  setDockMode,
  closePane,
  restorePane,
  normalizeNode,
  resizeSplit,
  validateLayout,
} from '../renderer/dock-layout';
import {
  DOCK_LAYOUT_VERSION,
  DOCK_PANES,
  OUTER_EDGE_RATIO,
  PANE_ARTIFACTS,
  PANE_OVERVIEW,
  PANE_PLAN_DIRECTORIES,
  PANE_PLAN_SCREEN,
  PANE_MEMORIES,
  PANE_MESS,
  PANE_QUICK_SPAWN,
  PANE_SCHEDULER,
  PANE_SESSIONS,
  PANE_TERMINAL,
  type DockNode,
  type DockSide,
  type DockSplitNode,
  type DockWorkspaceLayout,
} from '../renderer/dock-types';

function group(tabs: string[], activeTab = tabs[0]): DockNode {
  return { type: 'group', tabs, activeTab };
}

function layoutOf(root: DockNode, closed: string[] = []): DockWorkspaceLayout {
  return { version: DOCK_LAYOUT_VERSION, root, closed };
}

/** Which edge dock a pane sits under, or null when it lives in the centre. */
function findDockSideOf(node: DockNode, paneId: string): DockSide | null {
  if (node.type === 'dock') {
    return listPanes(node.child).includes(paneId) ? node.side : null;
  }
  if (node.type === 'split') {
    for (const child of node.children) {
      const side = findDockSideOf(child, paneId);
      if (side) return side;
    }
  }
  return null;
}

describe('default Classic layout', () => {
  const layout = createDefaultLayout();

  it('registers every pane exactly once', () => {
    const panes = listPanes(layout.root);
    expect([...panes].sort()).toEqual(DOCK_PANES.map(p => p.id).sort());
    expect(layout.closed).toEqual([]);
    expect(layout.version).toBe(DOCK_LAYOUT_VERSION);
  });

  it('validates as a well-formed layout', () => {
    expect(() => validateLayout(JSON.parse(JSON.stringify(layout)))).not.toThrow();
  });

  it('keeps Team View beside the terminal rather than tabbed behind it', () => {
    // A roster whose job is switching sessions cannot be a tab that loses to the
    // terminal it switches to.
    const terminalGroup = findPaneGroup(layout.root, PANE_TERMINAL);
    expect(terminalGroup?.tabs).not.toContain(PANE_OVERVIEW);
    const teamGroup = findPaneGroup(layout.root, PANE_OVERVIEW);
    expect(teamGroup?.activeTab).toBe(PANE_OVERVIEW);
    expect(findDockSideOf(layout.root, PANE_OVERVIEW)).toBeNull();
  });

  it('places sessions/tools left, views centre, artifacts right', () => {
    // Deterministic left-to-right, top-to-bottom order mirrors the current UI.
    expect(listPanes(layout.root)).toEqual([
      PANE_SESSIONS,
      PANE_SCHEDULER,
      PANE_QUICK_SPAWN,
      PANE_PLAN_DIRECTORIES,
      PANE_TERMINAL,
      PANE_PLAN_SCREEN,
      PANE_MEMORIES,
      PANE_MESS,
      PANE_OVERVIEW,
      PANE_ARTIFACTS,
    ]);
  });

  it('keeps the terminal active and artifacts collapsed to an edge rail', () => {
    const terminalGroup = findPaneGroup(layout.root, PANE_TERMINAL);
    expect(terminalGroup?.activeTab).toBe(PANE_TERMINAL);
    const artifactsDock = findDock(layout.root, PANE_ARTIFACTS);
    expect(artifactsDock).toMatchObject({ side: 'right', mode: 'autohide' });
  });

  it('walks only pinned panes for focus cycling', () => {
    expect(listFocusablePanes(layout.root)).toEqual([
      PANE_SESSIONS,
      PANE_SCHEDULER,
      PANE_QUICK_SPAWN,
      PANE_PLAN_DIRECTORIES,
      PANE_TERMINAL,
      PANE_PLAN_SCREEN,
      PANE_MEMORIES,
      PANE_MESS,
      PANE_OVERVIEW,
    ]);
  });

  it('treats a revealed autohide dock as focusable and an unrevealed one as collapsed', () => {
    const artifactsDockNode = (layout.root as { children: DockNode[] }).children
      .find(child => child.type === 'dock' && listPanes(child).includes(PANE_ARTIFACTS))!;

    expect(isDockCollapsed(artifactsDockNode)).toBe(true);
    expect(listFocusablePanes(layout.root)).not.toContain(PANE_ARTIFACTS);

    expect(isDockCollapsed(artifactsDockNode, [PANE_ARTIFACTS])).toBe(false);
    expect(listFocusablePanes(layout.root, [PANE_ARTIFACTS])).toContain(PANE_ARTIFACTS);
  });

  it('keeps a dock uncollapsed while it holds the focused pane', () => {
    const artifactsDockNode = (layout.root as { children: DockNode[] }).children
      .find(child => child.type === 'dock' && listPanes(child).includes(PANE_ARTIFACTS))!;

    expect(isDockCollapsed(artifactsDockNode, [], PANE_ARTIFACTS)).toBe(false);
    expect(isDockCollapsed(artifactsDockNode, [], PANE_TERMINAL)).toBe(true);
  });

  it('collapses a hidden dock even when it is revealed or focused', () => {
    const hidden = setDockMode(layout, PANE_ARTIFACTS, 'hidden');
    const hiddenDock = (hidden.root as { children: DockNode[] }).children
      .find(child => child.type === 'dock' && listPanes(child).includes(PANE_ARTIFACTS))!;

    expect(isDockCollapsed(hiddenDock, [PANE_ARTIFACTS], PANE_ARTIFACTS)).toBe(true);
    expect(listFocusablePanes(hidden.root, [PANE_ARTIFACTS])).not.toContain(PANE_ARTIFACTS);
  });
});

function findDock(node: DockNode, paneId: string): { side: string; mode: string } | null {
  if (node.type === 'dock') {
    if (listPanes(node.child).includes(paneId)) return { side: node.side, mode: node.mode };
    return null;
  }
  if (node.type === 'split') {
    for (const child of node.children) {
      const hit = findDock(child, paneId);
      if (hit) return hit;
    }
  }
  return null;
}

describe('movePane', () => {
  it('tabs a pane into the target group on a center drop', () => {
    const layout = layoutOf({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    });

    const next = movePane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'center' });

    // The emptied group is cleaned up and the single-child split collapses.
    expect(next.root).toEqual({ type: 'group', tabs: [PANE_TERMINAL, PANE_OVERVIEW], activeTab: PANE_OVERVIEW });
    expect(layout.root.type).toBe('split'); // input untouched
  });

  it('splits a new group before/after the target for edge drops', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW]));

    const right = movePane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'right' });
    expect(right.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    });

    const top = movePane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'top' });
    expect(top.root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [group([PANE_OVERVIEW]), group([PANE_TERMINAL])],
    });
  });

  it('restores a closed pane by moving it back into the tree', () => {
    const layout = layoutOf(group([PANE_TERMINAL]), [PANE_OVERVIEW]);

    const next = movePane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'center' });

    expect(next.closed).toEqual([]);
    expect(listPanes(next.root)).toEqual([PANE_TERMINAL, PANE_OVERVIEW]);
  });

  it('rejects unknown panes, unknown targets and self-drops', () => {
    const layout = createDefaultLayout();
    expect(() => movePane(layout, 'nope', { paneId: PANE_TERMINAL, zone: 'center' })).toThrow(/unknown pane/i);
    expect(() => movePane(layout, PANE_TERMINAL, { paneId: 'nope', zone: 'center' })).toThrow(/unknown pane/i);
    expect(() => movePane(layout, PANE_TERMINAL, { paneId: PANE_TERMINAL, zone: 'center' })).toThrow(/itself/i);
  });

  it('leaves the layout valid after a move out of a nested dock', () => {
    const layout = createDefaultLayout();
    const next = movePane(layout, PANE_ARTIFACTS, { paneId: PANE_TERMINAL, zone: 'center' });
    expect(() => validateLayout(next)).not.toThrow();
    expect(findPaneGroup(next.root, PANE_ARTIFACTS)?.tabs).toContain(PANE_TERMINAL);
  });
});

describe('dockPaneToEdge', () => {
  it('moves the rest of the tree aside and gives the pane the outer-edge share', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW]));

    const left = dockPaneToEdge(layout, PANE_OVERVIEW, 'left');
    expect(left.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      sizes: [OUTER_EDGE_RATIO, 1 - OUTER_EDGE_RATIO],
      children: [group([PANE_OVERVIEW]), group([PANE_TERMINAL])],
    });

    const bottom = dockPaneToEdge(layout, PANE_OVERVIEW, 'bottom');
    expect(bottom.root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    });
    expect(layout.root).toEqual(group([PANE_TERMINAL, PANE_OVERVIEW])); // input untouched
  });

  it('flattens into an existing same-direction root instead of nesting', () => {
    const layout = layoutOf({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    });

    const next = dockPaneToEdge(layout, PANE_OVERVIEW, 'right');
    expect(next.root.type).toBe('split');
    expect((next.root as DockSplitNode).children).toHaveLength(2);
    expect(listPanes(next.root)).toEqual([PANE_TERMINAL, PANE_OVERVIEW]);
  });

  it('restores a closed pane straight to an edge', () => {
    const layout = layoutOf(group([PANE_TERMINAL]), [PANE_OVERVIEW]);
    const next = dockPaneToEdge(layout, PANE_OVERVIEW, 'top');
    expect(next.closed).toEqual([]);
    expect(listPanes(next.root)).toEqual([PANE_OVERVIEW, PANE_TERMINAL]);
  });

  it('rejects unknown panes, unknown sides and the last remaining pane', () => {
    const layout = layoutOf(group([PANE_TERMINAL]));
    expect(() => dockPaneToEdge(layout, 'nope', 'left')).toThrow(/unknown pane/i);
    expect(() => dockPaneToEdge(layout, PANE_TERMINAL, 'middle' as never)).toThrow(/unknown dock side/i);
    expect(() => dockPaneToEdge(layout, PANE_TERMINAL, 'left')).toThrow(/last remaining pane/i);
  });
});

describe('drop validity', () => {
  const layout = layoutOf({
    type: 'split',
    direction: 'horizontal',
    sizes: [0.5, 0.5],
    children: [group([PANE_TERMINAL, PANE_OVERVIEW]), group([PANE_ARTIFACTS])],
  });

  it('accepts a real move and rejects impossible or no-op drops', () => {
    expect(canDropPane(layout, PANE_OVERVIEW, { paneId: PANE_ARTIFACTS, zone: 'center' })).toBe(true);
    expect(canDropPane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'right' })).toBe(true);
    // Already tabbed with the target — re-tabbing changes nothing.
    expect(canDropPane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'center' })).toBe(false);
    expect(canDropPane(layout, PANE_OVERVIEW, { paneId: PANE_OVERVIEW, zone: 'center' })).toBe(false);
    expect(canDropPane(layout, 'nope', { paneId: PANE_TERMINAL, zone: 'center' })).toBe(false);
    expect(canDropPane(layout, PANE_OVERVIEW, { paneId: PANE_TERMINAL, zone: 'middle' as never })).toBe(false);
    expect(canDropPane(layout, PANE_SCHEDULER, { paneId: PANE_TERMINAL, zone: 'center' })).toBe(false);
  });

  it('rejects splitting a solitary group away from itself', () => {
    const solo = layoutOf(group([PANE_TERMINAL]));
    expect(canDropPane(solo, PANE_TERMINAL, { paneId: PANE_TERMINAL, zone: 'right' })).toBe(false);
    expect(canDockPaneToEdge(solo, PANE_TERMINAL, 'left')).toBe(false);
    expect(canDockPaneToEdge(layout, PANE_OVERVIEW, 'left')).toBe(true);
    expect(canDockPaneToEdge(layout, PANE_OVERVIEW, 'middle' as never)).toBe(false);
  });
});

describe('tab operations', () => {
  it('reorders a tab within its group', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW, PANE_PLAN_SCREEN], PANE_TERMINAL));
    const next = reorderTab(layout, PANE_PLAN_SCREEN, 0);
    expect(findPaneGroup(next.root, PANE_TERMINAL)?.tabs)
      .toEqual([PANE_PLAN_SCREEN, PANE_TERMINAL, PANE_OVERVIEW]);
    expect(findPaneGroup(next.root, PANE_TERMINAL)?.activeTab).toBe(PANE_TERMINAL);
  });

  it('clamps a reorder index instead of dropping the tab', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW]));
    expect(findPaneGroup(reorderTab(layout, PANE_TERMINAL, 99).root, PANE_TERMINAL)?.tabs)
      .toEqual([PANE_OVERVIEW, PANE_TERMINAL]);
    expect(canReorderTab(layout, PANE_TERMINAL, 99)).toBe(true);
    expect(canReorderTab(layout, PANE_TERMINAL, 0)).toBe(false);
    expect(canReorderTab(layout, 'missing', 0)).toBe(false);
  });

  it('activates a tab only within its own group', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW], PANE_TERMINAL));
    expect(findPaneGroup(setActiveTab(layout, PANE_OVERVIEW).root, PANE_OVERVIEW)?.activeTab).toBe(PANE_OVERVIEW);
    expect(() => setActiveTab(layout, PANE_ARTIFACTS)).toThrow(/unknown pane/i);
  });
});

describe('close and restore', () => {
  it('closes a pane, picks a new active tab, and records it as recoverable', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW], PANE_OVERVIEW));
    const next = closePane(layout, PANE_OVERVIEW);
    expect(next.closed).toEqual([PANE_OVERVIEW]);
    expect(next.root).toEqual(group([PANE_TERMINAL], PANE_TERMINAL));
  });

  it('selects the next tab, then the previous tab, when closing the active tab', () => {
    const layout = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW, PANE_PLAN_SCREEN], PANE_OVERVIEW));
    expect(findPaneGroup(closePane(layout, PANE_OVERVIEW).root, PANE_TERMINAL)?.activeTab).toBe(PANE_PLAN_SCREEN);
    const lastActive = layoutOf(group([PANE_TERMINAL, PANE_OVERVIEW], PANE_OVERVIEW));
    expect(findPaneGroup(closePane(lastActive, PANE_OVERVIEW).root, PANE_TERMINAL)?.activeTab).toBe(PANE_TERMINAL);
  });

  it('can close the final pane into the canonical empty root', () => {
    const closed = DOCK_PANES.filter(pane => pane.id !== PANE_TERMINAL).map(pane => pane.id);
    const next = closePane(layoutOf(group([PANE_TERMINAL]), closed), PANE_TERMINAL);
    expect(next.root).toEqual({ type: 'empty' });
    expect(next.closed).toEqual([...closed, PANE_TERMINAL]);
    expect(() => validateLayout(next)).not.toThrow();
  });

  it('restores the first pane into an all-closed workspace', () => {
    const layout = layoutOf({ type: 'empty' }, DOCK_PANES.map(pane => pane.id));
    const next = restorePane(layout, PANE_TERMINAL);
    expect(next.root).toEqual(group([PANE_TERMINAL], PANE_TERMINAL));
    expect(next.closed).toEqual(DOCK_PANES.filter(pane => pane.id !== PANE_TERMINAL).map(pane => pane.id));
    expect(() => validateLayout(next)).not.toThrow();
  });

  it('restores a closed pane into the live dock on its home side', () => {
    const layout = closePane(createDefaultLayout(), PANE_SCHEDULER);
    const restored = restorePane(layout, PANE_SCHEDULER);
    expect(restored.closed).toEqual([]);
    expect(findDockSideOf(restored.root, PANE_SCHEDULER)).toBe('left');
    expect(() => validateLayout(restored)).not.toThrow();
  });

  // The regression that made tool windows feel unrecoverable: closing every
  // pane of a dock deletes the dock, and restore used to fall back to the first
  // live pane — dropping the tool window into the centre group behind Terminal.
  it('recreates the home edge dock when every pane of it was closed', () => {
    const emptied = [PANE_SESSIONS, PANE_SCHEDULER, PANE_QUICK_SPAWN, PANE_PLAN_DIRECTORIES]
      .reduce(closePane, createDefaultLayout());
    expect(findDockSideOf(emptied.root, PANE_SESSIONS)).toBeNull();

    const restored = restorePane(emptied, PANE_SESSIONS);
    expect(findDockSideOf(restored.root, PANE_SESSIONS)).toBe('left');
    expect(findPaneGroup(restored.root, PANE_TERMINAL)?.tabs).not.toContain(PANE_SESSIONS);
    expect(() => validateLayout(restored)).not.toThrow();
  });

  it('restores each tool window to its own home side', () => {
    const closed = closePane(closePane(createDefaultLayout(), PANE_ARTIFACTS), PANE_SCHEDULER);
    const restored = restorePane(restorePane(closed, PANE_ARTIFACTS), PANE_SCHEDULER);
    expect(findDockSideOf(restored.root, PANE_ARTIFACTS)).toBe('right');
    expect(findDockSideOf(restored.root, PANE_SCHEDULER)).toBe('left');
  });

  it('restores a centre-homed view into the centre group, never a dock', () => {
    const layout = closePane(createDefaultLayout(), PANE_OVERVIEW);
    const restored = restorePane(layout, PANE_OVERVIEW);
    expect(findDockSideOf(restored.root, PANE_OVERVIEW)).toBeNull();
    expect(findPaneGroup(restored.root, PANE_OVERVIEW)?.tabs).toContain(PANE_TERMINAL);
  });

  it('refuses to restore or move a pane that is not closed', () => {
    const layout = createDefaultLayout();
    expect(() => restorePane(layout, PANE_ARTIFACTS)).toThrow(/not closed/i);
    expect(() => movePane(layoutOf(group([PANE_TERMINAL])), PANE_OVERVIEW, {
      paneId: PANE_TERMINAL,
      zone: 'center',
    })).toThrow(/neither docked nor closed/i);
  });

  it('restores into a caller-supplied target when given one', () => {
    const layout = closePane(createDefaultLayout(), PANE_ARTIFACTS);
    const restored = restorePane(layout, PANE_ARTIFACTS, { paneId: PANE_TERMINAL, zone: 'bottom' });
    expect(findPaneGroup(restored.root, PANE_ARTIFACTS)?.tabs).toEqual([PANE_ARTIFACTS]);
    expect(restored.closed).toEqual([]);
  });

  it('rejects an explicit restore target that is not live', () => {
    const layout = closePane(closePane(createDefaultLayout(), PANE_ARTIFACTS), PANE_OVERVIEW);
    expect(() => restorePane(layout, PANE_ARTIFACTS, { paneId: PANE_OVERVIEW, zone: 'center' })).toThrow(/not docked/i);
    expect(() => restorePane(layout, PANE_ARTIFACTS, { paneId: 'nope', zone: 'center' })).toThrow(/unknown pane/i);
  });

  it('rejects restoring a pane that is not closed', () => {
    expect(() => restorePane(createDefaultLayout(), PANE_ARTIFACTS)).toThrow(/not closed/i);
  });
});

describe('dock mode', () => {
  it('sets the mode of the dock containing a pane', () => {
    const next = setDockMode(createDefaultLayout(), PANE_ARTIFACTS, 'pinned');
    expect(findDock(next.root, PANE_ARTIFACTS)?.mode).toBe('pinned');
  });

  it('throws when the pane is not inside a dock node', () => {
    expect(() => setDockMode(createDefaultLayout(), PANE_TERMINAL, 'hidden')).toThrow(/not docked/i);
  });

  it('keeps the left dock pinned — it resizes but never collapses', () => {
    const next = setDockMode(createDefaultLayout(), PANE_SESSIONS, 'autohide');
    expect(findDock(next.root, PANE_SESSIONS)?.mode).toBe('pinned');
  });

  it('repairs a persisted layout whose left dock was saved collapsed', () => {
    const saved = JSON.parse(JSON.stringify(createDefaultLayout()));
    findDock(saved.root, PANE_SESSIONS)!.mode = 'autohide';
    expect(findDock(validateLayout(saved).root, PANE_SESSIONS)?.mode).toBe('pinned');
  });
});

describe('split resizing', () => {
  it('updates a split at a recursive path without changing its children', () => {
    const layout = layoutOf({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.4, 0.6],
      children: [
        group([PANE_TERMINAL]),
        {
          type: 'split',
          direction: 'vertical',
          sizes: [0.25, 0.75],
          children: [group([PANE_OVERVIEW]), group([PANE_PLAN_SCREEN])],
        },
      ],
    }, DOCK_PANES.filter(pane => ![PANE_TERMINAL, PANE_OVERVIEW, PANE_PLAN_SCREEN].includes(pane.id)).map(pane => pane.id));

    const next = resizeSplit(layout, [1], [0.7, 0.3]);

    expect(next.root).toMatchObject({
      type: 'split',
      children: [group([PANE_TERMINAL]), {
        type: 'split',
        direction: 'vertical',
        sizes: [0.7, 0.3],
      }],
    });
    expect(layout.root).toMatchObject({ type: 'split', sizes: [0.4, 0.6] });
  });

  it('repairs invalid resize ratios to positive values summing to one', () => {
    const layout = layoutOf({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    }, DOCK_PANES.filter(pane => ![PANE_TERMINAL, PANE_OVERVIEW].includes(pane.id)).map(pane => pane.id));

    const sizes = resizeSplit(layout, [], [0, Number.NaN]).root;
    expect(sizes).toMatchObject({ type: 'split' });
    if (sizes.type === 'split') {
      expect(sizes.sizes.every(size => size > 0)).toBe(true);
      expect(sizes.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
    }
  });
});

describe('normalizeNode', () => {
  it('drops empty groups and collapses single-child splits', () => {
    const node: DockNode = {
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([]), group([PANE_TERMINAL])],
    };
    expect(normalizeNode(node)).toEqual(group([PANE_TERMINAL]));
  });

  it('flattens nested splits of the same direction and rescales their ratios', () => {
    const node: DockSplitNode = {
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [
        group([PANE_TERMINAL]),
        {
          type: 'split',
          direction: 'horizontal',
          sizes: [0.5, 0.5],
          children: [group([PANE_OVERVIEW]), group([PANE_PLAN_SCREEN])],
        },
      ],
    };
    const flat = normalizeNode(node) as DockSplitNode;
    expect(flat.children).toEqual([group([PANE_TERMINAL]), group([PANE_OVERVIEW]), group([PANE_PLAN_SCREEN])]);
    expect(flat.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('renormalizes sizes that are missing, negative, or do not sum to 1', () => {
    const node: DockSplitNode = {
      type: 'split',
      direction: 'vertical',
      sizes: [3, -1],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])],
    };
    const out = normalizeNode(node) as DockSplitNode;
    expect(out.sizes.every(size => size > 0)).toBe(true);
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('repairs an activeTab that is not in the group', () => {
    expect(normalizeNode(group([PANE_TERMINAL], PANE_OVERVIEW))).toEqual(group([PANE_TERMINAL], PANE_TERMINAL));
  });

  it('returns null when the whole subtree is empty', () => {
    expect(normalizeNode({ type: 'dock', side: 'left', mode: 'pinned', child: group([]) })).toBeNull();
  });

  it('repairs every malformed ratio to a positive normalized value', () => {
    const node: DockSplitNode = {
      type: 'split',
      direction: 'horizontal',
      sizes: [Number.NaN, 0, -1],
      children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW]), group([PANE_PLAN_SCREEN])],
    };
    const out = normalizeNode(node) as DockSplitNode;
    expect(out.sizes.every(size => size > 0)).toBe(true);
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('detects panes hidden by an ancestor dock', () => {
    const node: DockNode = { type: 'dock', side: 'left', mode: 'hidden', child: group([PANE_TERMINAL]) };
    expect(isPaneHidden(node, PANE_TERMINAL)).toBe(true);
    expect(isPaneHidden(node, PANE_OVERVIEW)).toBe(false);
  });

  it('excludes both autohide and hidden descendants from the focus walk', () => {
    const node: DockNode = {
      type: 'split',
      direction: 'horizontal',
      sizes: [1 / 3, 1 / 3, 1 / 3],
      children: [
        group([PANE_TERMINAL]),
        { type: 'dock', side: 'right', mode: 'autohide', child: group([PANE_ARTIFACTS]) },
        { type: 'dock', side: 'left', mode: 'hidden', child: group([PANE_OVERVIEW]) },
      ],
    };
    expect(listFocusablePanes(node)).toEqual([PANE_TERMINAL]);
  });
});

describe('validateLayout', () => {
  it('accepts a round-tripped layout', () => {
    const parsed = validateLayout(JSON.parse(JSON.stringify(createDefaultLayout())));
    expect(listPanes(parsed.root)).toEqual(listPanes(createDefaultLayout().root));
  });

  it('accepts the canonical all-closed root', () => {
    const closed = DOCK_PANES.map(pane => pane.id);
    expect(validateLayout({ version: DOCK_LAYOUT_VERSION, root: { type: 'empty' }, closed })).toEqual({
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'empty' },
      closed,
    });
  });

  it('rejects an empty root unless every registered pane is closed', () => {
    expect(() => validateLayout({
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'empty' },
      closed: DOCK_PANES.slice(1).map(pane => pane.id),
    })).toThrow(/missing pane/i);
  });

  it.each([
    ['not an object', null],
    ['wrong version', { version: 99, root: group([PANE_TERMINAL]), closed: [] }],
    ['missing root', { version: DOCK_LAYOUT_VERSION, closed: [] }],
    ['unknown node type', { version: DOCK_LAYOUT_VERSION, root: { type: 'floating' }, closed: [] }],
    ['bad split arity', {
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'split', direction: 'horizontal', sizes: [1], children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])] },
      closed: [],
    }],
    ['bad dock side', {
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'dock', side: 'sideways', mode: 'pinned', child: group([PANE_TERMINAL]) },
      closed: [],
    }],
    ['negative split ratio', {
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'split', direction: 'horizontal', sizes: [-0.1, 1.1], children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])] },
      closed: DOCK_PANES.filter(p => ![PANE_TERMINAL, PANE_OVERVIEW].includes(p.id)).map(p => p.id),
    }],
    ['split ratios do not sum to one', {
      version: DOCK_LAYOUT_VERSION,
      root: { type: 'split', direction: 'horizontal', sizes: [0.4, 0.4], children: [group([PANE_TERMINAL]), group([PANE_OVERVIEW])] },
      closed: DOCK_PANES.filter(p => ![PANE_TERMINAL, PANE_OVERVIEW].includes(p.id)).map(p => p.id),
    }],
  ])('rejects a malformed layout: %s', (_label, bad) => {
    expect(() => validateLayout(bad)).toThrow();
  });

  it('rejects duplicate panes across the tree and the closed list', () => {
    expect(() => validateLayout(layoutOf({
      type: 'split',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [group([PANE_TERMINAL]), group([PANE_TERMINAL])],
    }))).toThrow(/duplicate/i);

    expect(() => validateLayout(layoutOf(group([PANE_TERMINAL]), [PANE_TERMINAL]))).toThrow(/duplicate/i);
  });

  it('rejects unknown pane ids', () => {
    expect(() => validateLayout(layoutOf(group(['mystery-pane'])))).toThrow(/unknown pane/i);
  });

  it('rejects a layout that omits a registered pane entirely', () => {
    expect(() => validateLayout(layoutOf(group([PANE_TERMINAL])))).toThrow(/missing pane/i);
  });

  it('clones parsed arrays instead of aliasing untrusted input', () => {
    const raw = JSON.parse(JSON.stringify(createDefaultLayout())) as any;
    const parsed = validateLayout(raw);
    const parsedTerminalTabs = findPaneGroup(parsed.root, PANE_TERMINAL)?.tabs;
    raw.closed.push(PANE_OVERVIEW);
    raw.root.children[1].tabs.push(PANE_ARTIFACTS);
    raw.root.children[1].tabs.splice(0, 1);
    expect(parsed.closed).toEqual([]);
    expect(findPaneGroup(parsed.root, PANE_TERMINAL)?.tabs).toEqual(parsedTerminalTabs);
  });

  it('returns detached group snapshots', () => {
    const layout = createDefaultLayout();
    const snapshot = findPaneGroup(layout.root, PANE_TERMINAL);
    snapshot?.tabs.push(PANE_ARTIFACTS);
    expect(findPaneGroup(layout.root, PANE_TERMINAL)?.tabs).not.toContain(PANE_ARTIFACTS);
  });
});
