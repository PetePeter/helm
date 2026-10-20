/**
 * Workspace key handlers — shortcuts that work from any pane.
 *
 * These are `global` scope: they outrank pane and terminal handlers, so
 * Ctrl+Shift+O reaches the dock even while you are typing in a terminal. That
 * used to be decided by a `closest('input, textarea')` guard in MainWindowApp,
 * which matched xterm's hidden helper textarea and killed the shortcuts.
 *
 * Collaborators are injected so the whole set is exercisable without a dock,
 * a terminal manager, or a Pinia store.
 */

import { getDockShortcutPane } from '../../dock-shortcuts.js';
import { PANE_DRAFT, type DockProfileId, type PaneId } from '../../dock-types.js';
import type { KeyHandler } from '../router.js';
import { createNumberKeyHandlers, type NumberKeyDeps } from './number-keys.js';

export interface WorkspaceKeyDeps extends NumberKeyDeps {
  /** Show a pane. Reveal-vs-toggle policy belongs to the caller, not the keymap. */
  activatePane: (pane: PaneId) => void;
  /** Open Settings directly on the Dreaming page. */
  openDreamingSettings: () => void;
  /** Move the session spine. Panes stay where they are. */
  cycleSession: (direction: 1 | -1) => void;
  spawnSession: () => void;
  closeActiveSession: () => void;
}

/** Pane navigation shared by the main dock and the pop-out dock profile. */
export function createDockShortcutKeyHandlers(
  activatePane: (pane: PaneId) => void,
  profile: DockProfileId = 'main',
): KeyHandler[] {
  return [
    {
      id: 'workspace-panes',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        const pane = getDockShortcutPane(ctx.event, ctx.focusedPane, profile);
        if (!pane) return false;
        activatePane(pane);
        return true;
      },
    },
    {
      id: 'draft-jump',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+g') return false;
        activatePane(PANE_DRAFT);
        return true;
      },
    },
  ];
}

export function createWorkspaceKeyHandlers(deps: WorkspaceKeyDeps): KeyHandler[] {
  return [
    ...createDockShortcutKeyHandlers(deps.activatePane),

    {
      id: 'settings-dreaming',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+shift+g') return false;
        deps.openDreamingSettings();
        return true;
      },
    },

    {
      id: 'session-cycle',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        if (ctx.combo === 'ctrl+tab') { deps.cycleSession(1); return true; }
        if (ctx.combo === 'ctrl+shift+tab') { deps.cycleSession(-1); return true; }
        return false;
      },
    },

    ...createNumberKeyHandlers(deps),

    {
      // Spawning has always worked mid-typing — the opt-in makes that a stated
      // decision rather than a side effect of listener ordering.
      id: 'session-spawn',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+shift+n') return false;
        deps.spawnSession();
        return true;
      },
    },

    {
      // The active session is the target, regardless of the focused pane or
      // which panes are currently visible. The caller opens the close dialog.
      id: 'session-close',
      scope: 'global',
      allowInEditable: true,
      claims: (ctx) => ctx.activeSessionId !== null,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+shift+w') return false;
        deps.closeActiveSession();
        return true;
      },
    },
  ];
}
