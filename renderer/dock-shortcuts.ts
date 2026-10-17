import { getPaneDescriptor, listProfilePanes, type DockProfileId, type PaneId } from './dock-types.js';

/** Global workspace shortcuts. Ctrl is accepted on Windows/Linux and Meta on macOS. */
export function getDockShortcutPane(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  focusedPane: PaneId | null = null,
  profile: DockProfileId = 'main',
): PaneId | null {
  if (!event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  const matches = listProfilePanes(profile).filter(pane => pane.shortcut === key);
  if (matches.length === 0) return null;
  const focusedIndex = matches.findIndex(pane => pane.id === focusedPane);
  return matches[focusedIndex < 0 ? 0 : (focusedIndex + 1) % matches.length].id;
}

export function paneShortcutHint(id: PaneId): string {
  const key = getPaneDescriptor(id)?.shortcut;
  return key ? `Ctrl+Shift+${key.toUpperCase()}` : '';
}
