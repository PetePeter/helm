/**
 * Dock workspace composable — the reactive contract over the pure layout tree.
 *
 * Deliberately thin: all layout logic lives in `dock-layout.ts` so it stays
 * testable without Vue. This layer owns only reactivity, focus identity, and the
 * "reject a bad layout, fall back to Classic" rule. Renderer components,
 * persistence IPC, drag/drop, and terminal adoption arrive in later plans.
 */

import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue';
import {
  closePane,
  canReorderTab,
  createDefaultLayout,
  ensurePane as ensurePaneInLayout,
  forgetPane as forgetPaneInLayout,
  dockPaneToEdge,
  findPaneGroup,
  listFocusablePanes,
  listPanes,
  movePane,
  pruneUnregisteredPanes as prunePanesInLayout,
  reorderTab,
  restorePane,
  resetLayout,
  resizeSplit,
  setActiveTab,
  setDockMode,
  validateLayout,
} from '../dock-layout';
import {
  loadDockLayout,
  readLegacyDockPreferences,
  serializeDockLayout,
  type DockLoadResult,
  type DockStorage,
} from '../dock-persistence';
import {
  dockPaneRegistry,
  getPaneDescriptor,
  listProfilePanes,
  PANE_TERMINAL,
  type DockMode,
  type DockProfileId,
  type DockSide,
  type DockWorkspaceLayout,
  type DockNodePath,
  type DropTarget,
  type PaneId,
} from '../dock-types';
import { paneRegistryRevision } from '../dock-registry-state';

export interface DockWorkspace {
  layout: ComputedRef<DockWorkspaceLayout>;
  /** Deterministic left-to-right, top-to-bottom order of every open pane. */
  paneOrder: Ref<PaneId[]>;
  /** Pinned-pane order used by gamepad focus cycling; autohide/hidden docks are omitted. */
  focusablePaneOrder: Ref<PaneId[]>;
  closedPanes: Ref<PaneId[]>;
  /** Autohide docks the user has opened; they render and take focus like pinned ones. */
  revealedPanes: Ref<PaneId[]>;
  focusedPaneId: Ref<PaneId | null>;
  isVisible: (paneId: PaneId) => boolean;
  /** Open an autohide/hidden dock and give it focus. */
  reveal: (paneId: PaneId) => void;
  /** Collapse a revealed dock back to its edge rail. */
  unreveal: (paneId: PaneId) => void;
  focusPane: (paneId: PaneId, focusedItemId?: string) => void;
  getFocusedItemId: (paneId: PaneId) => string | null;
  setFocusedItemId: (paneId: PaneId, itemId: string | null) => void;
  /** Cycle focus through panes in pinned docks. */
  cycleFocus: (direction: 1 | -1) => void;
  move: (paneId: PaneId, target: DropTarget) => void;
  /** Dock a pane against an outer workspace edge; the rest of the tree moves aside. */
  dockToEdge: (paneId: PaneId, side: DockSide) => void;
  reorder: (paneId: PaneId, index: number) => void;
  activate: (paneId: PaneId) => void;
  setMode: (paneId: PaneId, mode: DockMode) => void;
  close: (paneId: PaneId) => void;
  ensurePane: (paneId: PaneId) => void;
  forgetPane: (paneId: PaneId) => void;
  pruneUnregisteredPanes: () => void;
  restore: (paneId: PaneId, target?: DropTarget) => void;
  reset: () => void;
  resize: (path: DockNodePath, sizes: number[]) => void;
  /** Adopt an untrusted layout; falls back to Classic and returns false if invalid. */
  load: (raw: unknown) => boolean;
  /** Load from app-data and migrate legacy browser storage on first launch. */
  loadPersisted: () => Promise<DockLoadResult>;
  /** True when the pane is present in the tree (regardless of active tab/hidden dock). */
  isOpen: (paneId: PaneId) => boolean;
}

export interface DockWorkspacePersistence {
  load: () => Promise<unknown> | unknown;
  save: (layout: DockWorkspaceLayout) => Promise<unknown> | unknown;
  /** Optional injected storage makes migration deterministic in tests. */
  legacyStorage?: DockStorage;
  /** Optional viewport width used to convert legacy pixel widths to ratios. */
  viewportWidth?: () => number;
}

export interface DockWorkspaceOptions {
  persistence?: DockWorkspacePersistence;
  /** Which pane set this window may host; panes outside it are never rendered. */
  profile?: DockProfileId;
}

export function useDockWorkspace(initial?: DockWorkspaceLayout, options: DockWorkspaceOptions = {}): DockWorkspace {
  const profile = options.profile ?? 'main';
  const layoutState = ref<DockWorkspaceLayout>(createDefaultLayout(profile));
  if (initial) {
    try {
      layoutState.value = validateLayout(initial, profile);
    } catch {
      // A typed value can still originate from persisted or IPC data. Classic
      // remains the safe initial state when it does not satisfy the schema.
    }
  }
  const layout = computed(() => readonly(layoutState.value));
  const focusedPaneId = ref<PaneId | null>(PANE_TERMINAL);
  const focusedItemIds = ref<Partial<Record<PaneId, string>>>({});
  // Reveal is session state, not layout: an opened autohide dock re-collapses on
  // the next launch, so it is deliberately outside the persisted tree.
  const revealedPanes = ref<PaneId[]>([]);

  const paneOrder = computed(() => {
    void paneRegistryRevision.value;
    const registered = new Set(dockPaneRegistry.list(profile).map(pane => pane.id));
    return listPanes(layoutState.value.root).filter(id => registered.has(id));
  });
  const focusablePaneOrder = computed(() => {
    void paneRegistryRevision.value;
    const registered = new Set(dockPaneRegistry.list(profile).map(pane => pane.id));
    return listFocusablePanes(layoutState.value.root, revealedPanes.value).filter(id => registered.has(id));
  });
  const closedPanes = computed(() => [...layoutState.value.closed]);
  let persistQueue = Promise.resolve();

  /** A pane is visible when it is the active tab of a group in an uncollapsed dock. */
  function isVisible(paneId: PaneId): boolean {
    return focusablePaneOrder.value.includes(paneId)
      && findPaneGroup(layoutState.value.root, paneId)?.activeTab === paneId;
  }

  /** Apply a pure op, keeping focus on a pane that still participates in cycling. */
  function persist(next: DockWorkspaceLayout): void {
    const save = options.persistence?.save;
    if (!save) return;
    const detached = serializeDockLayout(next, profile);
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => save(detached))
      .catch(() => undefined);
  }

  function apply(next: DockWorkspaceLayout, shouldPersist = true): void {
    layoutState.value = next;
    // A pane that left the tree (or slipped behind a collapsed rail) must hand
    // focus back rather than strand gamepad input on something unreachable.
    revealedPanes.value = revealedPanes.value.filter(paneId => !!findPaneGroup(next.root, paneId));
    const focusable = listFocusablePanes(next.root, revealedPanes.value);
    if (!focusable.includes(focusedPaneId.value)) {
      focusedPaneId.value = focusable[0] ?? null;
    }
    if (shouldPersist) persist(next);
  }

  function reveal(paneId: PaneId): void {
    if (!findPaneGroup(layoutState.value.root, paneId)) return;
    if (!revealedPanes.value.includes(paneId)) revealedPanes.value = [...revealedPanes.value, paneId];
    focusPane(paneId);
  }

  function unreveal(paneId: PaneId): void {
    revealedPanes.value = revealedPanes.value.filter(id => id !== paneId);
    if (!focusablePaneOrder.value.includes(focusedPaneId.value)) {
      focusedPaneId.value = focusablePaneOrder.value[0] ?? null;
    }
  }

  function getFocusedItemId(paneId: PaneId): string | null {
    return focusedItemIds.value[paneId] ?? null;
  }

  function setFocusedItemId(paneId: PaneId, itemId: string | null): void {
    if (!findPaneGroup(layoutState.value.root, paneId)) return;
    if (itemId === null) {
      delete focusedItemIds.value[paneId];
    } else {
      focusedItemIds.value[paneId] = itemId;
    }
  }

  function focusPane(paneId: PaneId, focusedItemId?: string): void {
    if (!findPaneGroup(layoutState.value.root, paneId)) return;
    apply(setActiveTab(layoutState.value, paneId));
    if (focusablePaneOrder.value.includes(paneId)) {
      focusedPaneId.value = paneId;
      if (focusedItemId !== undefined) setFocusedItemId(paneId, focusedItemId);
    }
  }

  function cycleFocus(direction: 1 | -1): void {
    const order = focusablePaneOrder.value;
    if (order.length <= 1) return;
    const current = order.indexOf(focusedPaneId.value);
    const start = current === -1 ? 0 : current;
    focusPane(order[(start + direction + order.length) % order.length]);
  }

  async function loadPersisted(): Promise<DockLoadResult> {
    const persistence = options.persistence;
    let raw: unknown;
    if (persistence) {
      try {
        raw = await persistence.load();
      } catch {
        // Treat an unavailable config bridge like a first launch. The default
        // remains usable and the save below is harmless when the bridge returns.
        raw = undefined;
      }
    }
    const result = loadDockLayout(raw, {
      legacy: readLegacyDockPreferences(persistence?.legacyStorage),
      viewportWidth: persistence?.viewportWidth?.(),
      profile,
    });
    apply(result.layout, false);
    if (result.source !== 'persisted') persist(result.layout);
    return result;
  }

  return {
    layout,
    paneOrder,
    focusablePaneOrder,
    closedPanes,
    revealedPanes,
    focusedPaneId,
    isVisible,
    reveal,
    unreveal,
    focusPane,
    getFocusedItemId,
    setFocusedItemId,
    cycleFocus,
    move: (paneId, target) => apply(movePane(layoutState.value, paneId, target)),
    dockToEdge: (paneId, side) => apply(dockPaneToEdge(layoutState.value, paneId, side)),
    reorder: (paneId, index) => {
      if (canReorderTab(layoutState.value, paneId, index)) {
        apply(reorderTab(layoutState.value, paneId, index));
      }
    },
    activate: (paneId) => apply(setActiveTab(layoutState.value, paneId)),
    setMode: (paneId, mode) => apply(setDockMode(layoutState.value, paneId, mode)),
    close: (paneId) => apply(closePane(layoutState.value, paneId)),
    ensurePane: (paneId) => {
      if (findPaneGroup(layoutState.value.root, paneId) || layoutState.value.closed.includes(paneId)) return;
      apply(ensurePaneInLayout(layoutState.value, paneId));
    },
    forgetPane: (paneId) => {
      if (!findPaneGroup(layoutState.value.root, paneId) && !layoutState.value.closed.includes(paneId)) return;
      apply(forgetPaneInLayout(layoutState.value, paneId));
    },
    pruneUnregisteredPanes: () => {
      const registered = new Set(dockPaneRegistry.list(profile).map(pane => pane.id));
      const containsUnregistered = [...listPanes(layoutState.value.root), ...layoutState.value.closed]
        .some(id => !registered.has(id));
      if (containsUnregistered) apply(prunePanesInLayout(layoutState.value, registered));
    },
    restore: (paneId, target) => apply(restorePane(layoutState.value, paneId, target)),
    reset: () => {
      let next = resetLayout(profile);
      for (const descriptor of listProfilePanes(profile)) {
        if (descriptor.dynamic) next = ensurePaneInLayout(next, descriptor.id);
      }
      apply(next);
    },
    resize: (path, sizes) => apply(resizeSplit(layoutState.value, path, sizes)),
    load: (raw) => {
      try {
        apply(validateLayout(raw, profile));
        return true;
      } catch {
        apply(createDefaultLayout(profile));
        return false;
      }
    },
    loadPersisted,
    isOpen: (paneId) => !layoutState.value.closed.includes(paneId),
  };
}

/** Registry view for the View menu: every pane plus whether it is currently closed. */
export function listRegisteredPanes(layout: DockWorkspaceLayout, profile: DockProfileId = 'main') {
  void paneRegistryRevision.value;
  return listProfilePanes(profile).map(descriptor => ({
    ...descriptor,
    closed: layout.closed.includes(descriptor.id),
  }));
}

export { getPaneDescriptor };
