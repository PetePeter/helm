import { describe, it, expect } from 'vitest';
import { useDockWorkspace } from '../../renderer/composables/useDockWorkspace';
import { createDefaultLayout, listPanes } from '../../renderer/dock-layout';
import {
  PANE_ARTIFACTS,
  PANE_MEMORIES,
  PANE_PLAN_SCREEN,
  PANE_MESS,
  PANE_SESSIONS,
  PANE_TERMINAL,
} from '../../renderer/dock-types';

describe('useDockWorkspace', () => {
  it('starts on the Classic layout with the terminal focused', () => {
    const ws = useDockWorkspace();
    expect(ws.paneOrder.value).toEqual(listPanes(createDefaultLayout().root));
    expect(ws.focusedPaneId.value).toBe(PANE_TERMINAL);
    expect(ws.isVisible(PANE_TERMINAL)).toBe(true);
    expect(ws.isVisible(PANE_MEMORIES)).toBe(false);
  });

  it('focusing a background tab activates it in its own group', () => {
    const ws = useDockWorkspace();
    ws.focusPane(PANE_MEMORIES);
    expect(ws.isVisible(PANE_MEMORIES)).toBe(true);
    expect(ws.isVisible(PANE_TERMINAL)).toBe(false);
    expect(ws.focusedPaneId.value).toBe(PANE_MEMORIES);
  });

  it('cycles focus in deterministic tree order and wraps', () => {
    const ws = useDockWorkspace();
    ws.focusPane(PANE_SESSIONS);
    ws.cycleFocus(-1);
    expect(ws.focusedPaneId.value).toBe(PANE_MESS); // autohide panes are not focus targets
    ws.cycleFocus(1);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
  });

  it('revealing an autohide pane makes it visible, focusable, and focused', () => {
    const ws = useDockWorkspace();
    expect(ws.focusablePaneOrder.value).not.toContain(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);

    ws.reveal(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([PANE_ARTIFACTS]);
    expect(ws.focusablePaneOrder.value).toContain(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(true);
    expect(ws.focusedPaneId.value).toBe(PANE_ARTIFACTS);
  });

  it('collapsing a revealed pane hands focus back to a reachable pane', () => {
    const ws = useDockWorkspace();
    ws.reveal(PANE_ARTIFACTS);

    ws.unreveal(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([]);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.focusablePaneOrder.value).toContain(ws.focusedPaneId.value!);
  });

  it('closing a revealed pane drops the reveal so focus cannot strand on it', () => {
    const ws = useDockWorkspace();
    ws.reveal(PANE_ARTIFACTS);

    ws.close(PANE_ARTIFACTS);

    expect(ws.revealedPanes.value).toEqual([]);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
  });

  it('restores a closed view pane and focuses it — the view-transition reconcile path', () => {
    const ws = useDockWorkspace();
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
    const ws = useDockWorkspace();
    ws.resize([], [0.3, 0.56, 0.14]);

    expect(ws.layout.value.root).toMatchObject({
      type: 'split',
      sizes: [0.3, 0.56, 0.14],
    });
  });

  it('remembers pane-local focus identity while cycling between panes', () => {
    const ws = useDockWorkspace();
    ws.setFocusedItemId(PANE_SESSIONS, 'session:s1');
    ws.focusPane(PANE_MEMORIES, 'card:s2');

    expect(ws.getFocusedItemId(PANE_MEMORIES)).toBe('card:s2');
    expect(ws.getFocusedItemId(PANE_SESSIONS)).toBe('session:s1');

    ws.focusPane(PANE_SESSIONS);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
    expect(ws.getFocusedItemId(PANE_SESSIONS)).toBe('session:s1');
  });

  it('moves focus off a pane that gets closed', () => {
    const ws = useDockWorkspace();
    ws.focusPane(PANE_ARTIFACTS);
    ws.close(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([PANE_ARTIFACTS]);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);

    ws.restore(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([]);
    expect(ws.paneOrder.value).toContain(PANE_ARTIFACTS);
  });

  it('falls back to Classic when an invalid layout is loaded', () => {
    const ws = useDockWorkspace();
    ws.close(PANE_ARTIFACTS);

    expect(ws.load({ version: 99 })).toBe(false);
    expect(ws.layout.value).toEqual(createDefaultLayout());

    expect(ws.load(JSON.parse(JSON.stringify(createDefaultLayout())))).toBe(true);
  });

  it('clones a typed initial layout and does not expose writable layout state', () => {
    const initial = createDefaultLayout();
    const ws = useDockWorkspace(initial);
    initial.closed.push(PANE_ARTIFACTS);
    expect(ws.closedPanes.value).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(ws.layout, 'value')?.set).toBeUndefined();
  });

  it('skips panes under hidden docks during focus cycling', () => {
    const ws = useDockWorkspace();
    ws.setMode(PANE_ARTIFACTS, 'hidden');
    ws.focusPane(PANE_SESSIONS);
    ws.cycleFocus(-1);
    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.isVisible(PANE_ARTIFACTS)).toBe(false);
  });

  it('moves focus away when the focused pane becomes auto-hidden', () => {
    const ws = useDockWorkspace();
    ws.setMode(PANE_ARTIFACTS, 'pinned');
    ws.focusPane(PANE_ARTIFACTS);
    ws.setMode(PANE_ARTIFACTS, 'autohide');

    expect(ws.focusedPaneId.value).not.toBe(PANE_ARTIFACTS);
    expect(ws.focusedPaneId.value).toBe(PANE_SESSIONS);
  });

  it('does not focus a pane explicitly while it is auto-hidden', () => {
    const ws = useDockWorkspace();

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
    expect(ws.closedPanes.value).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(createDefaultLayout());

    ws.close(PANE_ARTIFACTS);
    expect(ws.isOpen(PANE_ARTIFACTS)).toBe(false);
    ws.restore(PANE_ARTIFACTS);
    expect(ws.isOpen(PANE_ARTIFACTS)).toBe(true);

    ws.close(PANE_ARTIFACTS);
    ws.reset();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ws.layout.value).toEqual(createDefaultLayout());
    expect(saved.at(-1)).toEqual(createDefaultLayout());
  });
});
