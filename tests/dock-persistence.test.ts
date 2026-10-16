import { describe, expect, it } from 'vitest';
import {
  LEGACY_ARTIFACT_VISIBLE_KEY,
  LEGACY_ARTIFACT_WIDTH_KEY,
  LEGACY_SIDEBAR_WIDTH_KEY,
  loadDockLayout,
  migrateLegacyDockPreferences,
  readLegacyDockPreferences,
  serializeDockLayout,
} from '../renderer/dock-persistence';
import { createDefaultLayout, listPanes } from '../renderer/dock-layout';
import { edgeDockLayout } from './helpers/dock-fixtures';
import { PANE_ARTIFACTS, PANE_MESS } from '../renderer/dock-types';

function storage(values: Record<string, string>) {
  return {
    getItem(key: string): string | null {
      return values[key] ?? null;
    },
  };
}

function findArtifactDock(node: ReturnType<typeof createDefaultLayout>['root']): { mode: string } | null {
  if (node.type === 'dock') {
    if (listPanes(node.child).includes(PANE_ARTIFACTS)) return node;
    return findArtifactDock(node.child);
  }
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findArtifactDock(child);
      if (found) return found;
    }
  }
  return null;
}

describe('dock persistence', () => {
  it('uses the Classic default on first launch', () => {
    const result = loadDockLayout(undefined);

    expect(result.source).toBe('default');
    expect(result.layout).toEqual(createDefaultLayout());
  });

  it('accepts a valid saved layout and returns a detached schema-checked copy', () => {
    const saved = createDefaultLayout();
    const result = loadDockLayout(JSON.parse(JSON.stringify(saved)));

    expect(result.source).toBe('persisted');
    expect(result.layout).toEqual(saved);
    expect(result.layout).not.toBe(saved);
  });

  it('keeps a saved layout from before a pane existed, offering the new pane as closed', () => {
    const older = JSON.parse(JSON.stringify(createDefaultLayout(), (key, value) =>
      key === 'tabs' && Array.isArray(value) ? value.filter((id: string) => id !== PANE_MESS) : value));
    const result = loadDockLayout(older);

    expect(result.source).toBe('persisted');
    expect(result.layout.closed).toEqual([...createDefaultLayout().closed, PANE_MESS]);
  });

  it('falls back to the Classic layout for an unsupported version', () => {
    const result = loadDockLayout({ ...createDefaultLayout(), version: 99 });

    expect(result.source).toBe('fallback');
    expect(result.layout).toEqual(createDefaultLayout());
  });

  it('reports a load with legacy settings as migrated', () => {
    const result = loadDockLayout(undefined, { legacy: { sidebarWidth: 400 }, viewportWidth: 1400 });
    expect(result.source).toBe('migrated');
    expect(result.migrated).toBe(true);
    expect(() => serializeDockLayout(result.layout)).not.toThrow();
  });

  it('migrates legacy sidebar and artifact settings into a layout with an artifact column', () => {
    const legacy = { sidebarWidth: 400, artifactWidth: 200, artifactVisible: false };
    const root = migrateLegacyDockPreferences(edgeDockLayout(), legacy, 1400).root;
    const artifactDock = findArtifactDock(root);

    expect(root.type).toBe('split');
    if (root.type === 'split') expect(root.sizes).toEqual([400 / 1400, 800 / 1400, 200 / 1400]);
    expect(artifactDock?.mode).toBe('hidden');
  });

  it('reads the exact legacy browser keys without leaking malformed values', () => {
    const prefs = {
      [LEGACY_SIDEBAR_WIDTH_KEY]: '420',
      [LEGACY_ARTIFACT_WIDTH_KEY]: 'bad',
      [LEGACY_ARTIFACT_VISIBLE_KEY]: '0',
    };
    expect(readLegacyDockPreferences(storage(prefs))).toMatchObject({
      sidebarWidth: 420,
      artifactVisible: false,
    });
    expect(readLegacyDockPreferences(storage(prefs)).artifactWidth).toBeUndefined();
  });

  it('rejects an invalid layout before it crosses the app-data boundary', () => {
    expect(() => serializeDockLayout({ version: 1, root: { type: 'empty' }, closed: [] })).toThrow(/missing pane/i);
  });

  it('validates direct legacy migration output', () => {
    const migrated = migrateLegacyDockPreferences(edgeDockLayout(), { artifactVisible: true });
    expect(findArtifactDock(migrated.root)?.mode).toBe('autohide');
  });
});
