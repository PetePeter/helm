export const CONTEXT_MENU_ACTION_IDS = [
  'quick-compact',
  'rename-session',
  'toggle-freeze',
  'toggle-lock',
  'toggle-keep-warm',
  'toggle-overview',
  'copy',
  'paste',
  'editor',
  'new-session',
  'new-session-with-selection',
  'prompts',
  'drafts',
  'clone-session',
  'switch-cli',
  'move-to-group',
  'remove-from-group',
  'snap-out',
  'snap-back',
] as const;

export type ContextMenuActionId = typeof CONTEXT_MENU_ACTION_IDS[number];

export interface ContextMenuAction {
  id: ContextMenuActionId;
  targetSessionId: string | null;
  selectedText: string;
}
