/**
 * Keyboard router — the single owner of global keyboard input.
 *
 * One capture-phase listener on `window`. Handlers register themselves, declare
 * a scope, and answer two questions: "am I eligible?" (`claims`) and "did I eat
 * it?" (`handle`). The router resolves the context once, walks the chain in
 * DECLARED precedence, and is the only code that suppresses an event.
 *
 * This replaced eight competing capture-phase listeners on `window`/`document`
 * whose relative priority was an accident of module import order. Two
 * consequences of that design were user-visible bugs:
 *
 *  - handlers suppressed events they then declined to handle (Escape was
 *    `preventDefault`ed up front and dropped by a later guard, so it reached
 *    neither the PTY nor xterm), and
 *  - each listener re-derived eligibility from its own DOM probes, which drifted
 *    out of sync with the dock (`.plan-screen.visible` matches a pane that is
 *    merely mounted, because dock panes use `v-show`).
 *
 * Handlers therefore never call `preventDefault` or `stopPropagation`. Returning
 * `false` leaves the event pristine so xterm.js and native controls still see it.
 */

import { resolveKeyContext, type KeyContext, type KeyEnvironment } from './key-context.js';
import { PANE_TERMINAL } from '../dock-types.js';

export type { KeyContext, KeyEnvironment };

/**
 * Handler scopes, most privileged first. This list IS the priority policy —
 * the one thing that must stay explicit rather than emergent.
 *
 *  - `modal`    an open modal owns the keyboard outright
 *  - `global`   workspace-wide shortcuts that work from any pane
 *  - `pane`     the focused pane's own keys
 *  - `terminal` last resort: relay to the active session's PTY
 */
export const SCOPE_PRECEDENCE = ['modal', 'global', 'pane', 'terminal'] as const;

export type KeyHandlerScope = (typeof SCOPE_PRECEDENCE)[number];

export interface KeyHandler {
  /** Stable identifier — shows up in debugging and keeps registrations greppable. */
  id: string;
  scope: KeyHandlerScope;
  /**
   * Opt back in while an input/textarea has focus. Only for shortcuts that
   * must work mid-typing (Ctrl+Shift+N spawns a session from anywhere).
   */
  allowInEditable?: boolean;
  /** Eligibility. Ask the context whether you are focused, visible, or neither. */
  claims?: (ctx: KeyContext) => boolean;
  /** Return true if the key was consumed. The router handles suppression. */
  handle: (ctx: KeyContext) => boolean;
}

let handlers: readonly KeyHandler[] = [];

/** Register a handler. Returns an unregister function — call it on unmount. */
export function registerKeyHandler(handler: KeyHandler): () => void {
  handlers = [...handlers, handler];
  return () => {
    handlers = handlers.filter(entry => entry !== handler);
  };
}

/** Handlers in resolution order: by declared scope, then by registration. */
export function listKeyHandlers(): KeyHandler[] {
  // Array.prototype.sort is stable, so same-scope handlers keep insertion order.
  return [...handlers].sort(
    (a, b) => SCOPE_PRECEDENCE.indexOf(a.scope) - SCOPE_PRECEDENCE.indexOf(b.scope),
  );
}

/** Drop every registration. Tests only. */
export function resetKeyHandlers(): void {
  handlers = [];
}

/**
 * Scope gating that applies before a handler's own `claims`.
 *
 * A terminal is never treated as an editable field however much its hidden
 * helper textarea resembles one — see `key-context.ts`.
 */
function isEligible(handler: KeyHandler, ctx: KeyContext): boolean {
  if (handler.scope === 'modal') return true;
  if (ctx.scope === 'modal') return false;
  if (ctx.scope === 'editable' && !handler.allowInEditable) return false;
  return true;
}

/** Repeat window for the dropped-keystroke warning — a dropped sentence must not become 40 warns. */
const DROP_WARN_INTERVAL_MS = 3_000;

/**
 * A printable key that no handler claimed even though the app believed the
 * terminal pane owned the keyboard. `scope === 'pane'` already excludes modal,
 * editable fields and xterm itself; `focusedPane === PANE_TERMINAL` excludes
 * panes (plan screen, drafts) whose keys legitimately fall through.
 */
function isDroppedKey(ctx: KeyContext): boolean {
  const { event, key, scope, focusedPane, activeSessionId } = ctx;
  if (scope !== 'pane' || focusedPane !== PANE_TERMINAL || activeSessionId === null) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return key.length === 1;
}

/** Where DOM focus actually is — the evidence for *why* input went dead. */
function describeParkedFocus(): string {
  const el = document.activeElement;
  if (!(el instanceof Element) || el === document.body) return '<body>';
  const id = el.id ? `#${el.id}` : '';
  const classes =
    typeof el.className === 'string' && el.className.trim()
      ? el.className.trim().split(/\s+/).map((name) => `.${name}`).join('')
      : '';
  return `<${el.tagName.toLowerCase()}${id}${classes}>`;
}

function warnDroppedKey(ctx: KeyContext): void {
  console.warn(
    `[Keyboard] ${JSON.stringify(ctx.key)} fell through with no handler while session ${ctx.activeSessionId} is active — ` +
      `focus parked on ${describeParkedFocus()}. ` +
      'If typing is dead, give the terminal focus (click it, or Ctrl+Shift+R) to restore input.',
  );
}

/** Install the one listener. Returns an uninstall function. */
export function installKeyRouter(env: KeyEnvironment): () => void {
  let lastDropWarnAt = 0;

  function onKeyDown(event: KeyboardEvent): void {
    const ctx = resolveKeyContext(event, env);

    for (const handler of listKeyHandlers()) {
      if (!isEligible(handler, ctx)) continue;
      if (handler.claims && !handler.claims(ctx)) continue;
      if (!handler.handle(ctx)) continue;

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Nothing claimed it. If the app still believed the terminal had the
    // keyboard, the keystroke is silently dead — the parked-focus bug — so
    // say so, throttled so a whole dropped sentence logs once per window.
    if (isDroppedKey(ctx) && Date.now() - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
      lastDropWarnAt = Date.now();
      warnDroppedKey(ctx);
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
