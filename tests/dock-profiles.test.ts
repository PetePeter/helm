/**
 * Dock pane profiles — a workspace built for a restricted pane set.
 *
 * A pop-out window hosts only the panes that make sense outside the main shell.
 * The profile is the single gate: default construction, validation of persisted
 * trees, and the View menu must all agree, or a foreign pane reaches a renderer
 * that has no component for it.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  DOCK_PANES,
  DOCK_PROFILE_PANES,
  PANE_ARTIFACTS,
  PANE_MEMORIES,
  PANE_MESS,
  PANE_PLAN_SCREEN,
  PANE_SESSIONS,
  PANE_TERMINAL,
  isProfilePane,
  listProfilePanes,
  type DockDockNode,
  type DockGroupNode,
  type DockNode,
} from '../renderer/dock-types.js';
import {
  createDefaultLayout,
  listPanes,
  validateLayout,
} from '../renderer/dock-layout.js';
import { loadDockLayout, LEGACY_SIDEBAR_WIDTH_KEY } from '../renderer/dock-persistence.js';
import { listRegisteredPanes } from '../renderer/composables/useDockWorkspace.js';

const POPOUT_PANES = [PANE_TERMINAL, PANE_PLAN_SCREEN, PANE_MEMORIES, PANE_MESS, PANE_ARTIFACTS];

describe('dock profiles', () => {
  it('derives the main profile from the registry rather than re-listing it', () => {
    expect([...DOCK_PROFILE_PANES.main]).toEqual(DOCK_PANES.map(p => p.id));
  });

  it('restricts the popout profile to the pop-out-capable panes', () => {
    expect([...DOCK_PROFILE_PANES.popout].sort()).toEqual([...POPOUT_PANES].sort());
  });

  it('answers membership per profile', () => {
    expect(isProfilePane('main', PANE_SESSIONS)).toBe(true);
    expect(isProfilePane('popout', PANE_SESSIONS)).toBe(false);
    expect(isProfilePane('popout', PANE_TERMINAL)).toBe(true);
    expect(isProfilePane('popout', 'not-a-pane')).toBe(false);
  });

  it('lists descriptors, not bare ids, in registry order', () => {
    const listed = listProfilePanes('popout');
    expect(listed.map(d => d.id).sort()).toEqual([...POPOUT_PANES].sort());
    expect(listed.every(d => typeof d.title === 'string' && typeof d.icon === 'string')).toBe(true);
  });
});

describe('createDefaultLayout(profile)', () => {
  it('leaves the main default untouched', () => {
    expect(createDefaultLayout('main')).toEqual(createDefaultLayout());
  });

  it('places exactly the popout profile panes', () => {
    const layout = createDefaultLayout('popout');
    expect(listPanes(layout.root).sort()).toEqual([...POPOUT_PANES].sort());
    expect(layout.closed).toEqual([]);
  });

  it('honours each descriptor home — views tabbed in the centre, tools on their edge', () => {
    const root = createDefaultLayout('popout').root;
    expect(root.type).toBe('split');
    const children: DockNode[] = root.type === 'split' ? root.children : [];

    const centre = children.find((child): child is DockGroupNode => child.type === 'group');
    expect(centre?.tabs).toEqual([PANE_TERMINAL, PANE_PLAN_SCREEN, PANE_MEMORIES, PANE_MESS]);

    // Artifacts is the only tool pane in the profile, and it homes right.
    const edge = children.find((child): child is DockDockNode => child.type === 'dock');
    expect(edge?.side).toBe('right');
    expect(listPanes(edge ?? null)).toEqual([PANE_ARTIFACTS]);
  });

  it('validates against its own profile', () => {
    expect(() => validateLayout(createDefaultLayout('popout'), 'popout')).not.toThrow();
  });
});

describe('validateLayout(raw, profile)', () => {
  it('rejects a layout carrying a pane outside the profile', () => {
    const raw = createDefaultLayout('main');
    expect(() => validateLayout(raw, 'popout')).toThrow(/sessions|unknown pane/i);
  });

  it('rejects a popout layout that is missing a profile pane', () => {
    const layout = createDefaultLayout('popout');
    const stripped = { ...layout, root: { type: 'group', tabs: [PANE_TERMINAL], activeTab: PANE_TERMINAL } };
    expect(() => validateLayout(stripped, 'popout')).toThrow(/missing pane/i);
  });

  it('still rejects an unknown pane under the main profile', () => {
    const raw = { version: 1, root: { type: 'group', tabs: ['nope'], activeTab: 'nope' }, closed: [] };
    expect(() => validateLayout(raw, 'main')).toThrow(/unknown pane/i);
  });

  it('never lets a foreign pane survive into the returned layout', () => {
    const layout = createDefaultLayout('popout');
    const withForeign = { ...layout, closed: [PANE_SESSIONS] };
    expect(() => validateLayout(withForeign, 'popout')).toThrow();
  });
});

describe('loadDockLayout profile handling', () => {
  const legacyStorage = { sidebarWidth: 400 };

  it('migrates legacy browser preferences for the main profile', () => {
    const result = loadDockLayout(undefined, { legacy: legacyStorage, viewportWidth: 1600 });
    expect(result.source).toBe('migrated');
    expect(result.migrated).toBe(true);
  });

  // The legacy keys describe the main window's old sidebar/artifact columns.
  // A pop-out never had those columns, so migrating them there is meaningless.
  it('does not migrate legacy preferences for a popout profile', () => {
    const result = loadDockLayout(undefined, { legacy: legacyStorage, viewportWidth: 1600, profile: 'popout' });
    expect(result.source).toBe('default');
    expect(result.migrated).toBe(false);
    expect(listPanes(result.layout.root).sort()).toEqual([...POPOUT_PANES].sort());
  });

  it('falls back to the profile default when a persisted layout is foreign', () => {
    const result = loadDockLayout(createDefaultLayout('main'), { profile: 'popout' });
    expect(result.source).toBe('fallback');
    expect(listPanes(result.layout.root).sort()).toEqual([...POPOUT_PANES].sort());
  });

  it('keeps a valid persisted popout layout', () => {
    const result = loadDockLayout(createDefaultLayout('popout'), { profile: 'popout' });
    expect(result.source).toBe('persisted');
  });

  it('exports the legacy key names it reads', () => {
    expect(LEGACY_SIDEBAR_WIDTH_KEY).toBeTruthy();
  });
});

describe('listRegisteredPanes(layout, profile)', () => {
  it('lists every pane for the main profile', () => {
    expect(listRegisteredPanes(createDefaultLayout()).map(p => p.id)).toEqual(DOCK_PANES.map(p => p.id));
  });

  it('lists only the profile panes for a popout', () => {
    const listed = listRegisteredPanes(createDefaultLayout('popout'), 'popout');
    expect(listed).toHaveLength(5);
    expect(listed.map(p => p.id).sort()).toEqual([...POPOUT_PANES].sort());
    expect(listed.every(p => p.closed === false)).toBe(true);
  });
});
