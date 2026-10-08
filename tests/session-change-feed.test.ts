/**
 * SessionChangeFeed — the sequence a far-away session list catches up from.
 *
 * Real feed over a real SessionManager where the wiring matters; the rest is
 * the cursor arithmetic, whose every wrong answer is a phone showing a list
 * that is quietly not the desktop's.
 */

import { describe, it, expect } from 'vitest';
import { SessionChangeFeed } from '../src/session/session-change-feed';
import { SessionManager } from '../src/session/manager';

function feedAt(epoch = 'e1', maxTombstones?: number): SessionChangeFeed {
  return new SessionChangeFeed({ epoch, maxTombstones });
}

describe('SessionChangeFeed cursors', () => {
  it('answers a reader with no cursor with everything', () => {
    const feed = feedAt();
    feed.touch('a');
    expect(feed.since(null)).toEqual({ full: true });
  });

  it('answers a cursor from another epoch with everything — a restart is not a gap to guess at', () => {
    const feed = feedAt('after-restart');
    feed.touch('a');
    expect(feed.since({ epoch: 'before-restart', seq: 1 })).toEqual({ full: true });
  });

  it('answers a cursor ahead of the feed with everything', () => {
    const feed = feedAt();
    feed.touch('a');
    expect(feed.since({ epoch: 'e1', seq: 99 })).toEqual({ full: true });
  });

  it('reports nothing to a reader that is caught up', () => {
    const feed = feedAt();
    feed.touch('a');
    feed.touch('b');
    expect(feed.since({ epoch: 'e1', seq: feed.seq })).toEqual({ full: false, changed: [], removed: [] });
  });

  it('reports only what moved after the cursor', () => {
    const feed = feedAt();
    feed.touch('a');
    feed.touch('b');
    const cursor = { epoch: 'e1', seq: feed.seq };
    feed.touch('c');
    feed.touch('a');
    // Order carries no meaning: the reader merges by id.
    expect(feed.since(cursor)).toEqual({ full: false, changed: expect.arrayContaining(['a', 'c']), removed: [] });
    expect((feed.since(cursor) as { changed: string[] }).changed).toHaveLength(2);
  });

  it('reports a session that changed many times once', () => {
    const feed = feedAt();
    const cursor = { epoch: 'e1', seq: feed.seq };
    feed.touch('a');
    feed.touch('a');
    feed.touch('a');
    expect(feed.since(cursor)).toEqual({ full: false, changed: ['a'], removed: [] });
  });

  it('reports a closed session as removed and no longer as changed', () => {
    const feed = feedAt();
    feed.touch('a');
    const cursor = { epoch: 'e1', seq: feed.seq };
    feed.touch('a');
    feed.remove('a');
    expect(feed.since(cursor)).toEqual({ full: false, changed: [], removed: ['a'] });
  });

  it('reports a session that came back as changed and no longer as removed', () => {
    const feed = feedAt();
    feed.touch('a');
    const cursor = { epoch: 'e1', seq: feed.seq };
    feed.remove('a');
    feed.touch('a');
    expect(feed.since(cursor)).toEqual({ full: false, changed: ['a'], removed: [] });
  });

  it('gives everything to a cursor older than a removal it has had to forget', () => {
    const feed = feedAt('e1', 2);
    const old = { epoch: 'e1', seq: feed.seq };
    feed.remove('a');
    feed.remove('b');
    const recent = { epoch: 'e1', seq: feed.seq };
    feed.remove('c');

    // 'a' was forgotten to make room: a reader that never heard of it going
    // cannot be told, so it must take the whole list.
    expect(feed.since(old)).toEqual({ full: true });
    expect(feed.since(recent)).toEqual({ full: false, changed: [], removed: ['c'] });
  });

  it('announces every move with the new seq', () => {
    const feed = feedAt();
    const moved: number[] = [];
    feed.on('moved', (seq: number) => moved.push(seq));
    feed.touch('a');
    feed.remove('a');
    expect(moved).toEqual([1, 2]);
  });
});

describe('SessionChangeFeed following a SessionManager', () => {
  function managed() {
    const manager = new SessionManager();
    const feed = feedAt();
    feed.attach(manager);
    return { manager, feed };
  }

  const session = (id: string) => ({ id, name: id, cliType: 'claude', processId: 1 });

  it('moves when a session is added, updated, renamed and removed', () => {
    const { manager, feed } = managed();
    const start = { epoch: 'e1', seq: feed.seq };

    manager.addSession(session('a'), true);
    manager.addSession(session('b'), true);
    expect(feed.since(start)).toEqual({ full: false, changed: ['a', 'b'], removed: [] });

    const afterAdds = { epoch: 'e1', seq: feed.seq };
    manager.updateSession('a', { activityLevel: 'active' });
    manager.renameSession('b', 'renamed');
    expect(feed.since(afterAdds)).toEqual({ full: false, changed: ['a', 'b'], removed: [] });

    const afterUpdates = { epoch: 'e1', seq: feed.seq };
    manager.removeSession('a');
    expect(feed.since(afterUpdates)).toEqual({ full: false, changed: [], removed: ['a'] });
  });

  it('does not move when only the ACTIVE session changes — that is the desktop\'s focus, not a row', () => {
    const { manager, feed } = managed();
    manager.addSession(session('a'), true);
    manager.addSession(session('b'), true);
    const cursor = { epoch: 'e1', seq: feed.seq };

    manager.setActiveSession('b', true);

    expect(feed.since(cursor)).toEqual({ full: false, changed: [], removed: [] });
  });
});
