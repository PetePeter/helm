/**
 * Ctrl+<n> / Alt+<n> accelerators.
 *
 * Ctrl jumps to the Nth visible session; Alt fires the Nth chip-bar action.
 * Digits 1–9 map to slots 1–9 and 0 maps to slot 0 (the tenth position).
 *
 * Both windows share these handlers: the main window resolves the slot against
 * its own session list, the snap-out window asks the main process to focus the
 * slot wherever that session lives.
 */

import { digitSlot } from '../key-combo.js';
import type { KeyContext, KeyHandler } from '../router.js';

export interface NumberKeyDeps {
  /** Returns false when the slot maps to nothing, so the key falls through. */
  jumpToSession: (slot: number) => boolean;
  fireChipAction: (slot: number) => boolean;
}

/**
 * The digit for `modifier`, or null.
 *
 * Any extra modifier disqualifies the press, so Ctrl+Shift+1 never
 * masquerades as Ctrl+1.
 */
export function slotFor(ctx: KeyContext, modifier: 'ctrl' | 'alt'): number | null {
  const event = ctx.event;
  if (event.ctrlKey !== (modifier === 'ctrl')) return null;
  if (event.altKey !== (modifier === 'alt')) return null;
  if (event.shiftKey || event.metaKey) return null;
  return digitSlot(event);
}

export function createNumberKeyHandlers(deps: NumberKeyDeps): KeyHandler[] {
  return [
    {
      id: 'session-jump',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        const slot = slotFor(ctx, 'ctrl');
        return slot === null ? false : deps.jumpToSession(slot);
      },
    },
    {
      id: 'chip-actions',
      scope: 'global',
      allowInEditable: true,
      handle: (ctx) => {
        const slot = slotFor(ctx, 'alt');
        return slot === null ? false : deps.fireChipAction(slot);
      },
    },
  ];
}
