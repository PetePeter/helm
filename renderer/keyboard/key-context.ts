/**
 * Key context — everything a handler needs to decide "is this mine?", resolved
 * exactly once per keydown.
 *
 * Before the router, each global listener answered these questions for itself
 * with ad-hoc DOM probes (`querySelector('.plan-screen.visible')`, four separate
 * copies of an editable-element check). They disagreed, and the disagreements
 * were the bugs. There is now one answer per event, and handlers consume it.
 *
 * `isFocused` and `isVisible` are deliberately distinct: a handler that renders
 * over the terminal cares whether the terminal is on screen, while one
 * that writes to a PTY cares whether the terminal has focus.
 */

import type { PaneId } from '../dock-types.js';
import { getActiveInputContext, MODAL_NAVIGATION_SELECTOR } from '../input/input-ownership.js';
import { toCombo } from './key-combo.js';

/** Who owns this event, in priority order of specificity. */
export type KeyScope = 'modal' | 'editable' | 'terminal' | 'pane';

/** The live app state the router reads. Injected so the whole chain is testable without a dock. */
export interface KeyEnvironment {
  getActiveSessionId: () => string | null;
  getFocusedPane: () => PaneId | null;
  isPaneVisible: (pane: PaneId) => boolean;
  isModalOpen: () => boolean;
}

export interface KeyContext {
  event: KeyboardEvent;
  /** Canonical combo, e.g. `ctrl+shift+o`. */
  combo: string;
  /** Raw `event.key`, for handlers that switch on arrow, Enter and Delete families. */
  key: string;
  scope: KeyScope;
  activeSessionId: string | null;
  focusedPane: PaneId | null;
  modalOpen: boolean;
  isFocused: (pane: PaneId) => boolean;
  isVisible: (pane: PaneId) => boolean;
}

/**
 * Resolve the scope.
 *
 * Order matters: a modal outranks everything, and a terminal is decided BEFORE
 * an editable field because xterm.js focuses a hidden `<textarea>`. Getting that
 * pair the wrong way round is what suppressed every app shortcut while typing
 * in a terminal.
 */
function resolveScope(event: KeyboardEvent, env: KeyEnvironment): KeyScope {
  if (env.isModalOpen()) return 'modal';

  // Synthetic events (voice transcription, tests) are dispatched on `document`,
  // whose `target` is not an Element. Fall back to the focused element so a
  // focused terminal or text field is still respected.
  const target = event.target instanceof Element ? event.target : document.activeElement;
  switch (getActiveInputContext({ activeElement: target, modalNavigationSelectors: MODAL_NAVIGATION_SELECTOR })) {
    case 'terminal': return 'terminal';
    case 'editable-field': return 'editable';
    case 'modal-navigation': return 'modal';
    default: return 'pane';
  }
}

export function resolveKeyContext(event: KeyboardEvent, env: KeyEnvironment): KeyContext {
  const focusedPane = env.getFocusedPane();

  return {
    event,
    combo: toCombo(event),
    key: event.key,
    scope: resolveScope(event, env),
    activeSessionId: env.getActiveSessionId(),
    focusedPane,
    modalOpen: env.isModalOpen(),
    isFocused: (pane) => focusedPane === pane,
    isVisible: (pane) => env.isPaneVisible(pane),
  };
}
