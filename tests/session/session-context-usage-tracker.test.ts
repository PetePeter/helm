import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../src/types/session.js';
import type { HookEvent } from '../../src/session/hooks/hook-normaliser.js';
import { SessionContextUsageTracker } from '../../src/session/session-context-usage-tracker.js';

function makeSession(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    cliType: 'claude-code',
    processId: 1,
    cliTranscriptPath: `${id}.jsonl`,
    ...extra,
  };
}

function fakeSessionManager(sessions: SessionInfo[]) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const updates: Array<{ id: string; value: Partial<SessionInfo> }> = [];
  return {
    updates,
    getAllSessions: () => [...byId.values()],
    getSession: (id: string) => byId.get(id),
    updateSession: (id: string, value: Partial<SessionInfo>) => {
      const session = byId.get(id);
      if (session) {
        Object.assign(session, value);
        updates.push({ id, value });
      }
    },
  };
}

function hook(event: HookEvent['event'], sessionId: string): HookEvent {
  return { cli: 'claude', event, helmSessionId: sessionId, receivedAt: Date.now(), raw: {} };
}

afterEach(() => vi.useRealTimers());

describe('SessionContextUsageTracker', () => {
  it('hydrates missing transcript snapshots in the background and keeps cached rows untouched', async () => {
    vi.useFakeTimers();
    const manager = fakeSessionManager([
      makeSession('missing'),
      makeSession('cached', { contextUsage: { tokens: 9000, window: 200_000 } }),
      makeSession('no-transcript', { cliTranscriptPath: undefined }),
    ]);
    const resolved: string[] = [];
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: (session) => {
        resolved.push(session.id);
        return { known: true, tokens: 12_345, window: 200_000, measuredAtIso: '2026-10-15T00:00:00.000Z', source: 'transcript' };
      },
    });

    tracker.start(new EventEmitter());
    await vi.runAllTimersAsync();

    expect(manager.getSession('missing')?.contextUsage).toEqual({
      tokens: 12_345,
      window: 200_000,
      measuredAtIso: '2026-10-15T00:00:00.000Z',
    });
    expect(manager.getSession('cached')?.contextUsage).toEqual({ tokens: 9000, window: 200_000 });
    expect(resolved).toEqual(['missing']);
    tracker.stop();
  });

  it('refreshes only the session whose turn ended, after the transcript has settled', async () => {
    vi.useFakeTimers();
    const manager = fakeSessionManager([
      makeSession('first', { contextUsage: { tokens: 5000 } }),
      makeSession('second', { contextUsage: { tokens: 7000 } }),
    ]);
    const resolved: string[] = [];
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: (session) => {
        resolved.push(session.id);
        return { known: true, tokens: 8500, window: 100_000, source: 'transcript' };
      },
    });
    const hooks = new EventEmitter();
    tracker.start(hooks);

    hooks.emit('hook', hook('Stop', 'first'));
    await vi.advanceTimersByTimeAsync(299);
    expect(manager.updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(resolved).toEqual(['first']);
    expect(manager.getSession('first')?.contextUsage).toEqual({ tokens: 8500, window: 100_000 });
    expect(manager.getSession('second')?.contextUsage).toEqual({ tokens: 7000 });
    tracker.stop();
  });

  it('clears an old snapshot when the latest turn has no readable usage', async () => {
    vi.useFakeTimers();
    const manager = fakeSessionManager([makeSession('first', { contextUsage: { tokens: 8500 } })]);
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: () => ({ known: false, reason: 'no-usage-yet' }),
    });
    const hooks = new EventEmitter();
    tracker.start(hooks);

    hooks.emit('hook', hook('Stop', 'first'));
    await vi.advanceTimersByTimeAsync(300);

    expect(manager.getSession('first')?.contextUsage).toBeUndefined();
    expect(manager.updates).toEqual([{ id: 'first', value: { contextUsage: undefined } }]);
    tracker.stop();
  });

  it('refreshes a session immediately after an API context change', () => {
    const manager = fakeSessionManager([makeSession('api', {
      apiTool: true,
      contextUsage: { tokens: 8500 },
    })]);
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: () => ({ known: true, tokens: 1200, window: 100_000, source: 'api' }),
    });

    tracker.refreshSession('api');

    expect(manager.getSession('api')?.contextUsage).toEqual({ tokens: 1200, window: 100_000 });
  });
});
