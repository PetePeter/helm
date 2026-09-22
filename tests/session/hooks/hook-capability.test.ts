/**
 * The G4 rules-via-hooks capability check — the ONE decision both delivery
 * paths share (MCP session_send_text and the Telegram relay).
 *
 * Fake status readers return canned integration states; what is under test is
 * the decision logic: provider must be one that can inject on UserPromptSubmit,
 * the hook block must be present on disk, and any failure degrades to "no" —
 * the prepended header, which is today's behaviour and must stay it.
 */

import { describe, expect, it } from 'vitest';
import { createRulesViaHooksFn } from '../../../src/session/hooks/hook-capability';
import type { CliHooksIntegration } from '../../../src/config/loader';

const CLAUDE: CliHooksIntegration = { provider: 'claude', configPath: '~/.claude/settings.json', events: ['UserPromptSubmit'] };
const CODEX: CliHooksIntegration = { provider: 'codex', configPath: '~/.codex/config.toml', events: ['UserPromptSubmit'] };
const COPILOT: CliHooksIntegration = { provider: 'copilot', configPath: '~/.copilot/hooks.json', events: ['UserPromptSubmit'] };

const session = (cliType: string) =>
  ({ id: 's1', name: 'worker', cliType, processId: 1 }) as Parameters<ReturnType<typeof createRulesViaHooksFn>>[0];

describe('createRulesViaHooksFn', () => {
  it('says yes for claude with hooks installed', async () => {
    const fn = createRulesViaHooksFn(
      (cliType) => (cliType === 'claude-code' ? { hooks: CLAUDE } : null),
      async () => 'installed',
    );
    expect(await fn(session('claude-code'))).toBe(true);
  });

  it('resolves the provider from the top-level field alone — custom CLI types carry no hooks block', async () => {
    let consulted = 0;
    const fn = createRulesViaHooksFn(
      (cliType) => {
        consulted += 1;
        return cliType === 'custom-uuid' ? { provider: 'claude' } : null;
      },
      async () => 'installed',
    );
    expect(await fn(session('custom-uuid'))).toBe(true);
    // The status read still happened — provider resolved without a hooks block.
    expect(consulted).toBe(1);
  });

  it('prefers the top-level provider over the legacy hooks block', async () => {
    // Contrived but decisive: the mapping is the newer, authoritative source.
    const fn = createRulesViaHooksFn(
      () => ({ provider: 'copilot', hooks: CLAUDE }),
      async () => 'installed',
    );
    expect(await fn(session('weird'))).toBe(false);
  });

  it('says yes for codex with hooks merely outdated — a stale block still injects', async () => {
    const fn = createRulesViaHooksFn(
      () => ({ hooks: CODEX }),
      async () => 'outdated',
    );
    expect(await fn(session('codex'))).toBe(true);
  });

  it('says no for copilot even when installed — it drops UserPromptSubmit output', async () => {
    const fn = createRulesViaHooksFn(
      () => ({ hooks: COPILOT }),
      async () => 'installed',
    );
    expect(await fn(session('copilot-cli'))).toBe(false);
  });

  it('says no when the block is absent or the interpreter is missing', async () => {
    for (const status of ['not-installed', 'interpreter-missing'] as const) {
      const fn = createRulesViaHooksFn(
        () => ({ hooks: CLAUDE }),
        async () => status,
      );
      expect(await fn(session('claude-code')), status).toBe(false);
    }
  });

  it('says no for a CLI type with no hooks entry, without consulting disk', async () => {
    let consulted = 0;
    const fn = createRulesViaHooksFn(
      () => ({ name: 'cmd', hooks: undefined }),
      async () => {
        consulted += 1;
        return 'installed';
      },
    );
    expect(await fn(session('cmd'))).toBe(false);
    expect(consulted).toBe(0);
  });

  it('says no for an unknown CLI type', async () => {
    const fn = createRulesViaHooksFn(
      () => null,
      async () => 'installed',
    );
    expect(await fn(session('ghost'))).toBe(false);
  });

  it('says no when reading the status throws — prepend as today, never break delivery', async () => {
    const fn = createRulesViaHooksFn(
      () => ({ hooks: CLAUDE }),
      async () => {
        throw new Error('disk on fire');
      },
    );
    expect(await fn(session('claude-code'))).toBe(false);
  });
});
