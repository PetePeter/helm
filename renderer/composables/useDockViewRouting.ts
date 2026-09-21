/**
 * Dock ↔ view-mode reconciliation for the main shell.
 *
 * main-view-manager stays the view transition authority; the dock mirrors it.
 * Reconciling here — rather than a second routing path — is what lets a normal
 * openPlan()/openOverview() bring back a view pane the user closed to the View
 * menu, instead of transitioning into a pane that is not in the tree.
 *
 * Only panes that *represent* a view mode take part. Tool panes (Team View,
 * Sessions, Artifacts, …) are pure projections of existing state: focusing one
 * must never start a view transition, because a transition cancels whatever
 * navigation the same click is about to perform.
 *
 * Extracted from `MainWindowApp.vue` so the reconciliation is testable against
 * the real navigation store instead of a mounted shell.
 */

import type { Ref } from 'vue';
import type { MainView as ViewName } from '../main-view/main-view-manager.js';
import { PANE_ARTIFACTS, PANE_PLAN_SCREEN, PANE_TERMINAL, type PaneId } from '../dock-types.js';

/** The dock workspace surface this module drives. */
export interface DockViewRoutingWorkspace {
  isOpen(paneId: PaneId): boolean;
  isVisible(paneId: PaneId): boolean;
  restore(paneId: PaneId): void;
  reveal(paneId: PaneId): void;
  unreveal(paneId: PaneId): void;
  activate(paneId: PaneId): void;
  focusPane(paneId: PaneId, focusedItemId?: string): void;
  close(paneId: PaneId): void;
}

/** The navigation-store slice used for view-mode lifecycles. */
export interface DockViewRoutingNavigation {
  openPlan(dirPath: string): Promise<void> | void;
  closePlan(): Promise<void> | void;
  closeOverview(): Promise<void> | void;
}

export interface DockViewRoutingDeps {
  activeView: Ref<ViewName>;
  dock: DockViewRoutingWorkspace;
  navStore: DockViewRoutingNavigation;
  /** Artifacts keeps content/session state for snapped-out windows. */
  artifacts: { showPanel(): void; hidePanel(): void };
  getActiveSessionDir: () => string | null | undefined;
}

/**
 * Panes that represent a view mode.
 *
 * `overview` (the legacy fullscreen group-overview grid) is deliberately absent:
 * the `overview` *pane id* now hosts Team View, a dockable tool. The view mode
 * itself still exists and is still reached through `openOverview()`.
 */
const VIEW_PANES: ReadonlyArray<readonly [ViewName, PaneId]> = [
  ['terminal', PANE_TERMINAL],
  ['plan', PANE_PLAN_SCREEN],
];

const PANE_BY_VIEW = new Map<ViewName, PaneId>(VIEW_PANES.map(([view, pane]) => [view, pane]));
const VIEW_BY_PANE = new Map<PaneId, ViewName>(VIEW_PANES.map(([view, pane]) => [pane, view]));

/** The pane that represents a view mode, if any. */
export function paneForView(view: ViewName): PaneId | undefined {
  return PANE_BY_VIEW.get(view);
}

/** The view mode a pane represents, if any. Tool panes answer `undefined`. */
export function viewForPane(paneId: PaneId): ViewName | undefined {
  return VIEW_BY_PANE.get(paneId);
}

/** View panes in deterministic order, for "which view is on screen" questions. */
const VIEW_PANE_IDS: readonly PaneId[] = VIEW_PANES.map(([, pane]) => pane);

export function createDockViewRouting(deps: DockViewRoutingDeps) {
  const { activeView, dock, navStore, artifacts } = deps;

  // Guards the async tail of `activateDockPane`: a newer activation must win.
  let dockNavigationRequest = 0;

  /** Adopt the view whose pane the restored layout actually shows. */
  function syncViewFromDockLayout(): void {
    const activePane = VIEW_PANE_IDS.find(paneId => dock.isOpen(paneId) && dock.isVisible(paneId));
    const view = activePane ? viewForPane(activePane) : undefined;
    if (view) activeView.value = view;
  }

  /** Leave a view whose pane the user closed, for one that is still docked. */
  function fallbackToOpenView(): void {
    const currentPane = paneForView(activeView.value);
    if (currentPane && dock.isOpen(currentPane)) return;
    const fallback = VIEW_PANE_IDS.find(paneId => dock.isOpen(paneId));
    const view = fallback ? viewForPane(fallback) : undefined;
    if (view) activeView.value = view;
  }

  /**
   * Select a pane through one shell-owned path. View panes must pass through the
   * navigation store so their mount/unmount lifecycle initializes data; tool
   * panes only need dock activation/focus.
   */
  async function activateDockPane(paneId: PaneId, reveal = false, focusedItemId?: string): Promise<void> {
    const requestId = ++dockNavigationRequest;
    try {
      if (!dock.isOpen(paneId)) dock.restore(paneId);
      if (reveal) dock.reveal(paneId);
      else dock.activate(paneId);
    } catch {
      return;
    }

    if (paneId === PANE_PLAN_SCREEN) {
      const dirPath = deps.getActiveSessionDir();
      if (dirPath) await navStore.openPlan(dirPath);
    } else if (paneId === PANE_TERMINAL) {
      // The legacy fullscreen overview is still a view the terminal must leave.
      if (activeView.value === 'overview') await navStore.closeOverview();
      else if (activeView.value === 'plan') await navStore.closePlan();
    } else if (paneId === PANE_ARTIFACTS) {
      artifacts.showPanel();
    }

    if (requestId !== dockNavigationRequest) return;
    dock.focusPane(paneId, focusedItemId);
  }

  async function closeDockPane(paneId: PaneId): Promise<void> {
    const view = viewForPane(paneId);
    const wasActiveView = view === activeView.value;

    if (wasActiveView && view === 'plan') await navStore.closePlan();

    try {
      dock.close(paneId);
    } catch {
      return;
    }

    if (paneId === PANE_ARTIFACTS) artifacts.hidePanel();

    if (wasActiveView && view === 'terminal') {
      const fallback = dock.isOpen(PANE_PLAN_SCREEN) ? PANE_PLAN_SCREEN : undefined;
      if (fallback) void activateDockPane(fallback);
      else fallbackToOpenView();
    }
  }

  /**
   * DOM focus reached a pane. A view pane that is not the active view needs the
   * full activation path; everything else is a focus move and nothing more —
   * notably not a view transition that would cancel the click in flight.
   */
  function onDockFocusPane(paneId: PaneId, focusedItemId?: string): void {
    const view = viewForPane(paneId);
    if (view && view !== activeView.value) {
      void activateDockPane(paneId, false, focusedItemId);
      return;
    }
    dock.focusPane(paneId, focusedItemId);
  }

  function onDockAutohideClose(paneId: PaneId): void {
    dock.unreveal(paneId);
    if (paneId === PANE_ARTIFACTS) artifacts.hidePanel();
  }

  /** Invalidate any in-flight activation — used when the layout is reset. */
  function invalidateActivations(): void {
    dockNavigationRequest++;
  }

  return {
    activateDockPane,
    closeDockPane,
    onDockFocusPane,
    onDockAutohideClose,
    syncViewFromDockLayout,
    fallbackToOpenView,
    invalidateActivations,
    paneForView,
    viewForPane,
  };
}
