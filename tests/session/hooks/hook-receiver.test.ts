/**
 * HookReceiver — the /hooks endpoint's dispatch: correlate, log, emit.
 *
 * G1 decides NOTHING. The receiver's whole job is to normalise, stamp the
 * Helm session id resolved from the bearer token, log the traffic, and offer
 * the event to future groups (G2+) as an EventEmitter. The reply is always a
 * no-op decision: fail-open by construction.
 */

import { describe, expect, it, vi } from 'vitest';
import { HookReceiver } from '../../../src/session/hooks/hook-receiver';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = 1_789_000_000_000;

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
