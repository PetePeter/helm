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
  const events = new EventEmitter();
  return {
    updates,
    on: (event: string, listener: (session: SessionInfo) => void) => events.on(event, listener),
    off: (event: string, listener: (session: SessionInfo) => void) => events.off(event, listener),
    announce: (id: string) => events.emit('session:updated', byId.get(id)),
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
  it('refreshes mid-turn on tool calls, at most once per interval, ending on the latest value', async () => {
    vi.useFakeTimers();
    const manager = fakeSessionManager([makeSession('busy')]);
    let tokens = 1000;
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: () => ({ known: true, tokens, source: 'transcript' }),
    });
    const hooks = new EventEmitter();
    tracker.start(hooks);
    await vi.runAllTimersAsync();
    manager.updates.length = 0;

    for (let i = 0; i < 5; i++) {
      tokens += 100;
      hooks.emit('hook', hook('PostToolUse', 'busy'));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.runAllTimersAsync();

    expect(manager.updates.length).toBeLessThanOrEqual(2);
    expect(manager.getSession('busy')?.contextUsage?.tokens).toBe(1500);
    tracker.stop();
  });

  it('reads a transcript path that arrives after startup, once, without waiting for a hook', async () => {
    vi.useFakeTimers();
    const manager = fakeSessionManager([makeSession('resumed', { cliTranscriptPath: undefined })]);
    const resolved: string[] = [];
    const tracker = new SessionContextUsageTracker({
      sessionManager: manager,
      resolve: (session) => {
        resolved.push(session.id);
        return { known: false, reason: 'no-usage-yet' };
      },
    });
    tracker.start(new EventEmitter());
    await vi.runAllTimersAsync();
    expect(resolved).toEqual([]);

    manager.getSession('resumed')!.cliTranscriptPath = 'resumed.jsonl';
    manager.announce('resumed');
    manager.announce('resumed');
    await vi.runAllTimersAsync();

    expect(resolved).toEqual(['resumed']);
    tracker.stop();
  });

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
