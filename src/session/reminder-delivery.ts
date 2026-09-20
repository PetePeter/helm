/**
 * G9 reminder delivery — the ONE decision behind every standing reminder's
 * channel: `hook` (injected out-of-band via the CLI's hooks), `pty`
 * (prepended into the message, today's only path) or `off`.
 *
 * This generalises G4's dual-path from an invisible capability check into a
 * visible, per-reminder setting. The capability notion itself is NOT
 * re-invented: `createReminderDeliveryFn` wraps the same `RulesViaHooksFn`
 * both delivery surfaces already consult (hook-capability.ts).
 *
 * The defaults reproduce today exactly, so an upgrade changes nothing until
 * the user chooses:
 * - `helmMsgRules` / `telegramInstruction` → 'hook' — G4's auto dual-path,
 *   which resolves to inject-when-capable, prepend-otherwise.
 * - `telegramModeInstructions` → 'pty' — the mode block is still
 *   always-prepended until the user opts it onto the hook channel.
 *
 * A 'hook' mode that cannot be honoured (no hooks installed, or a provider
 * whose UserPromptSubmit output is dropped) falls back to 'pty' AND reports
 * `fellBack: true` — the pane shows the fallback rather than silently
 * meaning something else.
 */

import type { SessionInfo } from '../types/session.js';
import type { RulesViaHooksFn } from './hooks/hook-capability.js';

/** The standing reminders that have a delivery mode (see docs/cli-hooks.md, G9). */
export type ReminderId = 'helmMsgRules' | 'telegramInstruction' | 'telegramModeInstructions';

export const REMINDER_IDS: readonly ReminderId[] = [
  'helmMsgRules',
  'telegramInstruction',
  'telegramModeInstructions',
] as const;

export type ReminderDeliveryMode = 'hook' | 'pty' | 'off';

/**
 * Today's behaviour per reminder — the fallback target when the setting is
 * unset, and the value an upgrade must not change.
 */
export const DEFAULT_REMINDER_MODES: Record<ReminderId, ReminderDeliveryMode> = {
  helmMsgRules: 'hook',
  telegramInstruction: 'hook',
  telegramModeInstructions: 'pty',
};

/** What a reminder's delivery came to, and whether 'hook' had to degrade. */
export interface ReminderDeliveryDecision {
  channel: 'hook' | 'pty' | 'off';
  fellBack: boolean;
}

/**
 * Resolve one reminder for one recipient. PURE — capability arrives as a
 * boolean so every caller shares whichever notion produced it.
 */
export function resolveReminderDelivery(
  reminder: ReminderId,
  mode: ReminderDeliveryMode | undefined,
  capable: boolean,
): ReminderDeliveryDecision {
  const chosen = mode ?? DEFAULT_REMINDER_MODES[reminder];
  if (chosen === 'off') return { channel: 'off', fellBack: false };
  if (chosen === 'pty') return { channel: 'pty', fellBack: false };
  return capable ? { channel: 'hook', fellBack: false } : { channel: 'pty', fellBack: true };
}

/** Per-recipient, per-reminder delivery read shared by every surface. */
export type ReminderDeliveryFn = (session: SessionInfo, reminder: ReminderId) => Promise<ReminderDeliveryDecision>;

/**
 * Build the shared resolver: capability from the ONE existing check, mode
 * from settings. Delivery surfaces and the injector both consume this (the
 * injector passes `capable: true` — a hook firing IS the proof).
 */
export function createReminderDeliveryFn(
  capable: RulesViaHooksFn,
  getMode: (reminder: ReminderId) => ReminderDeliveryMode | undefined,
): ReminderDeliveryFn {
  return async (session, reminder) =>
    resolveReminderDelivery(reminder, getMode(reminder), await capable(session));
}

/** Is a value a legal mode? Used by the config loader to drop junk. */
export function isReminderDeliveryMode(value: unknown): value is ReminderDeliveryMode {
  return value === 'hook' || value === 'pty' || value === 'off';
}
