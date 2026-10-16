import { DOCK_PANES, getPaneDescriptor, type PaneId } from './dock-types.js';

/** Global workspace shortcuts. Ctrl is accepted on Windows/Linux and Meta on macOS. */
export function getDockShortcutPane(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): PaneId | null {
  if (!event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  return DOCK_PANES.find((pane) => pane.shortcut === key)?.id ?? null;
}

export function paneShortcutHint(id: PaneId): string {
  const key = getPaneDescriptor(id)?.shortcut;
  return key ? `Ctrl+Shift+${key.toUpperCase()}` : '';
}
