/**
 * Dock workspace contract — serializable layout model for the prompt-IDE workspace.
 *
 * Why a hand-rolled recursive tree instead of Dockview/Golden Layout: those
 * libraries own DOM placement, which would fight xterm.js DOM ownership and the
 * existing terminal manager. Here the tree is plain data; the renderer decides
 * placement, so a terminal element can be adopted rather than remounted.
 *
 * Every pane has a stable PaneId. Nothing in this model refers to a DOM
 * selector, a fixed column, or a Vue construct.
 */

export type PaneId = string;

export type SplitDirection = 'horizontal' | 'vertical';
export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export type DockMode = 'pinned' | 'autohide' | 'hidden';

/** Views default to the centre workspace; tool windows default to an edge dock. */
export type PaneKind = 'view' | 'tool';

export interface DockSplitNode {
  type: 'split';
  direction: SplitDirection;
  /** Normalized child ratios; same length as `children`, sums to 1. */
  sizes: number[];
  children: DockNode[];
}

export interface DockGroupNode {
  type: 'group';
  tabs: PaneId[];
  activeTab: PaneId;
}

/** Canonical root for a valid workspace whose registered panes are all closed. */
export interface DockEmptyNode {
  type: 'empty';
}

export interface DockDockNode {
  type: 'dock';
  side: DockSide;
  mode: DockMode;
  child: DockNode;
}

export type DockNode = DockSplitNode | DockGroupNode | DockDockNode | DockEmptyNode;

/** Child path used by the renderer when it reports a split resize. `-1` enters a dock child. */
export type DockNodePath = number[];

/** Where a dragged/restored pane lands relative to an existing pane. */
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface DropTarget {
  /** Pane whose group/region receives the drop. */
  paneId: PaneId;
  zone: DropZone;
}

export interface DockPaneDescriptor {
  id: PaneId;
  kind: PaneKind;
  title: string;
  /**
   * Glyph shown on a collapsed dock's rail.
   *
   * A rail is ~34px wide, which fits an icon but not a word. Naming the pane
   * with an icon plus a tooltip is what lets the rail stay legible without
   * rotating text, and it lets one rail list every pane in its dock rather than
   * advertising only the first.
   */
  icon: string;
  /** Optional keyboard hint, surfaced as the tab's tooltip. */
  hint?: string;
  /** Panes that may be closed to the View menu and recovered later. */
  closable: boolean;
  /**
   * Where the pane belongs when it is restored and no explicit target is given.
   *
   * Anchored on an edge rather than on a sibling pane: a sibling can itself be
   * closed, which used to strand a restored tool window as a tab in the centre
   * group. An edge always exists — the dock is recreated if it is gone.
   */
  home: DockSide | 'center';
  /** Runtime registered panes are available only in the main workspace. */
  dynamic?: boolean;
}

export interface DockWorkspaceLayout {
  version: number;
  root: DockNode;
  /** Panes removed from the tree, recoverable via the View menu. */
  closed: PaneId[];
}

export const DOCK_LAYOUT_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared geometry
//
// The single source for the numbers the model, the drag preview and the CSS grid
// must agree on. A preview rectangle is only honest if it is derived from the
// same constants the committed tree and the rendered tracks use.
// ---------------------------------------------------------------------------

/** Share the moved pane receives when it docks to an outer workspace edge. */
export const OUTER_EDGE_RATIO = 0.25;

/** Width/height (px) of the splitter track rendered between two split children. */
export const DOCK_SPLITTER_PX = 4;

/** `minmax()` floor (px) of a non-collapsed split track. */
export const DOCK_MIN_TRACK_PX = 96;

/**
 * Size of one track of a two-child split, as the grid actually resolves it.
 *
 * `minmax(96px, Nfr)` means the `fr` share is a request, not a promise: the
 * floor wins for the small track, and the sibling's floor caps the large one.
 * Below two floors the browser shrinks both equally.
 */
export function splitTrackSize(total: number, ratio: number): number {
  const available = Math.max(0, total - DOCK_SPLITTER_PX);
  if (available <= DOCK_MIN_TRACK_PX * 2) return available / 2;
  return Math.min(Math.max(available * ratio, DOCK_MIN_TRACK_PX), available - DOCK_MIN_TRACK_PX);
}

export const PANE_TERMINAL = 'terminal';
export const PANE_PLAN_SCREEN = 'plan-screen';
export const PANE_MEMORIES = 'memories';
export const PANE_SESSIONS = 'sessions';
export const PANE_SCHEDULER = 'scheduler';
export const PANE_QUICK_SPAWN = 'quick-spawn';
export const PANE_PLAN_DIRECTORIES = 'plan-directories';
export const PANE_ARTIFACTS = 'artifacts';
export const PANE_MESS = 'mess';
export const PANE_TIMESHEET = 'timesheet';

/**
 * The pane registry. Registration is id-keyed data, so a later renderer plan can
 * map ids to components without the model knowing about them.
 */
export const DOCK_PANES: readonly DockPaneDescriptor[] = Object.freeze([
  Object.freeze({ id: PANE_TERMINAL, kind: 'view', title: 'Terminal', icon: '▶', hint: 'Ctrl+Shift+T', closable: true, home: 'center' }),
  Object.freeze({ id: PANE_PLAN_SCREEN, kind: 'view', title: 'Plans', icon: '🗺', hint: 'Ctrl+Shift+P', closable: true, home: 'center' }),
  Object.freeze({ id: PANE_MEMORIES, kind: 'view', title: 'Memories', icon: '🧠', hint: 'Ctrl+Shift+M', closable: true, home: 'center' }),
  Object.freeze({ id: PANE_MESS, kind: 'view', title: 'Mess', icon: '🍽', closable: true, home: 'center' }),
  Object.freeze({ id: PANE_TIMESHEET, kind: 'view', title: 'Timesheet', icon: '⏱', closable: true, home: 'center' }),
  Object.freeze({ id: PANE_SESSIONS, kind: 'tool', title: 'Sessions', icon: '🗂', hint: 'Ctrl+Shift+S', closable: true, home: 'left' }),
  Object.freeze({ id: PANE_SCHEDULER, kind: 'tool', title: 'Scheduler', icon: '🕘', closable: true, home: 'left' }),
  Object.freeze({
    id: PANE_QUICK_SPAWN,
    kind: 'tool',
    title: 'Quick Spawn',
    icon: '✦',
    hint: 'Ctrl+Shift+N / Ctrl+Shift+W',
    closable: true,
    home: 'left',
  }),
  Object.freeze({ id: PANE_PLAN_DIRECTORIES, kind: 'tool', title: 'Projects', icon: '📁', closable: true, home: 'left' }),
  Object.freeze({ id: PANE_ARTIFACTS, kind: 'tool', title: 'Artifacts', icon: '📄', hint: 'Ctrl+Shift+A', closable: true, home: 'right' }),
]);

// ---------------------------------------------------------------------------
// Pane profiles
//
// A window hosts a subset of the registry: a pop-out has no session list and no
// spawn tools, because the things they act on live in the main shell. The
// profile is data, like the registry itself, so the default layout, the
// validator and the View menu all read the same allow-list instead of each
// carrying its own idea of which panes belong.
// ---------------------------------------------------------------------------

export type DockProfileId = 'main' | 'popout';

export const DOCK_PROFILE_PANES: Readonly<Record<DockProfileId, readonly PaneId[]>> = Object.freeze({
  // Derived, never re-listed: a pane added to the registry is in the main
  // profile by construction.
  main: Object.freeze(DOCK_PANES.map(p => p.id)),
  popout: Object.freeze([PANE_TERMINAL, PANE_PLAN_SCREEN, PANE_MEMORIES, PANE_MESS, PANE_ARTIFACTS]),
});

/** Mutable registry for descriptors that exist only while their owner exists. */
export class DockPaneRegistry {
  private readonly panes = new Map<PaneId, DockPaneDescriptor>();
  private readonly listeners = new Set<() => void>();

  constructor(panes: readonly DockPaneDescriptor[]) {
    for (const pane of panes) this.panes.set(pane.id, pane);
  }

  get(id: PaneId): DockPaneDescriptor | undefined {
    return this.panes.get(id);
  }

  list(profile: DockProfileId = 'main'): DockPaneDescriptor[] {
    return [...this.panes.values()].filter(pane =>
      DOCK_PROFILE_PANES[profile].includes(pane.id) || (profile === 'main' && pane.dynamic === true));
  }

  register(descriptor: DockPaneDescriptor): void {
    if (!descriptor.id) throw new Error('dock registry: pane id is required');
    const previous = this.panes.get(descriptor.id);
    if (previous && !previous.dynamic) throw new Error(`dock registry: pane "${descriptor.id}" is static`);
    this.panes.set(descriptor.id, Object.freeze({ ...descriptor }));
    this.changed();
  }

  unregister(id: PaneId): void {
    if (!this.panes.get(id)?.dynamic) return;
    this.panes.delete(id);
    this.changed();
  }

  isProfilePane(profile: DockProfileId, id: PaneId): boolean {
    const descriptor = this.panes.get(id);
    return !!descriptor && (DOCK_PROFILE_PANES[profile].includes(id) || (profile === 'main' && descriptor.dynamic === true));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export const dockPaneRegistry = new DockPaneRegistry(DOCK_PANES);

/** Static panes define required workspace slots; runtime panes are optional. */
export function listStaticProfilePanes(profile: DockProfileId): DockPaneDescriptor[] {
  return DOCK_PANES.filter(pane => DOCK_PROFILE_PANES[profile].includes(pane.id));
}

/** Descriptors of a profile's panes, in registry order. */
export function listProfilePanes(profile: DockProfileId): DockPaneDescriptor[] {
  return dockPaneRegistry.list(profile);
}

export function isProfilePane(profile: DockProfileId, paneId: PaneId): boolean {
  return dockPaneRegistry.isProfilePane(profile, paneId);
}

export function getPaneDescriptor(paneId: PaneId): DockPaneDescriptor | undefined {
  return dockPaneRegistry.get(paneId);
}

export function isKnownPane(paneId: PaneId): boolean {
  return !!dockPaneRegistry.get(paneId);
}
