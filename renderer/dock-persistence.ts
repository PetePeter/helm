/**
 * Persistence boundary for the dock workspace.
 *
 * The layout is stored by the main process in settings.yaml. This module is
 * the only renderer-side code that interprets that untrusted value, so an
 * older/newer or damaged settings entry can never make the shell fail to
 * start. Legacy localStorage values are read only when no workspace layout
 * exists and are converted into the versioned layout once.
 */

import {
  createDefaultLayout,
  listPanes,
  validateLayout,
} from './dock-layout';
import {
  PANE_ARTIFACTS,
  type DockDockNode,
  type DockProfileId,
  type DockNode,
  type DockSplitNode,
  type DockWorkspaceLayout,
  type PaneId,
} from './dock-types';

export const LEGACY_SIDEBAR_WIDTH_KEY = 'gamepad-hub:panel-width';
export const LEGACY_ARTIFACT_WIDTH_KEY = 'helm:artifact-panel-width';
export const LEGACY_ARTIFACT_VISIBLE_KEY = 'helm:artifact-panel-visible';

export interface DockStorage {
  getItem(key: string): string | null;
}

export interface LegacyDockPreferences {
  sidebarWidth?: number;
  artifactWidth?: number;
  artifactVisible?: boolean;
}

export type DockLoadSource = 'default' | 'migrated' | 'persisted' | 'fallback';

export interface DockLoadResult {
  layout: DockWorkspaceLayout;
  source: DockLoadSource;
  /** True when old localStorage values were incorporated into the layout. */
  migrated: boolean;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function parseWidth(storage: DockStorage, key: string): number | undefined {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return isFinitePositive(value) ? value : undefined;
}

function parseBool(storage: DockStorage, key: string): boolean | undefined {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
}

/** Read the old panel keys without allowing a broken browser storage value to escape. */
export function readLegacyDockPreferences(storage?: DockStorage): LegacyDockPreferences {
  if (!storage) {
    try {
      storage = window.localStorage;
    } catch {
      return {};
    }
  }

  try {
    return {
      sidebarWidth: parseWidth(storage, LEGACY_SIDEBAR_WIDTH_KEY),
      artifactWidth: parseWidth(storage, LEGACY_ARTIFACT_WIDTH_KEY),
      artifactVisible: parseBool(storage, LEGACY_ARTIFACT_VISIBLE_KEY),
    };
  } catch {
    return {};
  }
}

function mapNode(node: DockNode, fn: (node: DockNode) => DockNode): DockNode {
  const mapped = fn(node);
  if (mapped !== node) return mapped;
  if (node.type === 'dock') return { ...node, child: mapNode(node.child, fn) };
  if (node.type === 'split') return { ...node, children: node.children.map(child => mapNode(child, fn)) };
  return node;
}

function findDock(node: DockNode, paneId: PaneId): DockDockNode | null {
  if (node.type === 'dock') return listPanes(node.child).includes(paneId) ? node : findDock(node.child, paneId);
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findDock(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

function withLegacyWidths(
  layout: DockWorkspaceLayout,
  legacy: LegacyDockPreferences,
  viewportWidth?: number,
): DockWorkspaceLayout {
  if (!isFinitePositive(viewportWidth ?? 0)) return layout;
  if (!legacy.sidebarWidth && !legacy.artifactWidth) return layout;

  const root = layout.root;
  if (root.type !== 'split' || root.direction !== 'horizontal' || root.children.length < 3) return layout;

  const leftIndex = root.children.findIndex(child => listPanes(child).some(id => id !== PANE_ARTIFACTS));
  const artifactIndex = root.children.findIndex(child => listPanes(child).includes(PANE_ARTIFACTS));
  if (leftIndex < 0 || artifactIndex < 0 || leftIndex === artifactIndex) return layout;

  const leftWidth = legacy.sidebarWidth ?? (root.sizes[leftIndex] * viewportWidth!);
  const artifactWidth = legacy.artifactWidth ?? (root.sizes[artifactIndex] * viewportWidth!);

  // Only the two edges had a legacy width. Whatever is between them — one centre
  // group or several — keeps its own
  // proportions inside the remaining space.
  const centerIndices = root.children
    .map((_, index) => index)
    .filter(index => index !== leftIndex && index !== artifactIndex);
  const centerShare = centerIndices.reduce((sum, index) => sum + root.sizes[index], 0);
  if (centerIndices.length === 0 || centerShare <= 0) return layout;

  const centerWidth = Math.max(1, viewportWidth! - leftWidth - artifactWidth);
  const total = leftWidth + centerWidth + artifactWidth;
  const sizes = [...root.sizes];
  sizes[leftIndex] = leftWidth / total;
  sizes[artifactIndex] = artifactWidth / total;
  for (const index of centerIndices) {
    sizes[index] = (centerWidth * (root.sizes[index] / centerShare)) / total;
  }

  const nextRoot: DockSplitNode = { ...root, sizes };
  return { ...layout, root: nextRoot };
}

/** Convert legacy panel width/visibility state into the current versioned tree. */
export function migrateLegacyDockPreferences(
  base: DockWorkspaceLayout = createDefaultLayout(),
  legacy: LegacyDockPreferences,
  viewportWidth?: number,
): DockWorkspaceLayout {
  let migrated = withLegacyWidths(base, legacy, viewportWidth);
  const shouldHideArtifact = legacy.artifactVisible === false;
  const shouldShowArtifact = legacy.artifactVisible === true;

  if (shouldHideArtifact || shouldShowArtifact) {
    const artifactDock = findDock(migrated.root, PANE_ARTIFACTS);
    if (artifactDock) {
      const mode = shouldHideArtifact ? 'hidden' : 'autohide';
      migrated = {
        ...migrated,
        root: mapNode(migrated.root, node =>
          node === artifactDock ? { ...node, mode } : node),
      };
    }
  }
  return validateLayout(migrated);
}

function hasLegacyPreferences(legacy: LegacyDockPreferences): boolean {
  return Object.values(legacy).some(value => value !== undefined);
}

/** Parse a persisted layout, falling back safely and migrating legacy state only when absent. */
export function loadDockLayout(
  raw: unknown,
  options: { legacy?: LegacyDockPreferences; viewportWidth?: number; profile?: DockProfileId } = {},
): DockLoadResult {
  const profile = options.profile ?? 'main';
  if (raw !== undefined && raw !== null) {
    try {
      return { layout: validateLayout(raw, profile), source: 'persisted', migrated: false };
    } catch {
      return { layout: createDefaultLayout(profile), source: 'fallback', migrated: false };
    }
  }

  // The legacy keys describe the main window's old sidebar and artifact columns.
  // No other profile ever had them, so migrating there would invent state.
  const legacy = profile === 'main' ? options.legacy ?? {} : {};
  if (hasLegacyPreferences(legacy)) {
    return {
      layout: migrateLegacyDockPreferences(createDefaultLayout(), legacy, options.viewportWidth),
      source: 'migrated',
      migrated: true,
    };
  }
  return { layout: createDefaultLayout(profile), source: 'default', migrated: false };
}

/** Return a detached, schema-checked copy ready to cross the IPC boundary. */
export function serializeDockLayout(
  layout: DockWorkspaceLayout,
  profile: DockProfileId = 'main',
): DockWorkspaceLayout {
  return validateLayout(layout, profile);
}
