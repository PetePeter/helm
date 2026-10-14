/**
 * Access tracking, sorted listing, and literal-search case folding.
 *
 * These three exist to make trimming possible: you cannot decide what to forget
 * without knowing what was last read, and you cannot find what to forget if the
 * search only matches the casing you happened to type.
 */

import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../src/session/memory-manager.js';
import type { MemoryState } from '../src/types/memory.js';

const SESSION = 'session-a';
const OTHER_SESSION = 'session-b';

/** A manager whose clock advances one tick per read, so orderings are decidable. */
function makeManager(startAt = 1000) {
  let clock = startAt;
  let sequence = 0;
  const manager = new MemoryManager({
    persist: () => {},
    now: () => clock,
    idFactory: () => `m${++sequence}`,
  });
  return {
    manager,
    tick: (to: number) => { clock = to; },
  };
}

describe('literal search is case-insensitive', () => {
  // The exact regression: content holds `prepareDeploy.py`, the natural query
  // is lowercase `deploy`, and it used to return nothing.
  it('matches content regardless of case', () => {
    const { manager } = makeManager();
    manager.createForSession(SESSION, {
      tldr: 'Helm release flow',
      content: 'prepareDeploy.py bumps the version, sendDeploy.py publishes it.',
    });

    const result = manager.searchForSession(SESSION, 'deploy');

    expect(result.hits).toHaveLength(1);
  });

  it('matches the tldr regardless of case', () => {
    const { manager } = makeManager();
    manager.createForSession(SESSION, { tldr: 'Config Boundary', content: 'irrelevant body' });

    expect(manager.searchForSession(SESSION, 'config boundary').hits).toHaveLength(1);
  });

  // Regex mode is an explicit instruction from the caller; blanket-folding it
  // would take away the only way to express a case-sensitive query.
  it('leaves regex mode case-sensitive', () => {
    const { manager } = makeManager();
    manager.createForSession(SESSION, { tldr: 'lowercase deploy', content: 'body' });

    expect(manager.searchForSession(SESSION, 'Deploy', { regex: true }).hits).toHaveLength(0);
    expect(manager.searchForSession(SESSION, 'deploy', { regex: true }).hits).toHaveLength(1);
  });

  it('still refuses to match another session\'s records', () => {
    const { manager } = makeManager();
    manager.createForSession(OTHER_SESSION, { tldr: 'Deploy notes', content: 'body' });

    expect(manager.searchForSession(SESSION, 'deploy').hits).toHaveLength(0);
  });
});

describe('access tracking', () => {
  it('stamps lastAccessedAt on read', () => {
    const { manager, tick } = makeManager();
    const created = manager.createForSession(SESSION, { tldr: 'a', content: 'body' });
    expect(created.lastAccessedAt).toBeUndefined();

    tick(2000);
    manager.getRecordForSession(SESSION, created.id);

    expect(manager.getRecordForSession(SESSION, created.id)!.lastAccessedAt).toBe(2000);
  });

  // Searching is not reading: a match tells you the memory was findable, not
  // that it was useful, so it must not masquerade as an access.
  it('does not stamp access on a search match', () => {
    const { manager, tick } = makeManager();
    const hit = manager.createForSession(SESSION, { tldr: 'needle', content: 'body' });

    tick(3000);
    manager.searchForSession(SESSION, 'needle');

    expect(manager.exportState().records.find((r) => r.id === hit.id)!.lastAccessedAt).toBeUndefined();
  });

  // A trim signal must not look like an edit, or every read would make a
  // memory appear freshly authored and defeat sorting by updatedAt.
  it('never advances updatedAt', () => {
    const { manager, tick } = makeManager();
    const created = manager.createForSession(SESSION, { tldr: 'needle', content: 'body' });

    tick(4000);
    manager.getRecordForSession(SESSION, created.id);

    expect(manager.getRecordForSession(SESSION, created.id)!.updatedAt).toBe(1000);
  });

  it('loads legacy records that predate the fields', () => {
    const legacy: MemoryState = {
      records: [{
        id: 'old', sessionId: SESSION, tldr: 'legacy', content: 'body',
        createdAt: 1, updatedAt: 1, attachments: [],
      }],
      edges: [],
    };
    const manager = new MemoryManager({
      persist: () => {},
      persistence: { load: () => ({ state: legacy }), save: () => {} } as never,
    });

    const listed = manager.listRecordsForSession(SESSION);
    expect(listed).toHaveLength(1);
    expect(listed[0].lastAccessedAt).toBeUndefined();
  });
});

describe('sorted listing', () => {
  function seed() {
    const { manager, tick } = makeManager();
    tick(100);
    const first = manager.createForSession(SESSION, { tldr: 'first needle', content: 'body' });
    tick(200);
    const second = manager.createForSession(SESSION, { tldr: 'second', content: 'body' });
    tick(300);
    const third = manager.createForSession(SESSION, { tldr: 'third', content: 'body' });
    return { manager, tick, first, second, third };
  }

  it('sorts by creation time, newest first, and reverses on request', () => {
    const { manager, first, third } = seed();

    const desc = manager.listRecordsForSession(SESSION, { sortBy: 'created', order: 'desc' });
    expect(desc.map((r) => r.id)).toEqual([third.id, expect.any(String), first.id]);

    const asc = manager.listRecordsForSession(SESSION, { sortBy: 'created', order: 'asc' });
    expect(asc[0].id).toBe(first.id);
  });

  it('sorts by access time', () => {
    const { manager, tick, first, third } = seed();
    tick(400);
    manager.getRecordForSession(SESSION, first.id);

    const byAccess = manager.listRecordsForSession(SESSION, { sortBy: 'accessed', order: 'desc' });

    expect(byAccess[0].id).toBe(first.id);
    expect(byAccess[byAccess.length - 1].id).not.toBe(first.id);
    expect(byAccess).toHaveLength(3);
    expect(third).toBeTruthy();
  });

  // The trap: an unset timestamp read as 0 would make never-touched memories
  // look like the oldest things in the store — exactly what a trim deletes.
  it('sorts never-accessed records last, not first', () => {
    const { manager, tick, second } = seed();
    tick(600);
    manager.getRecordForSession(SESSION, second.id);

    const oldestFirst = manager.listRecordsForSession(SESSION, { sortBy: 'accessed', order: 'asc' });

    expect(oldestFirst[0].id).toBe(second.id);
    expect(oldestFirst.slice(1).every((r) => r.lastAccessedAt === undefined)).toBe(true);
  });

  it('defaults to a stable order when no sort is given', () => {
    const { manager } = seed();

    const a = manager.listRecordsForSession(SESSION).map((r) => r.id);
    const b = manager.listRecordsForSession(SESSION).map((r) => r.id);

    expect(a).toEqual(b);
  });
});
