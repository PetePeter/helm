import type { ContextMenuAction } from '../../src/types/context-menu.js';

/** Shared desktop session actions, with terminal-only cursor actions. */

export interface ContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

export interface ContextMenuContext {
  mode: 'terminal' | 'session';
  targetSessionId: string | null;
  hasSelection: boolean;
  isSnappedOut: boolean;
  /** Name of the runtime group the target session is in, or null when ungrouped. */
  currentGroupName: string | null;
  session: { locked: boolean; frozen: boolean; keepWarm: boolean; hiddenFromOverview: boolean };
}

export interface ContextMenuGroup {
  title: string;
  items: ContextMenuItem[];
}

export type { ContextMenuAction };

function buildSessionControls(ctx: ContextMenuContext): ContextMenuItem[] {
  const hasTarget = !!ctx.targetSessionId;
  const s = ctx.session;
  return [
    { id: 'new-session', label: '🆕 New Session', enabled: true },
    { id: 'rename-session', label: '✎ Rename', enabled: hasTarget },
    { id: 'switch-cli', label: '🔀 Switch CLI…', enabled: hasTarget },
    { id: 'toggle-keep-warm', label: s.keepWarm ? '⏰ Stop keeping warm' : '⏰ Keep cache warm', enabled: hasTarget },
    { id: 'toggle-freeze', label: s.frozen ? '🔥 Unfreeze' : '❄️ Freeze', enabled: hasTarget },
    { id: 'toggle-lock', label: s.locked ? '🔓 Unlock' : '🔒 Lock', enabled: hasTarget },
    { id: 'toggle-overview', label: s.hiddenFromOverview ? '👁 Show in overview' : '👁‍🗨 Hide from overview', enabled: hasTarget },
    { id: 'move-to-group', label: '🗂️ Move to group…', enabled: hasTarget },
    {
      id: 'remove-from-group',
      label: ctx.currentGroupName ? `↩ Remove from “${ctx.currentGroupName}”` : '↩ Remove from group',
      enabled: hasTarget && !!ctx.currentGroupName,
    },
    { id: 'clone-session', label: '🧬 Clone', enabled: hasTarget },
    { id: 'snap-out', label: '📤 Snap Out', enabled: hasTarget && !ctx.isSnappedOut },
    { id: 'snap-back', label: '📥 Snap Back', enabled: hasTarget && ctx.isSnappedOut },
  ];
}

/**
 * Both desktop entry points use the same ordered groups. The session row menu
 * omits only Cursor, since those actions need a terminal selection or caret.
 */
export function buildContextMenuGroups(ctx: ContextMenuContext): ContextMenuGroup[] {
  const hasTarget = !!ctx.targetSessionId;
  const canType = hasTarget && !ctx.session.frozen;
  const groups: ContextMenuGroup[] = [
    {
      title: 'Context',
      items: [{ id: 'quick-compact', label: '🗜️ Quick Compact', enabled: hasTarget }],
    },
    {
      title: 'Compose',
      items: [
        { id: 'editor', label: '📝 Compose in Editor', enabled: canType },
        { id: 'prompts', label: '⚡ Prompts…', enabled: canType },
        { id: 'drafts', label: '📝 Drafts…', enabled: canType },
      ],
    },
    { title: 'Session', items: buildSessionControls(ctx) },
  ];

  if (ctx.mode === 'terminal') {
    groups.push({
      title: 'Cursor',
      items: [
        { id: 'copy', label: '📋 Copy', enabled: ctx.hasSelection },
        { id: 'paste', label: '📎 Paste', enabled: canType },
        { id: 'new-session-with-selection', label: '📌 New Session with Selection', enabled: ctx.hasSelection },
      ],
    });
  }

  return groups;
}
