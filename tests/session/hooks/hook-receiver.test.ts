/**
 * HookReceiver — the /hooks endpoint's dispatch: correlate, log, emit, decide.
 *
 * G2 routes PreToolUse through the policy and returns the CLI-specific deny
 * shape. Everything else stays G1: normalise, stamp, log, emit — and ALWAYS
 * fail open. These tests use real rule objects and a fake getSession lookup
 * (a plain function, not a mock framework).
 */

import { describe, expect, it, vi } from 'vitest';
import { HookReceiver } from '../../../src/session/hooks/hook-receiver';
import type { HookDenyRule } from '../../../src/session/hooks/hook-policy';
import type { SessionInfo } from '../../../src/types/session';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = 1_789_000_000_000;

const AWAY_RULE: HookDenyRule = {
  tools: ['AskUserQuestion'],
  onlyWhenAway: true,
  reason: 'The user is away. Use the Helm MCP tool chat_send instead.',
};

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 'helm-session-9', name: 'worker', cliType: 'claude-code', processId: 42, ...patch };
}

describe('HookReceiver', () => {
  it('normalises, correlates to the session id and emits the event', () => {
    const receiver = new HookReceiver({ now: () => NOW });
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const result = receiver.receive(
      { cli: 'claude', event: 'PreToolUse', payload: { session_id: 'c1', cwd: '/repo', tool_name: 'Bash' } },
      'helm-session-9',
    );

    expect(result).toEqual({ statusCode: 200, body: {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cli: 'claude',
      event: 'PreToolUse',
      helmSessionId: 'helm-session-9',
      cliSessionId: 'c1',
      cwd: '/repo',
      toolName: 'Bash',
      receivedAt: NOW,
    });
  });

  it('denies a PreToolUse the policy rejects, in the CLI-specific shape, and still emits', () => {
    const receiver = new HookReceiver({
      now: () => NOW,
      getSession: () => session({ interactionChannel: 'telegram' }),
      getDenyRules: () => [AWAY_RULE],
    });
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const result = receiver.receive(
      { cli: 'claude', event: 'PreToolUse', payload: { tool_name: 'AskUserQuestion' } },
      'helm-session-9',
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: AWAY_RULE.reason,
      },
    });
    // The deny is visible to subscribers too — the event is not swallowed.
    expect(seen).toHaveLength(1);
  });

  it('answers a no-op when the policy allows (desktop session, same tool)', () => {
    const receiver = new HookReceiver({
      now: () => NOW,
      getSession: () => session({ interactionChannel: 'desktop' }),
      getDenyRules: () => [AWAY_RULE],
    });

    const result = receiver.receive(
      { cli: 'claude', event: 'PreToolUse', payload: { tool_name: 'AskUserQuestion' } },
      'helm-session-9',
    );

    expect(result).toEqual({ statusCode: 200, body: {} });
  });

  it('fails OPEN when the policy machinery throws', () => {
    const receiver = new HookReceiver({
      now: () => NOW,
      getSession: () => {
        throw new Error('session store exploded');
      },
      getDenyRules: () => [AWAY_RULE],
    });

    const result = receiver.receive(
      { cli: 'claude', event: 'PreToolUse', payload: { tool_name: 'AskUserQuestion' } },
      'helm-session-9',
    );

    expect(result).toEqual({ statusCode: 200, body: {} });
  });

  it('fails OPEN when no rule source or session source is wired at all', () => {
    const receiver = new HookReceiver({ now: () => NOW });

    const result = receiver.receive(
      { cli: 'copilot', event: 'preToolUse', payload: { toolName: 'AskUserQuestion' } },
      'helm-session-9',
    );

    expect(result).toEqual({ statusCode: 200, body: {} });
  });

  it('never consults the policy for events other than PreToolUse', () => {
    let rulesAsked = 0;
    const receiver = new HookReceiver({
      now: () => NOW,
      getSession: () => session({ interactionChannel: 'telegram' }),
      getDenyRules: () => {
        rulesAsked += 1;
        return [AWAY_RULE];
      },
    });

    receiver.receive({ cli: 'claude', event: 'PostToolUse', payload: { tool_name: 'AskUserQuestion' } }, 'helm-session-9');
    receiver.receive({ cli: 'claude', event: 'UserPromptSubmit', payload: {} }, 'helm-session-9');
    receiver.receive({ cli: 'claude', event: 'Stop', payload: {} }, 'helm-session-9');

    expect(rulesAsked).toBe(0);
  });

  it('ignores an unknown event name: 200, logged, nothing emitted', () => {
    const receiver = new HookReceiver({ now: () => NOW });
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const result = receiver.receive(
      { cli: 'claude', event: 'TeammateIdle', payload: {} },
      'helm-session-9',
    );

    expect(result.statusCode).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('swallows a malformed body: 200, no crash, nothing emitted', () => {
    const receiver = new HookReceiver({ now: () => NOW });
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    expect(receiver.receive('not-an-object', 's').statusCode).toBe(200);
    expect(receiver.receive(null, 's').statusCode).toBe(200);
    expect(receiver.receive({ cli: 'claude' }, 's').statusCode).toBe(200);
    expect(receiver.receive({ cli: 'claude', event: 'Stop', payload: 'text' }, 's').statusCode).toBe(200);
    expect(receiver.receive({ cli: 'unknown-cli', event: 'Stop', payload: {} }, 's').statusCode).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('carries a null helmSessionId rather than failing when uncorrelated', () => {
    const receiver = new HookReceiver({ now: () => NOW });
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    receiver.receive({ cli: 'codex', event: 'Stop', payload: {} }, null);

    expect(seen[0]).toMatchObject({ helmSessionId: null });
  });
});
