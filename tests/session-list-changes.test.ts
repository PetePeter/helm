/**
 * session_list as a delta — the retrieval half of the session change feed.
 *
 * Real HelmControlService over a real SessionManager and the real feed; only
 * the PTY, config and plan collaborators are stand-ins, because a session row
 * is built from them and nothing here is about what they say.
 */

import { describe, it, expect } from 'vitest';
import { HelmControlService } from '../src/mcp/helm-control-service';
import { SessionManager } from '../src/session/manager';
import { parseSessionFeedCursor } from '../src/session/session-change-feed';

function makeService() {
  const sessionManager = new SessionManager();
  const service = new HelmControlService(
    { getForDirectory: () => [], getItem: () => null, exportAll: () => ({}) } as never,
    sessionManager,
    { has: () => true } as never,
    {
      getCliTypeEntry: () => ({}),
      getCliTypeLabel: (ref: string) => ref,
      getWorkingDirectories: () => [],
    } as never,
  );
  service.sessionChangeFeed.attach(sessionManager);
  const add = (id: string) => sessionManager.addSession({ id, name: id, cliType: 'claude', processId: 1 }, true);
  return { service, sessionManager, add };
}

describe('HelmControlService.listSessionChanges', () => {
  it('answers a first fetch with the whole list and a cursor to come back with', () => {
    const { service, add } = makeService();
    add('a');
    add('b');

    const reply = service.listSessionChanges(null);

    expect(reply.full).toBe(true);
    expect(reply.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(reply.removed).toEqual([]);
    expect(reply).toMatchObject({ epoch: service.sessionChangeFeed.epoch, seq: 2 });
  });

  it('answers a caught-up cursor with no rows at all', () => {
    const { service, add } = makeService();
    add('a');
    const first = service.listSessionChanges(null);

    const second = service.listSessionChanges({ epoch: first.epoch, seq: first.seq });

    expect(second).toEqual({ epoch: first.epoch, seq: first.seq, full: false, sessions: [], removed: [] });
  });

  it('returns only the rows that changed, carrying their new values', () => {
    const { service, sessionManager, add } = makeService();
    add('a');
    add('b');
    const first = service.listSessionChanges(null);

    sessionManager.updateSession('b', { activityLevel: 'active' });
    const second = service.listSessionChanges({ epoch: first.epoch, seq: first.seq });

    expect(second.full).toBe(false);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]).toMatchObject({ id: 'b', activityLevel: 'active' });
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('names a closed session in removed and sends no row for it', () => {
    const { service, sessionManager, add } = makeService();
    add('a');
    add('b');
    const first = service.listSessionChanges(null);

    sessionManager.removeSession('a');
    const second = service.listSessionChanges({ epoch: first.epoch, seq: first.seq });

    expect(second.sessions).toEqual([]);
    expect(second.removed).toEqual(['a']);
  });

  it('gives the whole list to a cursor from before a restart', () => {
    const { service, add } = makeService();
    add('a');

    const reply = service.listSessionChanges({ epoch: 'the-previous-run', seq: 1 });

    expect(reply.full).toBe(true);
    expect(reply.sessions.map((s) => s.id)).toEqual(['a']);
  });
});

describe('parseSessionFeedCursor', () => {
  it('reads a seq sent as a number or as the string the phone encodes', () => {
    expect(parseSessionFeedCursor('e1', 7)).toEqual({ epoch: 'e1', seq: 7 });
    expect(parseSessionFeedCursor('e1', '7')).toEqual({ epoch: 'e1', seq: 7 });
  });

  it('reads anything else as no cursor, so the caller is given everything', () => {
    expect(parseSessionFeedCursor(undefined, 7)).toBeNull();
    expect(parseSessionFeedCursor('', 7)).toBeNull();
    expect(parseSessionFeedCursor('e1', '')).toBeNull();
    expect(parseSessionFeedCursor('e1', 'soon')).toBeNull();
    expect(parseSessionFeedCursor('e1', -1)).toBeNull();
    expect(parseSessionFeedCursor('e1', 1.5)).toBeNull();
  });
});
