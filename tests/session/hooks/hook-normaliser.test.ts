/**
 * HookNormaliser — per-CLI payload field names collapsed into one HookEvent.
 *
 * Real payload fixtures shaped exactly as each CLI's docs describe its stdin
 * JSON. The event NAME arrives from the hook command args (Helm wrote it into
 * the config), not from the payload, so these fixtures exercise field
 * extraction and event aliasing, never name guessing.
 */

import { describe, expect, it } from 'vitest';
import { normaliseHookEvent, type HookInboundBody } from '../../../src/session/hooks/hook-normaliser';

const NOW = 1_789_000_000_000;

function normalise(input: HookInboundBody) {
  return normaliseHookEvent(input, () => NOW);
}

describe('normaliseHookEvent', () => {
  it('maps a Claude UserPromptSubmit payload to the common shape', () => {
    const event = normalise({
      cli: 'claude',
      event: 'UserPromptSubmit',
      payload: {
        session_id: 'claude-sess-1',
        transcript_path: '/home/u/.claude/projects/x/transcript.jsonl',
        cwd: '/repo',
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the tests',
      },
    });

    expect(event).toMatchObject({
      cli: 'claude',
      event: 'UserPromptSubmit',
      cliSessionId: 'claude-sess-1',
      cwd: '/repo',
      prompt: 'fix the tests',
      receivedAt: NOW,
    });
  });

  it('maps a Codex PreToolUse payload to the common shape', () => {
    const event = normalise({
      cli: 'codex',
      event: 'PreToolUse',
      payload: {
        session_id: 'codex-sess-1',
        transcript_path: '/home/u/.codex/sessions/1.jsonl',
        cwd: '/repo',
        hook_event_name: 'PreToolUse',
        tool_name: 'shell',
        tool_input: { command: 'npm test' },
        model: 'gpt-5',
        permission_mode: 'workspace-write',
        turn_id: 'turn-7',
      },
    });

    expect(event).toMatchObject({
      cli: 'codex',
      event: 'PreToolUse',
      cliSessionId: 'codex-sess-1',
      cwd: '/repo',
      toolName: 'shell',
      receivedAt: NOW,
    });
  });

  it('maps a Copilot camelCase payload and aliases agentStop to Stop', () => {
    const event = normalise({
      cli: 'copilot',
      event: 'agentStop',
      payload: {
        sessionId: 'copilot-sess-1',
        cwd: 'X:\\repo',
      },
    });

    expect(event).toMatchObject({
      cli: 'copilot',
      event: 'Stop',
      cliSessionId: 'copilot-sess-1',
      cwd: 'X:\\repo',
      receivedAt: NOW,
    });
  });

  it('aliases Copilot camelCase event names to the canonical PascalCase set', () => {
    const pairs: Array<[string, string]> = [
      ['sessionStart', 'SessionStart'],
      ['userPromptSubmitted', 'UserPromptSubmit'],
      ['preToolUse', 'PreToolUse'],
      ['postToolUse', 'PostToolUse'],
      ['preCompact', 'PreCompact'],
    ];
    for (const [native, canonical] of pairs) {
      expect(normalise({ cli: 'copilot', event: native, payload: {} })?.event).toBe(canonical);
    }
  });

  it('returns null for an event no CLI in the common core knows', () => {
    expect(normalise({ cli: 'claude', event: 'ConfigChange', payload: {} })).toBeNull();
    expect(normalise({ cli: 'copilot', event: 'errorOccurred', payload: {} })).toBeNull();
  });

  it('keeps the raw payload for logging', () => {
    const payload = { session_id: 's', hook_event_name: 'Stop' };
    expect(normalise({ cli: 'claude', event: 'Stop', payload })?.raw).toEqual(payload);
  });
});
