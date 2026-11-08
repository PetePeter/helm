import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ProfileRuntime } from '../src/session/profile-runtime.js';
import { ActiveProfileRuntimeView } from '../src/electron/active-profile-runtime.js';

function runtime(id: string) {
  const sessions = new EventEmitter() as EventEmitter & { list: () => string[] };
  sessions.list = () => [id];
  return { userProfileId: id, sessionManager: sessions } as unknown as ProfileRuntime;
}

describe('ActiveProfileRuntimeView', () => {
  it('routes existing service references to the newly selected runtime', () => {
    const first = runtime('one');
    const second = runtime('two');
    const view = new ActiveProfileRuntimeView(first);
    const sessions = view.runtime.sessionManager as unknown as { list: () => string[] };

    expect(sessions.list()).toEqual(['one']);
    view.select(second);
    expect(sessions.list()).toEqual(['two']);
  });

  it('moves event subscriptions with the active runtime and ignores inactive profiles', () => {
    const first = runtime('one');
    const second = runtime('two');
    const view = new ActiveProfileRuntimeView(first);
    const sessions = view.runtime.sessionManager as unknown as EventEmitter;
    const received: string[] = [];
    const onAdded = (id: string) => received.push(id);
    sessions.on('session:added', onAdded);

    (first.sessionManager as unknown as EventEmitter).emit('session:added', 'one-session');
    view.select(second);
    (first.sessionManager as unknown as EventEmitter).emit('session:added', 'stale-session');
    (second.sessionManager as unknown as EventEmitter).emit('session:added', 'two-session');
    sessions.off('session:added', onAdded);

    expect(received).toEqual(['one-session', 'two-session']);
  });
});
