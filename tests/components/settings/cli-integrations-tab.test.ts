/**
 * CliIntegrationsTab — the G9 Reminder delivery section.
 *
 * Binding decisions under test (plan P-0790):
 * - one row per reminder, default marked when unset, effective mode selected
 * - a 'hook' mode that cannot be honoured SHOWS the fallback per CLI —
 *   a setting that quietly means something else is worse than no setting
 * - changing a select round-trips through the typed IPC channel
 *
 * The config client is a hand-rolled fake: real component, real store logic.
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CliIntegrationsTab from '../../../renderer/components/settings/CliIntegrationsTab.vue';

const setCalls: Array<Record<string, string>> = [];
let modes: Record<string, string> = {};

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    hooksGetStatus: vi.fn(async () => ({
      success: true,
      items: [
        { cliTypeId: 'claude', label: 'Claude Code', status: 'installed', canInject: true },
        { cliTypeId: 'codex', label: 'Codex', status: 'not-installed', canInject: true },
        { cliTypeId: 'copilot', label: 'GitHub Copilot CLI', status: 'installed', canInject: false },
      ],
    })),
    hooksInstall: vi.fn(async () => ({ success: true })),
    hooksUninstall: vi.fn(async () => ({ success: true })),
    hooksGetSuggestionUsage: vi.fn(async () => ({ success: true, usage: { items: 0, totalWeight: 0, top: [], recent: [] } })),
    hooksResetSuggestionUsage: vi.fn(async () => ({ success: true })),
    configGetReminderDelivery: vi.fn(async () => ({ success: true, modes })),
    configSetReminderDelivery: vi.fn(async (updates: Record<string, string>) => {
      setCalls.push(updates);
      modes = { ...modes, ...updates };
      return { success: true, modes };
    }),
  },
}));

async function factory() {
  const wrapper = mount(CliIntegrationsTab, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function reminderRows(wrapper: ReturnType<typeof factory> extends Promise<infer W> ? W : never) {
  return wrapper.findAll('.settings-list-item').filter(row => row.find('select').exists());
}

describe('CliIntegrationsTab — Reminder delivery (G9)', () => {
  beforeEach(() => {
    setCalls.length = 0;
    modes = {};
  });

  it('renders one row per standing reminder', async () => {
    const wrapper = await factory();
    expect(wrapper.text()).toContain('Inter-session rules');
    expect(wrapper.text()).toContain('Telegram reply instruction');
    expect(wrapper.text()).toContain('Telegram mode block');
  });

  it('marks unset reminders as default and selects the effective mode', async () => {
    const wrapper = await factory();
    const rows = reminderRows(wrapper);
    // Defaults: rules/instruction hook, mode block pty.
    expect(rows[0].find('select').element.value).toBe('hook');
    expect(rows[1].find('select').element.value).toBe('hook');
    expect(rows[2].find('select').element.value).toBe('pty');
    expect(rows[0].text()).toContain('(default)');
  });

  it('shows the fallback per CLI for hook-mode reminders that cannot be honoured', async () => {
    const wrapper = await factory();
    const text = wrapper.text();
    // Codex has no hooks installed; Copilot can never inject.
    expect(text).toContain('Falls back to prepend for:');
    expect(text).toContain('Codex (not installed)');
    expect(text).toContain('GitHub Copilot CLI (cannot inject)');
    // Claude is installed and can inject — never named as falling back.
    expect(text).not.toContain('Claude Code (');
  });

  it('shows no fallback line for the pty-default mode block until switched to hook', async () => {
    const wrapper = await factory();
    const rows = reminderRows(wrapper);
    expect(rows[2].text()).not.toContain('Falls back to prepend for:');
  });

  it('round-trips a mode change through the typed IPC channel', async () => {
    const wrapper = await factory();
    const rows = reminderRows(wrapper);
    await rows[2].find('select').setValue('hook');
    await flushPromises();
    expect(setCalls).toEqual([{ telegramModeInstructions: 'hook' }]);
    // The fallback line appears once the mode asks for hook.
    expect(reminderRows(wrapper)[2].text()).toContain('Falls back to prepend for:');
  });
});
