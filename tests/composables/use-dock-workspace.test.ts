import { describe, it, expect } from 'vitest';
import { useDockWorkspace } from '../../renderer/composables/useDockWorkspace';
import { activeTabs, createDefaultLayout, listPanes } from '../../renderer/dock-layout';
import { edgeDockLayout } from '../helpers/dock-fixtures';
import {
  PANE_ARTIFACTS,
  PANE_CHAT,
  PANE_DRAFT,
  PANE_MEMORIES,
  PANE_PLAN_SCREEN,
  PANE_SCHEDULER,
  PANE_TIMESHEET,
  PANE_SESSIONS,
  PANE_TERMINAL,
  PANE_TODOS,
} from '../../renderer/dock-types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('useDockWorkspace', () => {
  it('starts on the Classic layout with the terminal focused', () => {
    const ws = useDockWorkspace();
    expect(ws.paneOrder.value).toEqual(listPanes(createDefaultLayout().root));
    expect(ws.focusedPaneId.value).toBe(PANE_TERMINAL);
    expect(ws.isVisible(PANE_TERMINAL)).toBe(true);
    expect(ws.isVisible(PANE_MEMORIES)).toBe(false);
  });

  it('focusing a background tab activates it in its own group', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.focusPane(PANE_MEMORIES);
    expect(ws.isVisible(PANE_MEMORIES)).toBe(true);
    expect(ws.isVisible(PANE_TERMINAL)).toBe(false);
    expect(ws.focusedPaneId.value).toBe(PANE_MEMORIES);
  });

  it('issues a new focus request when an already-focused pane is activated again', () => {
    const ws = useDockWorkspace();
    ws.focusPane(PANE_CHAT);
    const firstRequest = ws.focusRequestId.value;

    ws.focusPane(PANE_CHAT);

    expect(ws.focusRequestId.value).toBe(firstRequest + 1);
  });

  it('cycles focus in deterministic tree order and wraps', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.focusPane(PANE_SESSIONS);
    ws.cycleFocus(-1);
    expect(ws.focusedPaneId.value).toBe(PANE_TIMESHEET); // autohide panes are not focus targets
    ws.cycleFocus(1);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
  });

  it('revealing an autohide pane makes it visible, focusable, and focused', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    expect(ws.focusablePaneOrder.value).not.toContain(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);

    ws.reveal(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([PANE_ARTIFACTS]);
    expect(ws.focusablePaneOrder.value).toContain(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(true);
    expect(ws.focusedPaneId.value).toBe(PANE_ARTIFACTS);
  });

  it('collapsing a revealed pane hands focus back to a reachable pane', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.reveal(PANE_ARTIFACTS);

    ws.unreveal(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([]);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.focusablePaneOrder.value).toContain(ws.focusedPaneId.value!);
  });

  it('closing a revealed pane drops the reveal so focus cannot strand on it', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.reveal(PANE_ARTIFACTS);

    ws.close(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([]);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
  });

  it('restores a closed view pane and focuses it — the view-transition reconcile path', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.close(PANE_MEMORIES);
    expect(ws.isOpen(PANE_MEMORIES)).toBe(false);

    ws.restore(PANE_MEMORIES);
    ws.activate(PANE_MEMORIES);
    ws.focusPane(PANE_MEMORIES);

    expect(ws.isOpen(PANE_MEMORIES)).toBe(true);
    expect(ws.isVisible(PANE_MEMORIES)).toBe(true);
    expect(ws.focusedPaneId.value).toBe(PANE_MEMORIES);
  });

  it('resizes a recursive split through the workspace facade', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.resize([], [0.3, 0.56, 0.14]);

    expect(ws.layout.value.root).toMatchObject({
      type: 'split',
      sizes: [0.3, 0.56, 0.14],
    });
  });

  it('remembers pane-local focus identity while cycling between panes', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.setFocusedItemId(PANE_SESSIONS, 'session:s1');
    ws.focusPane(PANE_MEMORIES, 'card:s2');

    expect(ws.getFocusedItemId(PANE_MEMORIES)).toBe('card:s2');
    expect(ws.getFocusedItemId(PANE_SESSIONS)).toBe('session:s1');

    ws.focusPane(PANE_SESSIONS);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
    expect(ws.getFocusedItemId(PANE_SESSIONS)).toBe('session:s1');
  });

  it('moves focus off a pane that gets closed', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.focusPane(PANE_ARTIFACTS);
    ws.close(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([PANE_ARTIFACTS]);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);

    ws.restore(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([]);
    expect(ws.paneOrder.value).toContain(PANE_ARTIFACTS);
  });

  it('falls back to Classic when an invalid layout is loaded', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.close(PANE_ARTIFACTS);

    expect(ws.load({ version: 99 })).toBe(false);
    expect(ws.layout.value).toEqual(createDefaultLayout());

    expect(ws.load(JSON.parse(JSON.stringify(createDefaultLayout())))).toBe(true);
  });

  it('clones a typed initial layout and does not expose writable layout state', () => {
    const initial = edgeDockLayout();
    const ws = useDockWorkspace(initial);
    initial.closed.push(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(ws.layout, 'value')?.set).toBeUndefined();
  });

  it('skips panes under hidden docks during focus cycling', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.setMode(PANE_ARTIFACTS, 'hidden');
    ws.focusPane(PANE_SESSIONS);
    ws.cycleFocus(-1);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);
  });

  it('moves focus away when the focused pane becomes auto-hidden', () => {
    const ws = useDockWorkspace(edgeDockLayout());
    ws.setMode(PANE_ARTIFACTS, 'pinned');
    ws.focusPane(PANE_ARTIFACTS);
    ws.setMode(PANE_ARTIFACTS, 'autohide');

    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
  });

  it('does not focus a pane explicitly while it is auto-hidden', () => {
    const ws = useDockWorkspace(edgeDockLayout());

    ws.focusPane(PANE_ARTIFACTS);

    expect(ws.focusedPaneId.value).toBe(PANE_TERMINAL);
  });

  it('loads from app-data, persists a safe fallback, and preserves pane recovery', async () => {
    const saved: unknown[] = [];
    const ws = useDockWorkspace(undefined, {
      persistence: {
        load: () => ({ version: 99 }),
        save: (layout) => { saved.push(layout); },
      },
    });

    const result = await ws.loadPersisted();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(result.source).toBe('fallback');
    expect(ws.closedPanes.value).toEqual(createDefaultLayout().closed);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ layout: createDefaultLayout(), sessionTabs: {} });

    ws.close(PANE_ARTIFACTS);
    expect(ws.isOpen(PANE_ARTIFACTS)).toBe(false);
    ws.restore(PANE_ARTIFACTS);
    expect(ws.isOpen(PANE_ARTIFACTS)).toBe(true);

    ws.close(PANE_ARTIFACTS);
    ws.reset();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ws.layout.value).toEqual(createDefaultLayout());
    expect(saved.at(-1)).toEqual({ layout: createDefaultLayout(), sessionTabs: {} });
  });

  it('restores each session snapshot across A→B→A with one write per changed switch', async () => {
    const layout = createDefaultLayout();
    const saved = {
      layout,
      sessionTabs: {
        sessionA: [PANE_CHAT, PANE_TODOS],
        sessionB: [PANE_ARTIFACTS, PANE_DRAFT],
      },
    };
    const writes: Array<{ layout: unknown; sessionTabs: Record<string, string[]> }> = [];
    const ws = useDockWorkspace(undefined, {
      persistence: {
        load: () => clone(saved),
        save: (snapshot) => { writes.push(clone(snapshot)); },
      },
    });

    await ws.loadPersisted();
    ws.switchSessionTabs(null, 'sessionA');
    await new Promise(resolve => setTimeout(resolve, 0));
    writes.length = 0;

    ws.switchSessionTabs('sessionA', 'sessionB');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(activeTabs(ws.layout.value)).toEqual([PANE_SESSIONS, PANE_ARTIFACTS, PANE_DRAFT]);
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionTabs.sessionA).toEqual([PANE_SESSIONS, PANE_CHAT, PANE_TODOS]);

    writes.length = 0;
    ws.switchSessionTabs('sessionB', 'sessionA');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(activeTabs(ws.layout.value)).toEqual([PANE_SESSIONS, PANE_CHAT, PANE_TODOS]);
    expect(writes).toHaveLength(1);
  });

  it('ignores session changes until the persisted dock state has loaded', async () => {
    const saved = {
      layout: edgeDockLayout(),
      sessionTabs: {
        sessionA: [PANE_CHAT, PANE_TODOS],
        sessionB: [PANE_DRAFT],
      },
    };
    const writes: Array<{ layout: unknown; sessionTabs: Record<string, string[]> }> = [];
    let resolveLoad!: (value: unknown) => void;
    const pendingLoad = new Promise<unknown>(resolve => { resolveLoad = resolve; });
    const ws = useDockWorkspace(undefined, {
      persistence: {
        load: () => pendingLoad,
        save: snapshot => { writes.push(clone(snapshot)); },
      },
    });

    const loading = ws.loadPersisted();
    ws.switchSessionTabs('sessionA', 'sessionB');
    ws.pruneSessionTabs(['sessionA'], []);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toHaveLength(0);

    resolveLoad(clone(saved));
    await loading;
    expect(ws.layout.value).toEqual(saved.layout);

    ws.switchSessionTabs(null, 'sessionB');
    expect(activeTabs(ws.layout.value)).toEqual([PANE_SESSIONS, PANE_SCHEDULER, PANE_TERMINAL, PANE_DRAFT]);
  });

  it('leaves the layout alone without a snapshot and writes nothing for an identical switch', async () => {
    const layout = createDefaultLayout();
    const currentTabs = activeTabs(layout);
    const writes: unknown[] = [];
    const ws = useDockWorkspace(undefined, {
      persistence: {
        load: () => ({ layout, sessionTabs: { sessionA: currentTabs, sessionB: currentTabs } }),
        save: snapshot => { writes.push(snapshot); },
      },
    });

    await ws.loadPersisted();
    const before = ws.layout.value;
    ws.switchSessionTabs('sessionA', 'sessionC');
    ws.switchSessionTabs('sessionA', 'sessionB');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ws.layout.value).toBe(before);
    expect(writes).toHaveLength(0);
  });

  it('prunes only IDs removed from the previous session list, preserving startup and partial lists', async () => {
    const layout = createDefaultLayout();
    const saved = {
      layout,
      sessionTabs: { sessionA: [PANE_CHAT], sessionB: [PANE_ARTIFACTS] },
    };
    const writes: Array<{ layout: unknown; sessionTabs: Record<string, string[]> }> = [];
    const ws = useDockWorkspace(undefined, {
      persistence: {
        load: () => clone(saved),
        save: snapshot => { writes.push(clone(snapshot)); },
      },
    });

    await ws.loadPersisted();
    ws.pruneSessionTabs([], []);
    ws.pruneSessionTabs([], ['sessionA']);
    ws.pruneSessionTabs(['sessionA'], ['sessionA', 'sessionB']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toHaveLength(0);

    ws.pruneSessionTabs(['sessionA', 'sessionB'], ['sessionB']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionTabs).toEqual({ sessionB: [PANE_ARTIFACTS] });
  });
});
