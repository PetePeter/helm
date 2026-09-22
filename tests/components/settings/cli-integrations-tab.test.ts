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
const providerCalls: Array<{ key: string; provider: string }> = [];

const CLAUDE_SNIPPET = '{\n  "hooks": { "SessionStart": [] }\n}';
const CODEX_SNIPPET = '{\n  "hooks": { "SessionStart": [] }\n}';
const COPILOT_SNIPPET = '{\n  "version": 1,\n  "hooks": { "sessionStart": [] }\n}';

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    hooksGetStatus: vi.fn(async () => ({
      success: true,
      items: [
        { provider: 'claude', label: 'Claude Code', status: 'installed', canInject: true, configPath: '~/.claude/settings.json', snippet: CLAUDE_SNIPPET },
        { provider: 'codex', label: 'Codex', status: 'not-installed', canInject: true, configPath: '~/.codex/hooks.json', snippet: CODEX_SNIPPET },
        { provider: 'copilot', label: 'GitHub Copilot CLI', status: 'installed', canInject: false, configPath: '~/.copilot/hooks/helm.json', snippet: COPILOT_SNIPPET },
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
  toolsClient: {
    toolsGetAll: vi.fn(async () => ({
      cliTypes: {
        'uuid-a': { name: 'My Claude Tool', displayName: 'My Claude Tool', provider: 'claude' },
        'uuid-b': { name: 'Codex', displayName: 'Codex' },
        'uuid-c': { name: 'cmd', displayName: 'cmd' },
      },
    })),
    toolsSetCliTypeProvider: vi.fn(async (key: string, provider: string) => {
      providerCalls.push({ key, provider });
      return { success: true };
    }),
  },
}));

async function factory() {
  const wrapper = mount(CliIntegrationsTab, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function section(wrapper: Awaited<ReturnType<typeof factory>>, title: string) {
  const found = wrapper.findAll('.tg-section').find(s => s.find('.tg-section-title').text() === title);
  if (!found) throw new Error(`No section titled "${title}"`);
  return found;
}

function reminderRows(wrapper: Awaited<ReturnType<typeof factory>>) {
  return section(wrapper, 'Reminder delivery').findAll('.settings-list-item').filter(row => row.find('select').exists());
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

describe('CliIntegrationsTab — copy-ready hook registration code', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  /** One row per CLI, each carrying its snippet pre block. */
  function hookRows(wrapper: Awaited<ReturnType<typeof factory>>) {
    return wrapper.findAll('.settings-list-item').filter(row => row.find('pre').exists());
  }

  it('shows the config file path and the ready-to-copy snippet per CLI', async () => {
    const wrapper = await factory();
    const rows = hookRows(wrapper);
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain('~/.claude/settings.json');
    expect(rows[0].find('pre').text()).toBe(CLAUDE_SNIPPET);
    expect(rows[2].text()).toContain('~/.copilot/hooks/helm.json');
    expect(rows[2].find('pre').text()).toBe(COPILOT_SNIPPET);
  });

  it('describes manual unregistration per provider', async () => {
    const wrapper = await factory();
    const rows = hookRows(wrapper);
    // Claude/Codex: delete the entries whose command runs the shim.
    expect(rows[0].text()).toContain('helm-hook-shim.py');
    // Copilot: the Helm-owned file goes away entirely.
    expect(rows[2].text()).toContain('delete the file');
  });

  it('copies the snippet verbatim', async () => {
    const wrapper = await factory();
    const rows = hookRows(wrapper);
    await rows[1].findAll('button').find(b => b.text() === 'Copy')!.trigger('click');
    expect(writeText).toHaveBeenCalledWith(CODEX_SNIPPET);
  });
});

describe('CliIntegrationsTab — tool provider mapping', () => {
  beforeEach(() => {
    providerCalls.length = 0;
  });

  /** One row per configured CLI type, each carrying its provider dropdown. */
  function mappingRows(wrapper: Awaited<ReturnType<typeof factory>>) {
    return section(wrapper, 'Tool mapping').findAll('.settings-list-item');
  }

  it('lists every configured CLI type with its current provider', async () => {
    const wrapper = await factory();
    const rows = mappingRows(wrapper);
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain('My Claude Tool');
    expect((rows[0].find('select').element as HTMLSelectElement).value).toBe('claude');
    // Auto-migration fills what it can; a shell stays unset.
    expect((rows[2].find('select').element as HTMLSelectElement).value).toBe('');
  });

  it('persists a provider choice through the tools channel', async () => {
    const wrapper = await factory();
    await mappingRows(wrapper)[1].find('select').setValue('copilot');
    await flushPromises();
    expect(providerCalls).toEqual([{ key: 'uuid-b', provider: 'copilot' }]);
  });
});
