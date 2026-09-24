import {
  PANE_ARTIFACTS,
  PANE_MEMORIES,
  PANE_PLAN_SCREEN,
  PANE_SESSIONS,
  PANE_TERMINAL,
  type PaneId,
} from './dock-types.js';

/** Global workspace shortcuts. Ctrl is accepted on Windows/Linux and Meta on macOS. */
export const DOCK_SHORTCUT_PANES: Readonly<Record<string, PaneId>> = Object.freeze({
  t: PANE_TERMINAL,
  m: PANE_MEMORIES,
  p: PANE_PLAN_SCREEN,
  s: PANE_SESSIONS,
  a: PANE_ARTIFACTS,
});

export function getDockShortcutPane(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): PaneId | null {
  if (!event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  return DOCK_SHORTCUT_PANES[event.key.toLowerCase()] ?? null;
}
