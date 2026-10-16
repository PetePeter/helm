import { describe, expect, it } from 'vitest';
import { getDockShortcutPane, paneShortcutHint } from '../renderer/dock-shortcuts.js';
import { DOCK_PANES, PANE_DRAFT, PANE_MEMORIES, PANE_TERMINAL } from '../renderer/dock-types.js';

/** Ctrl+Shift chords other handlers (or Chromium) already own. */
const RESERVED = ['n', 'w', 'r', 'b', 'i'];

const chord = (key: string) => ({ key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });

describe('workspace shortcuts', () => {
  it('gives every registered pane its own Ctrl+Shift key', () => {
    const keys = DOCK_PANES.map((pane) => pane.shortcut);
    expect(new Set(keys).size).toBe(DOCK_PANES.length);
    for (const key of keys) expect(RESERVED).not.toContain(key);
    for (const pane of DOCK_PANES) expect(getDockShortcutPane(chord(pane.shortcut!))).toBe(pane.id);
  });

  it('opens the draft pane on Ctrl+Shift+D', () => {
    expect(getDockShortcutPane(chord('D'))).toBe(PANE_DRAFT);
    expect(paneShortcutHint(PANE_DRAFT)).toBe('Ctrl+Shift+D');
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
