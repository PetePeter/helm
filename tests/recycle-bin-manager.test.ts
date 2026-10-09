/**
 * RecycleBinManager tests.
 *
 * Uses the real manager + real helper. Persistence is isolated to an in-memory
 * store so parallel test files do not contend on the shared recycle-bin.yaml.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';
import { BUILTIN_SHELL_CLI_TYPE, type SessionInfo, type SessionRemovedEvent } from '../src/types/session.js';

let diskStore: RecycleBinEntry[] = [];
vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  saveRecycleBin: (entries: RecycleBinEntry[]) => { diskStore = [...entries]; },
  loadRecycleBin: () => [...diskStore],
}));

const {
  RecycleBinManager,
  RECYCLE_BIN_WINDOW_MS,
  recordRemovedSession,
} = await import('../src/session/recycle-bin-manager.js');

type NewEntry = Omit<RecycleBinEntry, 'id'>;

function makeEntry(overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    sessionId: 'sess-1',
    name: 'claude-opus',
    cliType: 'claude-code',
    workingDir: 'X:\\coding\\test',
    cliSessionName: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    closedAt: Date.now(),
    ...overrides,
  };
}

function makeRemovedEvent(session: Partial<SessionInfo>, timestamp = Date.now()): SessionRemovedEvent {
  return {
    sessionId: session.id ?? 'sess-1',
    session: {
      id: 'sess-1',
      name: 'claude-opus',
      cliType: 'claude-code',
      processId: 1234,
      ...session,
    },
    timestamp,
  };
}

describe('RecycleBinManager', () => {
  let manager: InstanceType<typeof RecycleBinManager>;

  beforeEach(() => {
    diskStore = [];
    manager = new RecycleBinManager();
  });

  it('append adds a recoverable entry, assigns a UUID id, and emits changed', () => {
    const listener = vi.fn();
    manager.on('recycle-bin:changed', listener);

    const created = manager.append(makeEntry());

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe('claude-opus');
    expect(manager.list()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('prunes entries older than the 30-day window using the injected clock', () => {
    const fixedNow = 1_700_000_000_000;
    manager = new RecycleBinManager(() => fixedNow);

    manager.append(makeEntry({ sessionId: 'fresh', closedAt: fixedNow - 1000 }));
    manager.append(makeEntry({ sessionId: 'stale', closedAt: fixedNow - RECYCLE_BIN_WINDOW_MS - 1 }));

    const ids = manager.list().map(e => e.sessionId);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('emits recycle-bin:expired with entries that age out at runtime', () => {
    let nowVal = 1_700_000_000_000;
    manager = new RecycleBinManager(() => nowVal);
    // Appended fresh, so it survives its own append-time prune.
    manager.append(makeEntry({ sessionId: 'stale', closedAt: nowVal }));

    const expiredListener = vi.fn();
    manager.on('recycle-bin:expired', expiredListener);
    // Advance past the retention window, then a later append prunes the aged entry.
    nowVal += RECYCLE_BIN_WINDOW_MS + 1;
    manager.append(makeEntry({ sessionId: 'fresh', closedAt: nowVal }));

    expect(expiredListener).toHaveBeenCalledTimes(1);
    const expired = expiredListener.mock.calls[0][0] as Array<{ sessionId: string }>;
    expect(expired.map(e => e.sessionId)).toEqual(['stale']);
  });

  it('does NOT emit recycle-bin:expired when nothing ages out', () => {
    const nowVal = 1_700_000_000_000;
    manager = new RecycleBinManager(() => nowVal);
    const expiredListener = vi.fn();
    manager.on('recycle-bin:expired', expiredListener);
    manager.append(makeEntry({ sessionId: 'fresh', closedAt: nowVal }));
    expect(expiredListener).not.toHaveBeenCalled();
  });

  it('loads existing entries from persistence on construction', () => {
    diskStore = [{ ...makeEntry({ sessionId: 'prior' }), id: 'id-prior' }];
    const loaded = new RecycleBinManager();
    expect(loaded.list().map(e => e.sessionId)).toEqual(['prior']);
  });

  it('list returns entries newest-close first', () => {
    const base = Date.now();
    manager.append(makeEntry({ sessionId: 'old', closedAt: base - 3000 }));
    manager.append(makeEntry({ sessionId: 'new', closedAt: base - 1000 }));
    manager.append(makeEntry({ sessionId: 'mid', closedAt: base - 2000 }));
    expect(manager.list().map(e => e.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('forget removes a single entry and emits changed', () => {
    const a = manager.append(makeEntry({ sessionId: 'a' }));
    manager.append(makeEntry({ sessionId: 'b' }));

    const listener = vi.fn();
    manager.on('recycle-bin:changed', listener);
    manager.forget(a.id);

    const ids = manager.list().map(e => e.sessionId);
    expect(ids).toEqual(['b']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('empty clears all entries and emits changed', () => {
    manager.append(makeEntry({ sessionId: 'a' }));
    manager.append(makeEntry({ sessionId: 'b' }));

    const listener = vi.fn();
    manager.on('recycle-bin:changed', listener);
    manager.empty();

    expect(manager.list()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('peek returns the entry WITHOUT removing it (restore commits separately)', () => {
    const a = manager.append(makeEntry({ sessionId: 'a', cliSessionName: 'resume-uuid' }));

    const peeked = manager.peek(a.id);

    expect(peeked?.cliSessionName).toBe('resume-uuid');
    expect(manager.list()).toHaveLength(1); // still present until commit (forget)
    expect(manager.peek('missing-id')).toBeNull();
  });
});

describe('recordRemovedSession', () => {
  beforeEach(() => { diskStore = []; });

  it('adds an entry AND bookmarks the dir when the session had a cliSessionName', () => {
    const manager = new RecycleBinManager();
    const bookmark = vi.fn();

    const closedAt = Date.now() - 5000;
    const event = makeRemovedEvent(
      { cliSessionName: 'resume-uuid', workingDir: 'X:\\coding\\proj' },
      closedAt,
    );
    const entry = recordRemovedSession(event, manager, bookmark);

    expect(entry).not.toBeNull();
    expect(entry?.cliSessionName).toBe('resume-uuid');
    expect(entry?.closedAt).toBe(closedAt);
    expect(manager.list()).toHaveLength(1);
    expect(bookmark).toHaveBeenCalledWith('X:\\coding\\proj');
  });

  it('does NOT add an entry when the session had no cliSessionName (ephemeral)', () => {
    const manager = new RecycleBinManager();
    const bookmark = vi.fn();

    const event = makeRemovedEvent({ workingDir: 'X:\\coding\\proj' });
    const entry = recordRemovedSession(event, manager, bookmark);

    expect(entry).toBeNull();
    expect(manager.list()).toHaveLength(0);
    expect(bookmark).not.toHaveBeenCalled();
  });

  it('does NOT make a built-in shell restorable even if it has resume fields', () => {
    const manager = new RecycleBinManager();
    const bookmark = vi.fn();
    const event = makeRemovedEvent({
      cliType: BUILTIN_SHELL_CLI_TYPE,
      cliSessionName: 'shell-resume-id',
      workingDir: 'X:\\coding\\project',
    });

    const entry = recordRemovedSession(event, manager, bookmark);

    expect(entry).toBeNull();
    expect(manager.list()).toHaveLength(0);
    expect(bookmark).not.toHaveBeenCalled();
  });
});
