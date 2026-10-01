/**
 * The items a session menu offers. `session` mode is the row's kebab (⋮) — the
 * session's own actions, which used to be row buttons; `terminal` mode is the
 * right-click menu over a terminal, which adds the text actions.
 *
 * A frozen session takes no input, so in either mode it offers only what works
 * without typing into it (Helm Compact thaws it first) plus the way out.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

export interface ContextMenuContext {
  mode: 'terminal' | 'session';
  hasSelection: boolean;
  hasActiveSession: boolean;
  isSnappedOut: boolean;
  /** Name of the runtime group the session is in, or null when ungrouped. */
  currentGroupName: string | null;
  session: { locked: boolean; frozen: boolean; keepWarm: boolean; hiddenFromOverview: boolean };
}

const CANCEL: ContextMenuItem = { id: 'cancel', label: '✖ Cancel', enabled: true };

function transcriptActions(enabled: boolean): ContextMenuItem[] {
  return [
    { id: 'quick-compact', label: '🗜️ Helm Compact', enabled },
    { id: 'clone-session', label: '🧬 Clone', enabled },
    { id: 'switch-cli', label: '🔀 Switch CLI…', enabled },
  ];
}

function groupActions(ctx: ContextMenuContext): ContextMenuItem[] {
  return [
    { id: 'move-to-group', label: '🗂️ Move to group…', enabled: ctx.hasActiveSession },
    {
      id: 'remove-from-group',
      label: ctx.currentGroupName ? `↩ Remove from “${ctx.currentGroupName}”` : '↩ Remove from group',
      enabled: ctx.hasActiveSession && !!ctx.currentGroupName,
    },
  ];
}

export function buildContextMenuItems(ctx: ContextMenuContext): ContextMenuItem[] {
  const s = ctx.session;
  if (s.frozen) {
    return [{ id: 'unfreeze', label: '🔥 Unfreeze', enabled: true }, ...transcriptActions(true), CANCEL];
  }
  if (ctx.mode === 'session') {
    return [
      { id: 'rename-session', label: '✎ Rename', enabled: true },
      ...transcriptActions(true),
      ...groupActions(ctx),
      { id: 'toggle-keep-warm', label: s.keepWarm ? '⏰ Stop keeping warm' : '⏰ Keep cache warm', enabled: true },
      { id: 'toggle-freeze', label: '❄️ Freeze', enabled: true },
      { id: 'toggle-lock', label: s.locked ? '🔓 Unlock' : '🔒 Lock', enabled: true },
      { id: 'toggle-overview', label: s.hiddenFromOverview ? '👁 Show in overview' : '👁‍🗨 Hide from overview', enabled: true },
      CANCEL,
    ];
  }
  return [
    { id: 'copy', label: '📋 Copy', enabled: ctx.hasSelection },
    { id: 'paste', label: '📎 Paste', enabled: ctx.hasActiveSession },
    { id: 'editor', label: '📝 Compose in Editor', enabled: ctx.hasActiveSession },
    { id: 'new-session', label: '🆕 New Session', enabled: true },
    { id: 'new-session-with-selection', label: '📌 New Session with Selection', enabled: ctx.hasSelection },
    { id: 'prompts', label: '⚡ Prompts…', enabled: ctx.hasActiveSession },
    { id: 'drafts', label: '📝 Drafts…', enabled: ctx.hasActiveSession },
    ...transcriptActions(ctx.hasActiveSession),
    ...groupActions(ctx),
    { id: 'snap-out', label: '📤 Snap Out', enabled: ctx.hasActiveSession && !ctx.isSnappedOut },
    { id: 'snap-back', label: '📥 Snap Back', enabled: ctx.isSnappedOut },
    CANCEL,
  ];
}
