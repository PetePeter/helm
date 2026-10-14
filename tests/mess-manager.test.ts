import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessManager } from '../src/session/mess-manager.js';
import { MessPersistence } from '../src/session/mess-persistence.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProjectRecord } from '../src/types/project.js';
import type { SessionInfo } from '../src/types/session.js';

const project: ProjectRecord = { id: 'project-manager', name: 'Project', canonicalPath: 'C:/project', createdAt: 1, updatedAt: 1 };
const otherProject: ProjectRecord = { id: 'project-other', name: 'Other', canonicalPath: 'C:/other', createdAt: 1, updatedAt: 1 };
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(now = 2_000_000_000_000) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-mess-manager-'));
  dirs.push(directory);
  const projects = { getById: (id: string) => [project, otherProject].find(item => item.id === id), findByPath: (path: string) => [project, otherProject].find(item => item.canonicalPath === path), list: () => [project, otherProject], save: () => {}, resolveForPath: () => { throw new Error('resolveForPath must not be called'); } };
  const sessions = new SessionManager(projects as any);
  const manager = new MessManager(sessions, projects as any, {
    now: () => now,
    persistenceFactory: (projectId) => new MessPersistence(projectId, { directory, now: () => now }),
    maxDeltaEntries: 2,
    maxDeltaBytes: 1_000_000,
  });
  return { directory, projects, sessions, manager };
}

function add(sessions: SessionManager, id: string, name: string, path = 'C:/project'): SessionInfo {
  const session: SessionInfo = { id, name, cliType: 'test', processId: 1, workingDir: path };
  sessions.addSession(session);
  return session;
}

describe('MessManager', () => {
  it('appends project broadcasts and emits their project identity', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    let emitted: any;
    manager.once('mess:appended', entry => { emitted = entry; });

    const entry = manager.post('sender', 'hello');

    expect(entry.projectId).toBe(project.id);
    expect(emitted).toMatchObject({ projectId: project.id, text: 'hello' });
  });

  // Unread means "posted since you joined". A time window cannot answer whether
  // an older message still applies to a session that did not exist yet, so a new
  // member starts at the head and is told separately that history exists.
  it('starts a new member at the head and a returning member at its cursor', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'posted moments before the newcomer existed');

    const receiver = add(sessions, 'receiver', 'memories');
    expect(manager.check(receiver.id).entries).toEqual([]);

    manager.post('sender', 'new');
    expect(manager.check(receiver.id).entries.map(entry => entry.text)).toEqual(['new']);
    expect(manager.check(receiver.id).entries).toEqual([]);
  });

  it('tells a new member once that earlier mess exists, then never again', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'earlier one');
    manager.post('sender', 'earlier two');
    const receiver = add(sessions, 'receiver', 'memories');

    const first = manager.check(receiver.id);
    expect(first.joined).toEqual({ prior: 2, oldestSeq: 1 });
    expect(first.entries).toEqual([]);

    manager.post('sender', 'after joining');
    const second = manager.check(receiver.id);
    expect(second.joined).toBeUndefined();
    expect(second.entries.map(entry => entry.text)).toEqual(['after joining']);
  });

  // The notifier calls unreadCount, which creates the cursor. If cursor
  // creation consumed the notice, the poke would eat it before the agent ever
  // looked, and the newcomer would never learn that history exists.
  it('does not let a notifier unread poll consume the join notice', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'earlier');
    const receiver = add(sessions, 'receiver', 'memories');

    expect(manager.unreadCount(receiver.id)).toBe(0);

    expect(manager.check(receiver.id).joined).toEqual({ prior: 1, oldestSeq: 1 });
  });

  it('counts only entries the newcomer may read as prior context', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    add(sessions, 'other', 'other');
    manager.post('sender', 'broadcast');
    manager.post('sender', 'private', 'other');
    const receiver = add(sessions, 'receiver', 'memories');

    expect(manager.check(receiver.id).joined).toEqual({ prior: 1, oldestSeq: 1 });
  });

  it('omits the join notice for a project with no earlier mess', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');

    expect(manager.check(receiver.id).joined).toBeUndefined();

    manager.post('sender', 'first ever');
    expect(manager.check(receiver.id).joined).toBeUndefined();
  });

  it('keeps the join notice spent across a restart', () => {
    const { sessions, manager, directory, projects } = setup();
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'earlier');
    const receiver = add(sessions, 'receiver', 'memories');
    expect(manager.check(receiver.id).joined).toEqual({ prior: 1, oldestSeq: 1 });

    const reloaded = new MessManager(sessions, projects as any, {
      now: () => 2_000_000_000_000,
      persistenceFactory: (projectId) => new MessPersistence(projectId, { directory }),
    });

    expect(reloaded.check(receiver.id).joined).toBeUndefined();
  });

  it('finds entries by literal text with surrounding context', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    for (const text of ['one', 'two', 'the resize path', 'four', 'five']) manager.post('sender', text);

    const result = manager.search(receiver.id, { query: 'RESIZE', before: 1, after: 1 });

    expect(result.entries.map(entry => entry.text)).toEqual(['two', 'the resize path', 'four']);
    expect(result.matchedSeqs).toEqual([3]);
  });

  it('treats the query as literal text rather than a pattern', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.post('sender', 'a.c');
    manager.post('sender', 'abc');

    expect(manager.search(receiver.id, { query: 'a.c' }).entries.map(entry => entry.text)).toEqual(['a.c']);
  });

  it('merges overlapping context windows without repeating an entry', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    for (const text of ['hit', 'filler', 'hit', 'tail']) manager.post('sender', text);

    const result = manager.search(receiver.id, { query: 'hit', before: 2, after: 2 });

    expect(result.entries.map(entry => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(result.matchedSeqs).toEqual([1, 3]);
  });

  it('never returns another session\'s directed mail as a match or as context', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    add(sessions, 'other', 'other');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.post('sender', 'public secret');
    manager.post('sender', 'private secret', 'other');
    manager.post('sender', 'trailer');

    const result = manager.search(receiver.id, { query: 'secret', before: 5, after: 5 });

    expect(result.entries.map(entry => entry.text)).toEqual(['public secret', 'trailer']);
    expect(result.matchedSeqs).toEqual([1]);
  });

  it('searches the whole retained log rather than a recent window', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    new MessPersistence(project.id, { directory }).append({
      projectId: project.id,
      fromSessionId: 'sender',
      fromLabelSnapshot: 'planner',
      text: 'ancient landmark',
      createdAt: 2_000_000_000_000 - 20 * 24 * 60 * 60 * 1000,
    });
    const receiver = add(sessions, 'receiver', 'memories');

    expect(manager.search(receiver.id, { query: 'landmark' }).entries.map(entry => entry.text))
      .toEqual(['ancient landmark']);
  });

  it('bounds search results and never advances the caller cursor', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    for (const text of ['hit a', 'hit b', 'hit c']) manager.post('sender', text);

    const result = manager.search(receiver.id, { query: 'hit', limit: 2 });

    expect(result.matchedSeqs).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(manager.check(receiver.id).entries[0].text).toBe('hit a');
  });

  it('reads the full retained window when history is asked for without an age limit', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    new MessPersistence(project.id, { directory }).append({
      projectId: project.id,
      fromSessionId: 'sender',
      fromLabelSnapshot: 'planner',
      text: 'old but retained',
      createdAt: 2_000_000_000_000 - 20 * 24 * 60 * 60 * 1000,
    });
    const receiver = add(sessions, 'receiver', 'memories');

    expect(manager.history(receiver.id, {}).map(entry => entry.text)).toEqual(['old but retained']);
    expect(manager.history(receiver.id, { sinceHours: 1 })).toEqual([]);
  });

  it('bounds by count, advances only through returned entries, and reports more', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    manager.post('sender', 'one');
    manager.post('sender', 'two');
    manager.post('sender', 'three');

    const first = manager.check(receiver.id);
    const second = manager.check(receiver.id);

    expect(first.entries.map(entry => entry.text)).toEqual(['one', 'two']);
    expect(first).toMatchObject({ new: 2, hasMore: true });
    expect(second.entries.map(entry => entry.text)).toEqual(['three']);
    expect(manager.check(receiver.id).entries).toEqual([]);
  });

  it('advances past directed entries addressed to other sessions without hiding later mail', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    const other = add(sessions, 'other', 'other');
    manager.check(receiver.id);
    manager.post('sender', 'for other', other.id);
    manager.post('sender', 'for receiver', receiver.id);

    const result = manager.check(receiver.id);

    expect(result.entries.map(entry => entry.text)).toEqual(['for receiver']);
    expect(manager.check(receiver.id).entries).toEqual([]);
  });

  it('does not acknowledge an invisible direct entry when it is the only unread entry', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    const other = add(sessions, 'other', 'other');
    manager.check(receiver.id);
    manager.post('sender', 'for other', other.id);

    expect(manager.check(receiver.id)).toMatchObject({ new: 0, hasMore: false });
    expect(new MessPersistence(project.id, { directory }).getCursor(receiver.id)).toMatchObject({ lastSeq: 0 });
  });

  it('uses sequence order when a clock rollback makes a later entry look old', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    new MessPersistence(project.id, { directory }).append({ projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner', text: 'recent seq 1', createdAt: 2_000_000_000_000 });
    new MessPersistence(project.id, { directory }).append({ projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner', text: 'rolled back seq 2', createdAt: 2_000_000_000_000 - 25 * 60 * 60 * 1000 });

    expect(manager.check(receiver.id).entries.map(entry => entry.text)).toEqual(['recent seq 1', 'rolled back seq 2']);
  });

  it('includes one oversized entry to guarantee progress and then stops at the byte bound', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    manager.post('sender', 'this is larger than the configured byte budget');

    const result = manager.check(receiver.id, { maxBytes: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it('rejects directed posts across projects without creating membership', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    add(sessions, 'other', 'other', 'C:/other');

    expect(() => manager.post('sender', 'nope', 'other')).toThrow('same project');
  });

  it('preserves recoverable cursors and removes ephemeral cursors', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.post('sender', 'one');
    manager.check(receiver.id);
    manager.onSessionClosed(receiver.id, 'recoverable');
    expect(new MessPersistence(project.id, { directory }).getCursor(receiver.id)).toBeDefined();
    manager.onSessionClosed(receiver.id, 'ephemeral');

    expect(new MessPersistence(project.id, { directory }).getCursor(receiver.id)).toBeUndefined();
  });

  it('reports a retention gap instead of returning a clean empty delta', () => {
    const { sessions, manager, directory } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    manager.post('sender', 'one');
    const persistence = new MessPersistence(project.id, { directory });
    const cursor = persistence.getCursor(receiver.id)!;
    persistence.saveCursor({ ...cursor, lastSeq: 0 });
    persistence.prune(0, 2_000_000_000_000 + 1);

    expect(manager.check(receiver.id)).toMatchObject({ gap: true, oldestSeq: 2 });
  });

  // An author already knows what it just said. Counting its own post as unread
  // inflates the notifier's poke and replays the message back to its writer.
  it('never counts or returns an entry to the session that authored it', () => {
    const { sessions, manager } = setup();
    const sender = add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(sender.id);
    manager.check(receiver.id);

    manager.post('sender', 'my own words');

    expect(manager.unreadCount(sender.id)).toBe(0);
    expect(manager.check(sender.id)).toMatchObject({ new: 0, entries: [] });
    expect(manager.unreadCount(receiver.id)).toBe(1);
    expect(manager.check(receiver.id).entries.map(entry => entry.text)).toEqual(['my own words']);
  });

  it('still shows a session its own posts in history', () => {
    const { sessions, manager } = setup();
    const sender = add(sessions, 'sender', 'planner');
    manager.post('sender', 'my own words');

    expect(manager.history(sender.id, { sinceHours: 1 }).map(entry => entry.text)).toEqual(['my own words']);
  });

  // A directed post is addressed away from its author, so a to-only visibility
  // rule erased it from the sender's own transcript the moment it was sent.
  it('shows an author the directed posts it sent, without making them unread', () => {
    const { sessions, manager } = setup();
    const sender = add(sessions, 'sender', 'planner');
    add(sessions, 'receiver', 'memories');
    add(sessions, 'bystander', 'bystander');
    manager.post('sender', 'just for you', 'receiver');

    expect(manager.history(sender.id, { sinceHours: 1 }).map(entry => entry.text)).toEqual(['just for you']);
    expect(manager.unreadCount(sender.id)).toBe(0);
    expect(manager.history('bystander', { sinceHours: 1 })).toEqual([]);
  });

  it('advances the author cursor past its own post so a peer reply is the only unread entry', () => {
    const { sessions, manager } = setup();
    const sender = add(sessions, 'sender', 'planner');
    add(sessions, 'receiver', 'memories');
    manager.check(sender.id);
    manager.post('sender', 'question');
    manager.post('receiver', 'answer');

    const delta = manager.check(sender.id);

    expect(delta.new).toBe(1);
    expect(delta.entries.map(entry => entry.text)).toEqual(['answer']);
    expect(manager.check(sender.id)).toMatchObject({ new: 0 });
  });

  it('returns bounded history without advancing the check cursor', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    manager.check(receiver.id);
    manager.post('sender', 'historical');

    expect(manager.history(receiver.id, { sinceHours: 1 }).map(entry => entry.text)).toEqual(['historical']);
    expect(manager.check(receiver.id).entries.map(entry => entry.text)).toEqual(['historical']);
  });

  it('returns all project entries for the human observer without advancing a session cursor', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const receiver = add(sessions, 'receiver', 'memories');
    const other = add(sessions, 'other', 'other');
    manager.check(receiver.id);
    manager.post('sender', 'for receiver', receiver.id);
    manager.post('sender', 'for other', other.id);

    expect(manager.historyForProject(project.id, { sinceHours: 1 }).entries.map(entry => entry.text))
      .toEqual(['for receiver', 'for other']);
    expect(manager.check(receiver.id).entries.map(entry => entry.text)).toEqual(['for receiver']);
  });

  it('uses the human history byte budget independently from the AI delta budget', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    const large = 'x'.repeat(200_000);
    manager.post('sender', large);
    manager.post('sender', large);

    const result = manager.historyForProject(project.id, { sinceHours: 1, limit: 10 });

    expect(result.entries).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it('enforces the project retention window on the read path and reports the new floor', () => {
    const now = 2_000_000_000_000;
    const { sessions, manager, directory } = setup(now);
    add(sessions, 'sender', 'planner');
    const log = new MessPersistence(project.id, { directory });
    const base = { projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner' };
    log.append({ ...base, text: 'ancient', createdAt: now - 40 * 24 * 60 * 60 * 1000 });
    log.append({ ...base, text: 'fresh', createdAt: now });

    manager.historyForProject(project.id, { sinceHours: 24 * 60 });

    const remaining = new MessPersistence(project.id, { directory }).load();
    expect(remaining.entries.map(entry => entry.text)).toEqual(['fresh']);
    expect(remaining.prunedThroughSeq).toBe(1);
  });

  it('does not rewrite the log again until the prune interval has elapsed', () => {
    const now = 2_000_000_000_000;
    const { sessions, manager, directory } = setup(now);
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'first');
    const log = new MessPersistence(project.id, { directory });
    log.append({ projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner', text: 'ancient', createdAt: now - 40 * 24 * 60 * 60 * 1000 });

    manager.post('sender', 'second');

    expect(new MessPersistence(project.id, { directory }).load().entries.map(entry => entry.text))
      .toEqual(['first', 'ancient', 'second']);
  });

  it('pages history by ordered sequence without advancing a session cursor', () => {
    const { sessions, manager } = setup();
    add(sessions, 'sender', 'planner');
    manager.post('sender', 'one');
    manager.post('sender', 'two');
    manager.post('sender', 'three');

    const result = manager.historyForProject(project.id, { sinceHours: 1, limit: 2, beforeSeq: 3 });

    expect(result.entries.map(entry => entry.text)).toEqual(['one', 'two']);
    expect(result.hasMore).toBe(false);
  });

  it('returns entries older than a day when no time window is requested', () => {
    const now = 2_000_000_000_000;
    const { sessions, manager, directory } = setup(now);
    add(sessions, 'sender', 'planner');
    const log = new MessPersistence(project.id, { directory });
    const base = { projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner' };
    log.append({ ...base, text: 'three days ago', createdAt: now - 3 * 24 * 60 * 60 * 1000 });
    log.append({ ...base, text: 'two days ago', createdAt: now - 2 * 24 * 60 * 60 * 1000 });

    const result = manager.historyForProject(project.id, { limit: 1 });

    expect(result.entries.map(entry => entry.text)).toEqual(['two days ago']);
    expect(result.hasMore).toBe(true);
  });

  it('reports older entries beyond a requested time window', () => {
    const now = 2_000_000_000_000;
    const { sessions, manager, directory } = setup(now);
    add(sessions, 'sender', 'planner');
    const log = new MessPersistence(project.id, { directory });
    const base = { projectId: project.id, fromSessionId: 'sender', fromLabelSnapshot: 'planner' };
    log.append({ ...base, text: 'old', createdAt: now - 2 * 24 * 60 * 60 * 1000 });
    log.append({ ...base, text: 'fresh', createdAt: now });

    const result = manager.historyForProject(project.id, { sinceHours: 1 });

    expect(result.entries.map(entry => entry.text)).toEqual(['fresh']);
    expect(result.hasMore).toBe(true);
  });
});
