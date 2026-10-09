import { describe, expect, it } from 'vitest';
import { PeerSessionStore } from '../renderer/peer-session-store.js';

const session = (id: string, activityLevel = 'inactive') => ({
  id,
  name: id,
  cliType: 'claude-code',
  activityLevel,
});

describe('PeerSessionStore', () => {
  it('drops a fetch that started before a newer pushed snapshot', () => {
    const store = new PeerSessionStore();
    const request = store.beginRefresh('peer-a');

    store.applyPush('peer-a', [session('new', 'active')]);

    expect(store.completeRefresh('peer-a', request, [session('old')])).toBe(false);
    expect(store.get('peer-a')).toMatchObject({ sessions: [session('new', 'active')], stale: false });
  });

  it('marks cached rows stale on disconnect and fresh after an accepted reconnect fetch', () => {
    const store = new PeerSessionStore();
    store.applyPush('peer-a', [session('one')]);
    store.setOnline('peer-a', false);
    expect(store.get('peer-a')).toMatchObject({ online: false, stale: true, sessions: [session('one')] });

    store.setOnline('peer-a', true);
    const request = store.beginRefresh('peer-a');
    expect(store.completeRefresh('peer-a', request, [session('two', 'active')])).toBe(true);
    expect(store.get('peer-a')).toMatchObject({ online: true, stale: false, sessions: [session('two', 'active')] });
  });

  it('clears the cached list when the peer is unpaired', () => {
    const store = new PeerSessionStore();
    store.applyPush('peer-a', [session('one')]);
    store.clear('peer-a');
    expect(store.get('peer-a')).toBeUndefined();
  });
});
