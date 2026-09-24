import { describe, expect, it } from 'vitest';
import {
  DOCK_SHORTCUT_PANES,
  getDockShortcutPane,
} from '../renderer/dock-shortcuts.js';
import {
  PANE_ARTIFACTS,
  PANE_MEMORIES,
  PANE_PLAN_SCREEN,
  PANE_SESSIONS,
  PANE_TERMINAL,
} from '../renderer/dock-types.js';

describe('workspace shortcuts', () => {
  it('maps each approved Ctrl+Shift shortcut to one pane', () => {
    expect(DOCK_SHORTCUT_PANES).toEqual({
      t: PANE_TERMINAL,
      m: PANE_MEMORIES,
      p: PANE_PLAN_SCREEN,
      s: PANE_SESSIONS,
      a: PANE_ARTIFACTS,
    });
  });

  it('matches Ctrl+Shift and Meta+Shift case-insensitively', () => {
    expect(getDockShortcutPane({ key: 'T', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(PANE_TERMINAL);
    expect(getDockShortcutPane({ key: 'm', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(PANE_MEMORIES);
  });

  it('does not claim shortcuts with missing or extra modifiers', () => {
    expect(getDockShortcutPane({ key: 'o', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBeNull();
    expect(getDockShortcutPane({ key: 'o', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
    expect(getDockShortcutPane({ key: 'o', ctrlKey: true, metaKey: false, shiftKey: true, altKey: true })).toBeNull();
    expect(getDockShortcutPane({ key: 'n', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBeNull();
  });
});
