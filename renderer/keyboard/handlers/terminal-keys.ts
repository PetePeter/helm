/**
 * Terminal key handlers — the keys that belong to the active session's PTY.
 *
 * Split into four handlers rather than one, because they answer *different*
 * eligibility questions and fusing them is what produced the bugs:
 *
 *  - `terminal-compose` (Ctrl+G) renders a prompt editor OVER the terminal, so
 *    it asks whether the terminal is VISIBLE. It is the one deliberate
 *    exception to focus ownership.
 *  - `terminal-escape` and `terminal-paste` send to the PTY, so they ask
 *    whether the terminal is FOCUSED. They intercept even when xterm holds DOM
 *    focus, because ESC protection and managed paste must pre-empt xterm.
 *  - `terminal-relay` is the last resort for keystrokes aimed at a focused
 *    terminal pane that never reached xterm (synthetic typing from voice
 *    transcription, or focus parked on the pane chrome). It stands down when
 *    xterm already has the keystroke, which would otherwise double every
 *    character.
 */

import { comboToPtyEscape, keyToPtyEscape } from '../../bindings.js';
import { PANE_TERMINAL } from '../../dock-types.js';
import { shouldAllowNativeCopy, type SelectionInfo } from '../../paste-handler.js';
import type { KeyContext, KeyHandler } from '../router.js';

/** Keys that name a modifier rather than a character — never relayed. */
const MODIFIER_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'Dead', 'Unidentified', 'Process', 'Compose',
]);

export interface TerminalKeyDeps {
  writePty: (sessionId: string, data: string) => void;
  /** Managed delivery — bracketed-paste framing and chunking, not a raw write. */
  deliverText: (sessionId: string, text: string) => Promise<void>;
  readClipboardText: () => Promise<string>;
  openPromptEditor: (sessionId: string) => void;
  /** Is the Escape-protection setting turned on for this session's CLI? */
  isEscProtectionArmed: () => boolean;
  /**
   * Raise the protection dialog. Confirmation is the dialog's own business —
   * once it is up the router gates these handlers out on `scope === 'modal'`.
   */
  openEscProtection: (sessionId: string) => void;
  /** Live DOM selection, for the artifact-document copy carve-out. */
  readSelection?: () => SelectionInfo;
  /** Absent in snap-out windows, which do not own the session list. */
  renameSession?: (sessionId: string) => void;
  /** Absent in snap-out windows. */
  clearNotifications?: (sessionId: string) => void;
}

/** Terminal focused and a session behind it. */
function ownsTerminal(ctx: KeyContext): boolean {
  return ctx.isFocused(PANE_TERMINAL) && ctx.activeSessionId !== null;
}

export function createTerminalKeyHandlers(deps: TerminalKeyDeps): KeyHandler[] {
  return [
    {
      id: 'session-meta-keys',
      scope: 'global',
      claims: (ctx) => ctx.activeSessionId !== null,
      handle: (ctx) => {
        const sessionId = ctx.activeSessionId!;
        if (ctx.combo === 'ctrl+shift+r' && deps.renameSession) {
          deps.renameSession(sessionId);
          return true;
        }
        if (ctx.combo === 'ctrl+shift+b' && deps.clearNotifications) {
          deps.clearNotifications(sessionId);
          return true;
        }
        return false;
      },
    },

    {
      id: 'terminal-compose',
      scope: 'global',
      claims: (ctx) => ctx.isVisible(PANE_TERMINAL) && ctx.activeSessionId !== null,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+g') return false;
        deps.openPromptEditor(ctx.activeSessionId!);
        return true;
      },
    },

    {
      id: 'terminal-escape',
      scope: 'pane',
      claims: ownsTerminal,
      handle: (ctx) => {
        if (ctx.combo !== 'escape') return false;
        const sessionId = ctx.activeSessionId!;

        // Protection turns the first Escape into a confirmation instead of an
        // interrupt. It must pre-empt xterm, which would otherwise send ESC.
        if (deps.isEscProtectionArmed()) {
          deps.openEscProtection(sessionId);
          return true;
        }

        deps.writePty(sessionId, '\x1b');
        return true;
      },
    },

    {
      id: 'terminal-paste',
      scope: 'pane',
      claims: ownsTerminal,
      handle: (ctx) => {
        if (ctx.combo !== 'ctrl+v') return false;
        const sessionId = ctx.activeSessionId!;

        void (async () => {
          try {
            const text = await deps.readClipboardText();
            if (text.length > 0) await deps.deliverText(sessionId, text);
          } catch (error) {
            console.warn('[Keyboard] clipboard read failed:', error);
          }
        })();

        return true;
      },
    },

    {
      id: 'terminal-relay',
      scope: 'terminal',
      // `ctx.scope === 'terminal'` means the keystroke landed inside xterm's own
      // DOM, so xterm has already handled it.
      claims: (ctx) => ownsTerminal(ctx) && ctx.scope !== 'terminal',
      handle: (ctx) => {
        const event = ctx.event;
        const sessionId = ctx.activeSessionId!;
        if (event.metaKey || event.altKey) return false;
        if (MODIFIER_KEYS.has(event.key)) return false;

        if (event.ctrlKey) {
          if (event.key.length !== 1) return false;
          // Ctrl+N belongs to the app (new plan / new session). Relaying it
          // would also send \x0e to the CLI behind the dialog.
          if (event.key.toLowerCase() === 'n') return false;
          // Let the browser copy a real selection out of an artifact document,
          // mirroring xterm's own Ctrl+C-with-selection carve-out.
          if (deps.readSelection && shouldAllowNativeCopy(event, deps.readSelection())) return false;
          deps.writePty(sessionId, comboToPtyEscape(['Ctrl', event.key]));
          return true;
        }

        const escape = keyToPtyEscape(event.key);
        if (escape !== event.key || event.key.length > 1) {
          deps.writePty(sessionId, escape);
          return true;
        }

        if (event.key.length === 1) {
          deps.writePty(sessionId, event.key);
          return true;
        }

        return false;
      },
    },
  ];
}
