import { describe, expect, it } from 'vitest';
import { getDockShortcutPane, paneShortcutHint } from '../renderer/dock-shortcuts.js';
import {
  dockPaneRegistry,
  DOCK_PANES,
  PANE_DRAFT,
  PANE_TODOS,
  PANE_MEMORIES,
  PANE_TERMINAL,
  type DockPaneDescriptor,
  type PaneId,
} from '../renderer/dock-types.js';

/** Ctrl+Shift chords other handlers (or Chromium) already own. */
const RESERVED = ['n', 'w', 'r', 'b', 'i'];

const chord = (key: string) => ({ key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });

describe('workspace shortcuts', () => {
  it('formats each built-in shortcut from its pane descriptor and avoids reserved keys', () => {
    for (const pane of DOCK_PANES) {
      if (!pane.shortcut) continue;
      expect(paneShortcutHint(pane.id)).toBe(`Ctrl+Shift+${pane.shortcut!.toUpperCase()}`);
      expect(RESERVED).not.toContain(pane.shortcut);
    }
  });

  it('opens the draft pane on Ctrl+Shift+D', () => {
    expect(getDockShortcutPane(chord('D'))).toBe(PANE_DRAFT);
    expect(getDockShortcutPane(chord('K'))).toBe(PANE_TODOS);
    expect(paneShortcutHint(PANE_TODOS)).toBe('Ctrl+Shift+K');
    expect(paneShortcutHint(PANE_DRAFT)).toBe('Ctrl+Shift+D');
  });

  it('cycles matching pane shortcuts from the focused pane, wrapping or starting at the first', () => {
    const panes: DockPaneDescriptor[] = [
      { id: 'test-shortcut-a', kind: 'tool', title: 'A', icon: 'A', shortcut: 'z', closable: true, home: 'left', dynamic: true },
      { id: 'test-shortcut-b', kind: 'tool', title: 'B', icon: 'B', shortcut: 'z', closable: true, home: 'left', dynamic: true },
    ];
    panes.forEach(pane => dockPaneRegistry.register(pane));

    try {
      expect(getDockShortcutPane(chord('z'))).toBe(panes[0].id);
      expect(getDockShortcutPane(chord('z'), PANE_MEMORIES)).toBe(panes[0].id);
      expect(getDockShortcutPane(chord('z'), panes[0].id)).toBe(panes[1].id);
      expect(getDockShortcutPane(chord('z'), panes[1].id)).toBe(panes[0].id);
    } finally {
      panes.forEach(pane => dockPaneRegistry.unregister(pane.id));
    }
  });

  it('resolves only panes available to the selected window profile', () => {
    expect(getDockShortcutPane(chord('t'), null, 'popout')).toBe(PANE_TERMINAL);
    expect(getDockShortcutPane(chord('s'), null, 'popout')).toBeNull();
  });

  it('matches Ctrl+Shift and Meta+Shift case-insensitively', () => {
    expect(getDockShortcutPane(chord('T'))).toBe(PANE_TERMINAL);
    expect(getDockShortcutPane({ key: 'm', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(PANE_MEMORIES);
  });

  it('does not claim chords with missing or extra modifiers', () => {
    expect(getDockShortcutPane({ key: 'm', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBeNull();
    expect(getDockShortcutPane({ key: 'm', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
    expect(getDockShortcutPane({ key: 'm', ctrlKey: true, metaKey: false, shiftKey: true, altKey: true })).toBeNull();
    expect(getDockShortcutPane(chord('n'))).toBeNull();
  });
});
