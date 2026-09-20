/**
 * Reminder delivery resolution (G9) — the ONE pure decision behind every
 * standing reminder's channel: hook (inject), pty (prepend) or off.
 *
 * Binding decisions under test (plan P-0790):
 * - defaults reproduce TODAY: rules/instruction dual-path (hook with fallback),
 * the Telegram mode block always prepends
 * - mode pty beats capability — the user's choice wins over what Helm detected
 * - mode hook on an incapable recipient falls back to pty AND says so
 * - mode off suppresses the reminder on every path
 * - an unset or unknown mode is the default, never an error
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REMINDER_MODES,
  REMINDER_IDS,
  createReminderDeliveryFn,
  resolveReminderDelivery,
  type ReminderDeliveryMode,
} from '../../src/session/reminder-delivery';

describe('resolveReminderDelivery', () => {
  it('every reminder id has a default mode', () => {
    for (const id of REMINDER_IDS) {
      expect(DEFAULT_REMINDER_MODES[id]).toBeDefined();
    }
  });

  it("today's dual-path reminders default to hook-with-fallback (G4 auto)", () => {
    expect(DEFAULT_REMINDER_MODES.helmMsgRules).toBe('hook');
    expect(DEFAULT_REMINDER_MODES.telegramInstruction).toBe('hook');
  });

  it("the Telegram mode block defaults to pty — always-prepended is today's behaviour", () => {
    expect(DEFAULT_REMINDER_MODES.telegramModeInstructions).toBe('pty');
  });

  it('unset mode resolves to the reminder default', () => {
    expect(resolveReminderDelivery('helmMsgRules', undefined, true)).toEqual({ channel: 'hook', fellBack: false });
    expect(resolveReminderDelivery('telegramModeInstructions', undefined, true)).toEqual({ channel: 'pty', fellBack: false });
  });

  it('mode pty prepends even when the recipient can inject — the user beats the capability', () => {
    expect(resolveReminderDelivery('helmMsgRules', 'pty', true)).toEqual({ channel: 'pty', fellBack: false });
  });

  it('mode hook on an incapable recipient falls back to pty and reports it', () => {
    expect(resolveReminderDelivery('helmMsgRules', 'hook', false)).toEqual({ channel: 'pty', fellBack: true });
  });

  it('mode hook on a capable recipient injects', () => {
    expect(resolveReminderDelivery('helmMsgRules', 'hook', true)).toEqual({ channel: 'hook', fellBack: false });
  });

  it('mode off suppresses on both paths regardless of capability', () => {
    expect(resolveReminderDelivery('helmMsgRules', 'off', true)).toEqual({ channel: 'off', fellBack: false });
    expect(resolveReminderDelivery('telegramInstruction', 'off', false)).toEqual({ channel: 'off', fellBack: false });
  });
});

describe('createReminderDeliveryFn', () => {
  const session = { id: 's1', name: 'w', cliType: 'claude-code' };

  it('wraps the shared capability check — no second notion of "can inject"', async () => {
    const capable = vi.fn(async () => true);
    const resolve = createReminderDeliveryFn(capable, () => undefined);
    await resolve(session as never, 'helmMsgRules');
    expect(capable).toHaveBeenCalledWith(session);
  });

  it('reads the mode per reminder from settings', async () => {
    const modes: Partial<Record<string, ReminderDeliveryMode | undefined>> = {
      helmMsgRules: 'off',
      telegramInstruction: 'pty',
    };
    const resolve = createReminderDeliveryFn(async () => true, (r) => modes[r]);
    expect((await resolve(session as never, 'helmMsgRules')).channel).toBe('off');
    expect((await resolve(session as never, 'telegramInstruction')).channel).toBe('pty');
    expect((await resolve(session as never, 'telegramModeInstructions')).channel).toBe('pty');
  });
});
