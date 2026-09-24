/**
 * Pure dock layout-tree operations.
 *
 * Vue-independent by design: every function takes a layout and returns a new
 * one, so the store is a thin reactive wrapper and the whole model is testable
 * without a DOM. All mutations run through `normalizeNode`, so callers can never
 * observe an empty group, a stray single-child split, or unscaled ratios.
 */

import {
  DOCK_LAYOUT_VERSION,
  getPaneDescriptor,
  isKnownPane,
  isProfilePane,
  listProfilePanes,
  OUTER_EDGE_RATIO,
  PANE_ARTIFACTS,
  PANE_PLAN_DIRECTORIES,
  PANE_PLAN_SCREEN,
  PANE_MEMORIES,
  PANE_MESS,
  PANE_QUICK_SPAWN,
  PANE_SCHEDULER,
  PANE_SESSIONS,
  PANE_TERMINAL,
  type DockDockNode,
  type DockGroupNode,
  type DockMode,
  type DockNode,
  type DockNodePath,
  type DockProfileId,
  type DockSide,
  type DockSplitNode,
  type DockWorkspaceLayout,
  type DropTarget,
  type DropZone,
  type PaneId,
  type SplitDirection,
} from './dock-types';

const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'top', 'bottom'];
const DOCK_MODES: readonly DockMode[] = ['pinned', 'autohide', 'hidden'];
const SPLIT_DIRECTIONS: readonly SplitDirection[] = ['horizontal', 'vertical'];
const DROP_ZONES: readonly DropZone[] = ['center', 'left', 'right', 'top', 'bottom'];

/** Where each zone puts the moved pane relative to the target, and along which axis. */
const ZONE_GEOMETRY: Record<Exclude<DropZone, 'center'>, { direction: SplitDirection; before: boolean }> = {
  left: { direction: 'horizontal', before: true },
  right: { direction: 'horizontal', before: false },
  top: { direction: 'vertical', before: true },
  bottom: { direction: 'vertical', before: false },
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function group(tabs: PaneId[], activeTab: PaneId = tabs[0]): DockGroupNode {
  return { type: 'group', tabs: [...tabs], activeTab };
}

function split(direction: SplitDirection, children: DockNode[], sizes?: number[]): DockSplitNode {
  return { type: 'split', direction, sizes: scaleSizes(sizes ?? [], children.length), children };
}

/**
 * The left dock holds the session list and cannot be collapsed; it is shrunk with
 * its splitter instead. Normalising here also repairs layouts saved while a
 * collapse control still existed, which would otherwise be stranded on a rail.
 */
function dockModeFor(side: DockSide, mode: DockMode): DockMode {
  return side === 'left' ? 'pinned' : mode;
}

function dock(side: DockSide, mode: DockMode, child: DockNode): DockDockNode {
  return { type: 'dock', side, mode, child };
}

/** Share an edge dock receives in a freshly built default layout. */
const DEFAULT_EDGE_RATIO = 0.22;

/** Artifacts has always started as a collapsed rail rather than a pinned column. */
const DEFAULT_DOCK_MODES: Partial<Record<DockSide, DockMode>> = { right: 'autohide' };

/**
 * The Classic layout — a close reproduction of the pre-docking UI: session list
 * and tool windows on the left, the view group in the centre, and Artifacts as a
 * collapsed right-edge rail.
 *
 * Kept as a literal rather than derived: the left column's split between the
 * session list and the stacked tool windows is a hand-tuned arrangement that no
 * descriptor records, and reproducing the pre-docking UI exactly is the point.
 */
function createClassicLayout(): DockWorkspaceLayout {
  return {
    version: DOCK_LAYOUT_VERSION,
    root: split('horizontal', [
      dock('left', 'pinned', split('vertical', [
        group([PANE_SESSIONS]),
        group([PANE_SCHEDULER, PANE_QUICK_SPAWN, PANE_PLAN_DIRECTORIES], PANE_SCHEDULER),
      ], [0.6, 0.4])),
      group([PANE_TERMINAL, PANE_PLAN_SCREEN, PANE_MEMORIES, PANE_MESS], PANE_TERMINAL),
      dock('right', 'autohide', group([PANE_ARTIFACTS])),
    ], [0.22, 0.56, 0.22]),
    closed: [],
  };
}

/**
 * Generic default for a profile: centre-homed panes tabbed in one group, every
 * other pane in the edge dock its descriptor names as home.
 */
function createProfileLayout(profile: DockProfileId): DockWorkspaceLayout {
  const panes = listProfilePanes(profile);
  const centre = panes.filter(p => p.home === 'center').map(p => p.id);
  const bySide = DOCK_SIDES
    .map(side => ({ side, ids: panes.filter(p => p.home === side).map(p => p.id) }))
    .filter(entry => entry.ids.length > 0);

  let root: DockNode = centre.length ? group(centre, centre[0]) : { type: 'empty' };

  // Horizontal edges first so the vertical ones span the finished row, matching
  // how a dragged top/bottom edge dock lands on an existing layout.
  for (const direction of ['horizontal', 'vertical'] as const) {
    const edges = bySide.filter(e => ZONE_GEOMETRY[e.side].direction === direction);
    if (!edges.length) continue;
    const children: DockNode[] = [];
    const sizes: number[] = [];
    const centreShare = 1 - DEFAULT_EDGE_RATIO * edges.length;
    for (const edge of edges.filter(e => ZONE_GEOMETRY[e.side].before)) {
      children.push(dock(edge.side, DEFAULT_DOCK_MODES[edge.side] ?? 'pinned', group(edge.ids)));
      sizes.push(DEFAULT_EDGE_RATIO);
    }
    children.push(root);
    sizes.push(centreShare);
    for (const edge of edges.filter(e => !ZONE_GEOMETRY[e.side].before)) {
      children.push(dock(edge.side, DEFAULT_DOCK_MODES[edge.side] ?? 'pinned', group(edge.ids)));
      sizes.push(DEFAULT_EDGE_RATIO);
    }
    root = split(direction, children, sizes);
  }

  return { version: DOCK_LAYOUT_VERSION, root, closed: [] };
}

export function createDefaultLayout(profile: DockProfileId = 'main'): DockWorkspaceLayout {
  return profile === 'main' ? createClassicLayout() : createProfileLayout(profile);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Pane ids in deterministic left-to-right, top-to-bottom order. */
export function listPanes(node: DockNode | null): PaneId[] {
  if (!node) return [];
  if (node.type === 'empty') return [];
  if (node.type === 'group') return [...node.tabs];
  if (node.type === 'dock') return listPanes(node.child);
  return node.children.flatMap(listPanes);
}

/**
 * Whether an edge dock currently occupies no space and renders only its rail.
 *
 * The single authority for collapse: the parent split uses it to drop the dock's
 * `fr` track, and the dock itself uses it to hide its content. Deriving both
 * from one predicate is what keeps a closed autohide dock from leaving a blank
 * column behind.
 */
export function isDockCollapsed(
  node: DockNode,
  revealed: readonly PaneId[] = [],
  focusedPaneId: PaneId | null = null,
): boolean {
  if (node.type !== 'dock' || node.mode === 'pinned') return false;
  const panes = listPanes(node.child);
  if (node.mode === 'hidden') return true;
  if (panes.some(paneId => revealed.includes(paneId))) return false;
  return !(focusedPaneId && panes.includes(focusedPaneId));
}

/**
 * Pane ids eligible for gamepad focus cycling in deterministic tree order.
 *
 * Panes under a collapsed edge dock are excluded, but a revealed autohide dock
 * participates like a pinned one — an opened pane the user can see must be a
 * pane the user can focus.
 */
export function listFocusablePanes(node: DockNode | null, revealed: readonly PaneId[] = []): PaneId[] {
  if (!node || node.type === 'empty') return [];
  if (node.type === 'group') return [...node.tabs];
  if (node.type === 'dock') {
    return isDockCollapsed(node, revealed) ? [] : listFocusablePanes(node.child, revealed);
  }
  return node.children.flatMap(child => listFocusablePanes(child, revealed));
}

export function findPaneGroup(node: DockNode | null, paneId: PaneId): DockGroupNode | null {
  if (!node) return null;
  if (node.type === 'empty') return null;
  if (node.type === 'group') {
    return node.tabs.includes(paneId) ? { type: 'group', tabs: [...node.tabs], activeTab: node.activeTab } : null;
  }
  if (node.type === 'dock') return findPaneGroup(node.child, paneId);
  for (const child of node.children) {
    const hit = findPaneGroup(child, paneId);
    if (hit) return hit;
  }
  return null;
}

/** Whether a pane is under a dock explicitly hidden by the user. */
export function isPaneHidden(node: DockNode | null, paneId: PaneId): boolean {
  if (!node || node.type === 'empty') return false;
  if (node.type === 'group') return false;
  if (node.type === 'dock') {
    return node.mode === 'hidden' && listPanes(node.child).includes(paneId)
      ? true
      : isPaneHidden(node.child, paneId);
  }
  return node.children.some(child => isPaneHidden(child, paneId));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Scale to `count` positive ratios summing to 1, padding/truncating as needed. */
function scaleSizes(sizes: number[], count: number): number[] {
  if (count === 0) return [];
  const usable = Array.from({ length: count }, (_, i) => {
    const v = sizes[i];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
  });
  const total = usable.reduce((a, b) => a + b, 0);
  return usable.map(v => v / total);
}

/**
 * Rebuild a subtree in canonical form. Returns null when nothing is left, which
 * is how empty groups and emptied docks disappear after a move or close.
 */
export function normalizeNode(node: DockNode | null): DockNode | null {
  if (!node) return null;
  if (node.type === 'empty') return null;

  if (node.type === 'group') {
    if (node.tabs.length === 0) return null;
    const activeTab = node.tabs.includes(node.activeTab) ? node.activeTab : node.tabs[0];
    return { type: 'group', tabs: [...node.tabs], activeTab };
  }

  if (node.type === 'dock') {
    const child = normalizeNode(node.child);
    return child ? { type: 'dock', side: node.side, mode: node.mode, child } : null;
  }

  // Split: normalize children, drop the empties, then flatten same-direction
  // nesting so the tree stays shallow no matter how many moves preceded it.
  const kept: Array<{ node: DockNode; size: number }> = [];
  node.children.forEach((child, i) => {
    const normalized = normalizeNode(child);
    if (normalized) kept.push({ node: normalized, size: node.sizes[i] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;

  const scaled = scaleSizes(kept.map(k => k.size), kept.length);
  const children: DockNode[] = [];
  const sizes: number[] = [];
  kept.forEach((k, i) => {
    const inner = k.node;
    if (inner.type === 'split' && inner.direction === node.direction) {
      inner.children.forEach((grandChild, j) => {
        children.push(grandChild);
        sizes.push(scaled[i] * inner.sizes[j]);
      });
    } else {
      children.push(k.node);
      sizes.push(scaled[i]);
    }
  });

  return { type: 'split', direction: node.direction, sizes: scaleSizes(sizes, children.length), children };
}

function withRoot(layout: DockWorkspaceLayout, root: DockNode | null, closed: PaneId[]): DockWorkspaceLayout {
  const normalized = normalizeNode(root);
  if (normalized) return { version: layout.version, root: normalized, closed: [...closed] };
  // An emptied tree means every pane that was in it has been closed, whatever
  // profile it was built from — the ops here only remove a pane in tandem with
  // adding it to `closed`, so the closed list is the profile's pane set.
  if (closed.length > 0) {
    return { version: layout.version, root: { type: 'empty' }, closed: [...closed] };
  }
  throw new Error('dock layout: operation would leave an invalid empty workspace');
}

// ---------------------------------------------------------------------------
// Tree edits (immutable; each returns a fresh subtree)
// ---------------------------------------------------------------------------

function mapNode(node: DockNode, fn: (n: DockNode) => DockNode | null): DockNode | null {
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  if (node.type === 'dock') {
    const child = mapNode(node.child, fn);
    return child ? { ...node, child } : null;
  }
  if (node.type === 'split') {
    const children: DockNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = mapNode(child, fn);
      if (next) {
        children.push(next);
        sizes.push(node.sizes[i] ?? 0);
      }
    });
    return children.length ? { ...node, children, sizes } : null;
  }
  return node;
}

/** Remove a pane from whichever group holds it. */
function removePane(root: DockNode, paneId: PaneId): DockNode | null {
  return mapNode(root, node => {
    if (node.type !== 'group' || !node.tabs.includes(paneId)) return node;
    const removedIndex = node.tabs.indexOf(paneId);
    const tabs = node.tabs.filter(t => t !== paneId);
    if (tabs.length === 0) return null;
    const activeTab = node.activeTab === paneId
      ? tabs[Math.min(removedIndex, tabs.length - 1)]
      : node.activeTab;
    return { type: 'group', tabs, activeTab };
  });
}

/** Insert a pane at the drop target: tabbed for `center`, split otherwise. */
function insertPane(root: DockNode, paneId: PaneId, target: DropTarget): DockNode {
  const inserted = mapNode(root, node => {
    if (node.type !== 'group' || !node.tabs.includes(target.paneId)) return node;
    if (target.zone === 'center') {
      return { type: 'group', tabs: [...node.tabs, paneId], activeTab: paneId };
    }
    const { direction, before } = ZONE_GEOMETRY[target.zone];
    const moved = group([paneId]);
    return split(direction, before ? [moved, node] : [node, moved]);
  });
  if (!inserted) throw new Error('dock layout: insert produced an empty tree');
  return inserted;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

function assertKnown(paneId: PaneId): void {
  if (!isKnownPane(paneId)) throw new Error(`dock layout: unknown pane "${paneId}"`);
}

function assertDocked(layout: DockWorkspaceLayout, paneId: PaneId): void {
  assertKnown(paneId);
  if (!findPaneGroup(layout.root, paneId)) throw new Error(`dock layout: unknown pane "${paneId}" in layout`);
}

function assertDropTarget(target: DropTarget): void {
  assertKnown(target.paneId);
  if (!DROP_ZONES.includes(target.zone)) throw new Error(`dock layout: unknown drop zone "${target.zone}"`);
}

/**
 * Move a pane onto a drop target. Also serves as the split, tab and
 * restore-with-target operation — they differ only in the zone and in whether
 * the pane started in the tree or in `closed`.
 */
export function movePane(layout: DockWorkspaceLayout, paneId: PaneId, target: DropTarget): DockWorkspaceLayout {
  assertKnown(paneId);
  assertDropTarget(target);
  if (!findPaneGroup(layout.root, paneId) && !layout.closed.includes(paneId)) {
    throw new Error(`dock layout: pane "${paneId}" is neither docked nor closed`);
  }
  assertDocked(layout, target.paneId);
  if (paneId === target.paneId) throw new Error('dock layout: a pane cannot be dropped onto itself');

  const detached = normalizeNode(removePane(layout.root, paneId));
  if (!detached) throw new Error('dock layout: cannot move the last remaining pane');
  if (!findPaneGroup(detached, target.paneId)) {
    throw new Error('dock layout: drop target disappeared when the pane was detached');
  }

  return withRoot(layout, insertPane(detached, paneId, target), layout.closed.filter(id => id !== paneId));
}

/**
 * Dock a pane against an outer workspace edge — the whole tree moves aside
 * rather than one group splitting. Normalization flattens the new split into an
 * existing same-direction root, so repeated edge docks stay shallow.
 */
export function dockPaneToEdge(
  layout: DockWorkspaceLayout,
  paneId: PaneId,
  side: DockSide,
): DockWorkspaceLayout {
  assertKnown(paneId);
  if (!DOCK_SIDES.includes(side)) throw new Error(`dock layout: unknown dock side "${side}"`);
  if (!findPaneGroup(layout.root, paneId) && !layout.closed.includes(paneId)) {
    throw new Error(`dock layout: pane "${paneId}" is neither docked nor closed`);
  }

  const detached = normalizeNode(removePane(layout.root, paneId));
  if (!detached) throw new Error('dock layout: cannot move the last remaining pane');

  // A side and its matching split zone are the same geometry, so they share one table.
  const { direction, before } = ZONE_GEOMETRY[side];
  const moved = group([paneId]);
  const root = before
    ? split(direction, [moved, detached], [OUTER_EDGE_RATIO, 1 - OUTER_EDGE_RATIO])
    : split(direction, [detached, moved], [1 - OUTER_EDGE_RATIO, OUTER_EDGE_RATIO]);

  return withRoot(layout, root, layout.closed.filter(id => id !== paneId));
}

/**
 * Whether `movePane` would both succeed and change something. The drag layer
 * asks before it highlights, so a preview is never drawn over a drop that would
 * throw or silently do nothing.
 */
export function canDropPane(layout: DockWorkspaceLayout, paneId: PaneId, target: DropTarget): boolean {
  if (!isKnownPane(paneId) || !isKnownPane(target.paneId)) return false;
  if (!DROP_ZONES.includes(target.zone)) return false;
  if (paneId === target.paneId) return false;
  if (!findPaneGroup(layout.root, paneId) && !layout.closed.includes(paneId)) return false;

  const targetGroup = findPaneGroup(layout.root, target.paneId);
  if (!targetGroup) return false;
  // Re-tabbing a pane into the group it already sits in is a no-op, not a move.
  if (target.zone === 'center' && targetGroup.tabs.includes(paneId)) return false;
  // Splitting a group off from itself would strand the target.
  if (target.zone !== 'center' && targetGroup.tabs.length === 1 && targetGroup.tabs.includes(paneId)) return false;
  return true;
}

/** Whether `dockPaneToEdge` would succeed — used to gate the outer-edge preview. */
export function canDockPaneToEdge(layout: DockWorkspaceLayout, paneId: PaneId, side: DockSide): boolean {
  if (!isKnownPane(paneId) || !DOCK_SIDES.includes(side)) return false;
  if (!findPaneGroup(layout.root, paneId) && !layout.closed.includes(paneId)) return false;
  return !!normalizeNode(removePane(layout.root, paneId));
}

/** Whether reordering a tab would change its group's tab sequence. */
export function canReorderTab(layout: DockWorkspaceLayout, paneId: PaneId, index: number): boolean {
  const groupNode = findPaneGroup(layout.root, paneId);
  if (!groupNode) return false;
  const current = groupNode.tabs.indexOf(paneId);
  const clamped = Math.max(0, Math.min(index, groupNode.tabs.length - 1));
  return clamped !== current;
}

/** Reorder a tab inside its own group. The index is clamped, never dropped. */
export function reorderTab(layout: DockWorkspaceLayout, paneId: PaneId, index: number): DockWorkspaceLayout {
  assertDocked(layout, paneId);
  const root = mapNode(layout.root, node => {
    if (node.type !== 'group' || !node.tabs.includes(paneId)) return node;
    const tabs = node.tabs.filter(t => t !== paneId);
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, paneId);
    return { type: 'group', tabs, activeTab: node.activeTab };
  });
  return withRoot(layout, root, layout.closed);
}

export function setActiveTab(layout: DockWorkspaceLayout, paneId: PaneId): DockWorkspaceLayout {
  assertDocked(layout, paneId);
  const root = mapNode(layout.root, node =>
    node.type === 'group' && node.tabs.includes(paneId) ? { ...node, activeTab: paneId } : node);
  return withRoot(layout, root, layout.closed);
}

/** Set pinned/autohide/hidden on the dock node containing a pane. */
export function setDockMode(layout: DockWorkspaceLayout, paneId: PaneId, mode: DockMode): DockWorkspaceLayout {
  assertDocked(layout, paneId);
  if (!DOCK_MODES.includes(mode)) throw new Error(`dock layout: unknown dock mode "${mode}"`);
  let found = false;
  const root = mapNode(layout.root, node => {
    if (node.type !== 'dock' || !listPanes(node.child).includes(paneId)) return node;
    found = true;
    return { ...node, mode: dockModeFor(node.side, mode) };
  });
  if (!found) throw new Error(`dock layout: pane "${paneId}" is not docked to an edge`);
  return withRoot(layout, root, layout.closed);
}

/** Close a pane to the View menu when its descriptor permits recovery. */
export function closePane(layout: DockWorkspaceLayout, paneId: PaneId): DockWorkspaceLayout {
  assertDocked(layout, paneId);
  if (!getPaneDescriptor(paneId)?.closable) throw new Error(`dock layout: pane "${paneId}" is not closable`);
  return withRoot(layout, removePane(layout.root, paneId), [...layout.closed, paneId]);
}

/** Restore a closed pane, to an explicit target or to its default home. */
export function restorePane(
  layout: DockWorkspaceLayout,
  paneId: PaneId,
  target?: DropTarget,
): DockWorkspaceLayout {
  assertKnown(paneId);
  if (!layout.closed.includes(paneId)) {
    throw new Error(`dock layout: pane "${paneId}" is not closed`);
  }
  if (findPaneGroup(layout.root, paneId)) throw new Error(`dock layout: pane "${paneId}" is already docked`);

  if (target) {
    assertDropTarget(target);
    if (!findPaneGroup(layout.root, target.paneId)) {
      throw new Error(`dock layout: restore target pane "${target.paneId}" is not docked`);
    }
    return withRoot(layout, insertPane(layout.root, paneId, target), layout.closed.filter(id => id !== paneId));
  }

  const remaining = layout.closed.filter(id => id !== paneId);
  if (layout.root.type === 'empty') {
    return withRoot(layout, group([paneId]), remaining);
  }

  const home = getPaneDescriptor(paneId)?.home ?? 'center';

  // A centre-homed view joins the widest centre group as a tab.
  if (home === 'center') {
    return withRoot(layout, insertPane(layout.root, paneId, centreTarget(layout.root)), remaining);
  }

  // An edge-homed tool window rejoins the dock on its side. If that dock is
  // gone — every pane of it was closed — it is rebuilt rather than the pane
  // being stranded as a tab in the centre, which is what made a closed tool
  // window feel unrecoverable.
  const liveDock = findDockOnSide(layout.root, home);
  if (liveDock) {
    const anchor = listPanes(liveDock.child)[0];
    return withRoot(layout, insertPane(layout.root, paneId, { paneId: anchor, zone: 'center' }), remaining);
  }
  return withRoot(layout, attachEdgeDock(layout.root, home, group([paneId])), remaining);
}

/** The centre group: the first group that is not inside an edge dock. */
function centreTarget(root: DockNode): DropTarget {
  const centre = findCentreGroup(root);
  return { paneId: (centre ?? findFirstGroup(root))!.tabs[0], zone: 'center' };
}

function findCentreGroup(node: DockNode): DockGroupNode | null {
  if (node.type === 'group') return node;
  if (node.type === 'dock') return null;
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findCentreGroup(child);
      if (found) return found;
    }
  }
  return null;
}

function findFirstGroup(node: DockNode): DockGroupNode | null {
  if (node.type === 'group') return node;
  if (node.type === 'dock') return findFirstGroup(node.child);
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findFirstGroup(child);
      if (found) return found;
    }
  }
  return null;
}

function findDockOnSide(node: DockNode, side: DockSide): DockDockNode | null {
  if (node.type === 'dock') return node.side === side ? node : findDockOnSide(node.child, side);
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findDockOnSide(child, side);
      if (found) return found;
    }
  }
  return null;
}

/** Wrap the tree in a fresh edge dock on `side`, sized like a dragged edge drop. */
function attachEdgeDock(root: DockNode, side: DockSide, child: DockNode): DockNode {
  const { direction, before } = ZONE_GEOMETRY[side];
  const edge = dock(side, 'pinned', child);
  return before
    ? split(direction, [edge, root], [OUTER_EDGE_RATIO, 1 - OUTER_EDGE_RATIO])
    : split(direction, [root, edge], [1 - OUTER_EDGE_RATIO, OUTER_EDGE_RATIO]);
}

export function resetLayout(profile: DockProfileId = 'main'): DockWorkspaceLayout {
  return createDefaultLayout(profile);
}

function replaceNodeAtPath(node: DockNode, path: DockNodePath, replace: (node: DockNode) => DockNode): DockNode {
  if (path.length === 0) return replace(node);
  const [segment, ...rest] = path;
  if (node.type === 'dock' && segment === -1) {
    return { ...node, child: replaceNodeAtPath(node.child, rest, replace) };
  }
  if (node.type === 'split' && segment !== undefined && segment >= 0 && segment < node.children.length) {
    return {
      ...node,
      children: node.children.map((child, index) =>
        index === segment ? replaceNodeAtPath(child, rest, replace) : child),
    };
  }
  throw new Error('dock layout: split path does not identify a node');
}

/** Replace one split's ratios without changing its recursive children. */
export function resizeSplit(
  layout: DockWorkspaceLayout,
  path: DockNodePath,
  sizes: number[],
): DockWorkspaceLayout {
  const root = replaceNodeAtPath(layout.root, path, node => {
    if (node.type !== 'split') throw new Error('dock layout: resize path does not identify a split');
    if (sizes.length !== node.children.length) {
      throw new Error('dock layout: resized split sizes do not match its children');
    }
    return { ...node, sizes: scaleSizes(sizes, node.children.length) };
  });
  return withRoot(layout, root, layout.closed);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateNode(raw: unknown, seen: Set<PaneId>, profile: DockProfileId): DockNode {
  if (!isRecord(raw)) throw new Error('dock layout: node is not an object');

  switch (raw.type) {
    case 'group': {
      const { tabs, activeTab } = raw;
      if (!Array.isArray(tabs) || tabs.length === 0) throw new Error('dock layout: group has no tabs');
      for (const tab of tabs) {
        if (typeof tab !== 'string' || !isProfilePane(profile, tab)) {
          throw new Error(`dock layout: unknown pane "${String(tab)}"`);
        }
        if (seen.has(tab)) throw new Error(`dock layout: duplicate pane "${tab}"`);
        seen.add(tab);
      }
      if (typeof activeTab !== 'string' || !tabs.includes(activeTab)) {
        throw new Error('dock layout: activeTab is not one of the group tabs');
      }
      return { type: 'group', tabs: [...tabs as PaneId[]], activeTab };
    }
    case 'split': {
      const { direction, sizes, children } = raw;
      if (!SPLIT_DIRECTIONS.includes(direction as SplitDirection)) {
        throw new Error(`dock layout: unknown split direction "${String(direction)}"`);
      }
      if (!Array.isArray(children) || children.length < 2) throw new Error('dock layout: split needs 2+ children');
      if (!Array.isArray(sizes) || sizes.length !== children.length) {
        throw new Error('dock layout: split sizes do not match its children');
      }
      if (sizes.some(s => typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > 1)) {
        throw new Error('dock layout: split sizes must be positive finite ratios no greater than 1');
      }
      const numericSizes = sizes as number[];
      const total = numericSizes.reduce((sum, size) => sum + size, 0);
      if (Math.abs(total - 1) > 1e-6) {
        throw new Error('dock layout: split sizes must sum to 1');
      }
      return {
        type: 'split',
        direction: direction as SplitDirection,
        sizes: [...numericSizes],
        children: children.map(child => validateNode(child, seen, profile)),
      };
    }
    case 'dock': {
      const { side, mode, child } = raw;
      if (!DOCK_SIDES.includes(side as DockSide)) throw new Error(`dock layout: unknown dock side "${String(side)}"`);
      if (!DOCK_MODES.includes(mode as DockMode)) throw new Error(`dock layout: unknown dock mode "${String(mode)}"`);
      return { type: 'dock', side: side as DockSide, mode: dockModeFor(side as DockSide, mode as DockMode), child: validateNode(child, seen, profile) };
    }
    default:
      throw new Error(`dock layout: unknown node type "${String(raw.type)}"`);
  }
}

/**
 * Pane ids that used to exist. A saved layout may still name them, so they are
 * pruned before validation rather than failing it — failing would throw away
 * the user's whole arrangement for the sake of one pane that is gone.
 * `overview` was Team View, retired in favour of Session List previews.
 */
const RETIRED_PANE_IDS: ReadonlySet<string> = new Set(['overview']);

/** Drop retired panes from a raw node; null when nothing is left of it. */
function pruneRetiredNode(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.type === 'group' && Array.isArray(raw.tabs)) {
    const tabs = raw.tabs.filter(tab => !RETIRED_PANE_IDS.has(tab as string));
    if (tabs.length === raw.tabs.length) return raw;
    if (tabs.length === 0) return null;
    return { ...raw, tabs, activeTab: tabs.includes(raw.activeTab) ? raw.activeTab : tabs[0] };
  }
  if (raw.type === 'dock') {
    const child = pruneRetiredNode(raw.child);
    if (child === raw.child) return raw;
    return child === null ? null : { ...raw, child };
  }
  if (raw.type === 'split' && Array.isArray(raw.children) && Array.isArray(raw.sizes)) {
    const pruned = raw.children.map(pruneRetiredNode);
    if (pruned.every((child, i) => child === (raw.children as unknown[])[i])) return raw;
    const kept = pruned
      .map((child, i) => ({ child, size: (raw.sizes as unknown[])[i] as number }))
      .filter(entry => entry.child !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0].child;
    // The removed pane's share goes back to its siblings in proportion.
    return { ...raw, children: kept.map(k => k.child), sizes: scaleSizes(kept.map(k => k.size), kept.length) };
  }
  return raw;
}

function pruneRetiredPanes(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const root = pruneRetiredNode(raw.root);
  const closed = Array.isArray(raw.closed)
    ? raw.closed.filter(id => !RETIRED_PANE_IDS.has(id as string))
    : raw.closed;
  return { ...raw, root: root ?? { type: 'empty' }, closed };
}

/**
 * Parse an untrusted layout (persisted config, IPC payload). Throws on any
 * malformed schema, unknown/duplicate pane, or missing registered pane, so a
 * caller can fall back to the default layout on a single try/catch.
 */
export function validateLayout(input: unknown, profile: DockProfileId = 'main'): DockWorkspaceLayout {
  const raw = pruneRetiredPanes(input);
  if (!isRecord(raw)) throw new Error('dock layout: layout is not an object');
  if (raw.version !== DOCK_LAYOUT_VERSION) throw new Error(`dock layout: unsupported version "${String(raw.version)}"`);

  const seen = new Set<PaneId>();
  const emptyRoot = isRecord(raw.root) && raw.root.type === 'empty';
  const root = emptyRoot ? { type: 'empty' as const } : validateNode(raw.root, seen, profile);

  const closed = raw.closed;
  if (!Array.isArray(closed)) throw new Error('dock layout: closed must be an array');
  for (const paneId of closed) {
    if (typeof paneId !== 'string' || !isProfilePane(profile, paneId)) {
      throw new Error(`dock layout: unknown pane "${String(paneId)}"`);
    }
    if (!getPaneDescriptor(paneId)?.closable) {
      throw new Error(`dock layout: pane "${paneId}" is not closable`);
    }
    if (seen.has(paneId)) throw new Error(`dock layout: duplicate pane "${paneId}"`);
    seen.add(paneId);
  }

  const profilePanes = listProfilePanes(profile);
  const missing = profilePanes.filter(p => !seen.has(p.id)).map(p => p.id);
  if (missing.length) throw new Error(`dock layout: missing pane(s) ${missing.join(', ')}`);

  if (emptyRoot && closed.length !== profilePanes.length) {
    throw new Error('dock layout: empty root requires every pane to be closed');
  }

  return { version: DOCK_LAYOUT_VERSION, root, closed: [...closed as PaneId[]] };
}
