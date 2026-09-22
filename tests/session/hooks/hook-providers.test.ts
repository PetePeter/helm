/**
 * HOOK_PROVIDERS — the canonical, code-owned list of hookable CLIs.
 *
 * Decoupled from cli-types.yaml (where hooks blocks used to live): shipped
 * YAML defaults never reach an existing install, so a machine whose CLI types
 * are custom UUIDs would lose its hook rows entirely. The three user-level
 * config paths and their event spellings are invariant facts about the CLIs —
 * these tests pin them.
 */

import { describe, it, expect } from 'vitest';
import {
  HOOK_PROVIDERS,
  getHookProviderConfig,
  inferCliProvider,
} from '../../../src/session/hooks/hook-providers';

describe('HOOK_PROVIDERS', () => {
  it('is exactly the three hookable providers, in order', () => {
    expect(HOOK_PROVIDERS.map((p) => p.provider)).toEqual(['claude', 'codex', 'copilot']);
  });

  it('pins each provider user-level config path', () => {
    expect(HOOK_PROVIDERS.map((p) => p.configPath)).toEqual([
      '~/.claude/settings.json',
      '~/.codex/hooks.json',
      '~/.copilot/hooks/helm.json',
    ]);
  });

  it('pins the event spellings: common core everywhere, StopFailure Claude-only, Copilot camelCase', () => {
    const byProvider = Object.fromEntries(HOOK_PROVIDERS.map((p) => [p.provider, p.events]));
    expect(byProvider.claude).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'StopFailure']);
    expect(byProvider.codex).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop']);
    expect(byProvider.copilot).toEqual(['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'preCompact', 'agentStop']);
  });

  it('resolves a config by provider; unknown answers null', () => {
    expect(getHookProviderConfig('codex')?.label).toBe('Codex');
    expect(getHookProviderConfig('nope')).toBeNull();
  });
});

describe('inferCliProvider', () => {
  it('takes an explicit hooks block as authoritative', () => {
    expect(inferCliProvider({ name: 'Weird Name', hooks: { provider: 'codex' } })).toBe('codex');
  });

  it('takes an explicit top-level provider as authoritative', () => {
    expect(inferCliProvider({ name: 'Copilot-ish', provider: 'claude' })).toBe('claude');
  });

  it('infers from the display name', () => {
    expect(inferCliProvider({ displayName: 'My Claude Wrapper' })).toBe('claude');
    expect(inferCliProvider({ displayName: 'codex via proxy' })).toBe('codex');
  });

  it('infers from the spawn command when the name is silent', () => {
    expect(inferCliProvider({ displayName: 'Agent', spawnCommand: 'copilot --name={x}' })).toBe('copilot');
  });

  it('infers from resume/continue commands too', () => {
    expect(inferCliProvider({ displayName: 'Agent', resumeCommand: 'claude --resume={x}' })).toBe('claude');
  });

  it('answers null for a shell or anything without a signal', () => {
    expect(inferCliProvider({ name: 'cmd', spawnCommand: 'cmd.exe' })).toBeNull();
    expect(inferCliProvider({})).toBeNull();
  });
});
