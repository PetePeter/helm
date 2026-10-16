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
import { PANE_DRAFT, PANE_TERMINAL, type PaneId } from '../../dock-types.js';
import type { KeyHandler } from '../router.js';
import { createNumberKeyHandlers, type NumberKeyDeps } from './number-keys.js';

export interface WorkspaceKeyDeps extends NumberKeyDeps {
  /** Show a pane. Reveal-vs-toggle policy belongs to the caller, not the keymap. */
  activatePane: (pane: PaneId) => void;
  /** Move the session spine. Panes stay where they are. */
  cycleSession: (direction: 1 | -1) => void;
  spawnSession: () => void;
  closeActiveSession: () => void;
}

export function createWorkspaceKeyHandlers(deps: WorkspaceKeyDeps): KeyHandler[] {
  return [
    {
      // Pane jumps must work while typing — a focused field is exactly where
      // you are when you want to leave it.
      id: 'workspace-panes',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        const pane = getDockShortcutPane(ctx.event);
        if (!pane) return false;
        deps.activatePane(pane);
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

    {
      // Ctrl+G is the quick jump to the session's draft.
      id: 'draft-jump',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+g') return false;
        deps.activatePane(PANE_DRAFT);
        return true;
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
      // Closing acts on the terminal you are looking at, so it needs the
      // terminal on screen — not focused. Closing a session from the sidebar
      // while its terminal is visible is the common case.
      id: 'session-close',
      scope: 'global',
      claims: (ctx) => ctx.isVisible(PANE_TERMINAL) && ctx.activeSessionId !== null,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+shift+w') return false;
        deps.closeActiveSession();
        return true;
      },
    },
  ];
}
