/**
 * Phase 1 of Project Memory: memories outlive the session that wrote them.
 *
 * The whole point is that knowledge about a project should not die with the
 * terminal that learned it. Everything here defends one of the two failure
 * modes: knowledge leaking across projects, or a scheduled cleanup deleting
 * what the last session just learned.
 */

import { describe, expect, it } from 'vitest';
import { GRACE_EPOCHS, MemoryManager } from '../src/session/memory-manager.js';

const PROJECT = 'project-alpha';
const OTHER_PROJECT = 'project-beta';

const AUTHOR = 'session-author';
const LATER = 'session-later';
const OUTSIDER = 'session-outsider';
const UNSCOPED = 'session-no-project';

/**
 * A manager wired to a fixed session→project map, so scope is decided by the
 * same resolver the real app injects rather than by test-only plumbing.
 */
function makeManager(overrides: Record<string, string | null> = {}) {
  const projects: Record<string, string | null> = {
    [AUTHOR]: PROJECT,
    [LATER]: PROJECT,
    [OUTSIDER]: OTHER_PROJECT,
    [UNSCOPED]: null,
    ...overrides,
  };
  let clock = 1000;
  let sequence = 0;
  const manager = new MemoryManager({
    persist: () => {},
    now: () => clock,
    idFactory: () => `m${++sequence}`,
    resolveSessionProject: (id) => projects[id] ?? null,
    resolveSessionPlan: (id) => (id === AUTHOR ? 'plan-1' : null),
  });
  return { manager, tick: (to: number) => { clock = to; } };
}

describe('scope and lifetime', () => {
  it('keeps project memories through a session purge and still drops unscoped ones', () => {
    const { manager } = makeManager();
    const scoped = manager.createForSession(AUTHOR, { tldr: 'project fact', content: 'body' });
    const unscoped = manager.createForSession(UNSCOPED, { tldr: 'session fact', content: 'body' });

    manager.purgeSession(AUTHOR);
    manager.purgeSession(UNSCOPED);

    const surviving = manager.listRecords().map((r) => r.id);
    expect(surviving).toContain(scoped.id);
    expect(surviving).not.toContain(unscoped.id);
  });

  it('lets a later session in the same project read what a dead session wrote', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(AUTHOR, { tldr: 'project fact', content: 'body' });
    manager.purgeSession(AUTHOR);

    expect(manager.getRecordForSession(LATER, written.id)?.content).toBe('body');
    expect(manager.listRecordsForSession(LATER).map((r) => r.id)).toEqual([written.id]);
  });

  it('hides a project memory from a session in a different project', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(AUTHOR, { tldr: 'project fact', content: 'body' });

    expect(manager.getRecordForSession(OUTSIDER, written.id)).toBeNull();
    expect(manager.listRecordsForSession(OUTSIDER)).toEqual([]);
    expect(manager.searchForSession(OUTSIDER, 'project').hits).toEqual([]);
  });

  // Regression guard for every session that predates projects: without a
  // project the store must behave exactly as it did before this feature.
  it('leaves a project-less session with the old session-private behaviour', () => {
    const { manager } = makeManager();
    const mine = manager.createForSession(UNSCOPED, { tldr: 'mine', content: 'body' });
    manager.createForSession(AUTHOR, { tldr: 'theirs', content: 'body' });

    expect(manager.listRecordsForSession(UNSCOPED).map((r) => r.id)).toEqual([mine.id]);
  });

  it('purges one project without touching another', () => {
    const { manager } = makeManager();
    const alpha = manager.createForSession(AUTHOR, { tldr: 'alpha', content: 'body' });
    const beta = manager.createForSession(OUTSIDER, { tldr: 'beta', content: 'body' });

    expect(manager.purgeProject(PROJECT)).toBe(1);

    const surviving = manager.listRecords().map((r) => r.id);
    expect(surviving).toEqual([beta.id]);
    expect(surviving).not.toContain(alpha.id);
  });

  it('keeps edges between project memories alive across a session purge', () => {
    const { manager } = makeManager();
    const from = manager.createForSession(AUTHOR, { tldr: 'from', content: 'body' });
    const to = manager.createForSession(AUTHOR, { tldr: 'to', content: 'body' });
    manager.linkForSession(AUTHOR, from.id, to.id);

    manager.purgeSession(AUTHOR);

    expect(manager.forestForSession(LATER).edges).toEqual([{ fromId: from.id, toId: to.id }]);
  });

  // Ownership must stay derived. If a caller could name the project, one
  // session could write knowledge into another team's project.
  it('resolves projectId and planId from the session, never from caller input', () => {
    const { manager } = makeManager();
    const created = manager.createForSession(
      AUTHOR,
      { tldr: 'a', content: 'b', projectId: OTHER_PROJECT, planId: 'forged' } as never,
    );

    expect(created.projectId).toBe(PROJECT);
    expect(created.planId).toBe('plan-1');
  });
});

describe('recall breadth', () => {
  it('counts a session once however many times it reads', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(AUTHOR, { tldr: 'a', content: 'b' });

    manager.getRecordForSession(LATER, written.id);
    manager.getRecordForSession(LATER, written.id);

    expect(manager.getRecord(written.id)!.recallSessionCount).toBe(1);
  });

  it('counts each distinct reading session', () => {
    const { manager } = makeManager({ 'session-third': PROJECT });
    const written = manager.createForSession(AUTHOR, { tldr: 'a', content: 'b' });

    manager.getRecordForSession(LATER, written.id);
    manager.getRecordForSession('session-third', written.id);

    expect(manager.getRecord(written.id)!.recallSessionCount).toBe(2);
  });

  // The author already holds the fact in context; re-reading it is not
  // evidence that anyone else found it worth retrieving.
  it('does not count the writing session reading its own memory', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(AUTHOR, { tldr: 'a', content: 'b' });

    manager.getRecordForSession(AUTHOR, written.id);

    expect(manager.getRecord(written.id)!.recallSessionCount ?? 0).toBe(0);
  });
});

describe('epochs and the grace period', () => {
  it('advances the epoch on a different session, not on every call', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(AUTHOR, { tldr: 'a', content: 'b' });
    expect(manager.projectEpoch(PROJECT)).toBe(0);

    manager.createForSession(AUTHOR, { tldr: 'again', content: 'b' });
    expect(manager.projectEpoch(PROJECT)).toBe(0);

    manager.getRecordForSession(LATER, written.id);
    expect(manager.projectEpoch(PROJECT)).toBe(1);

    manager.getRecordForSession(LATER, written.id);
    expect(manager.projectEpoch(PROJECT)).toBe(1);
  });

  // Load-bearing (plan §7 item 12). Without this a scheduled dream would find
  // every memory the last session wrote sitting at zero recalls and zero links,
  // arithmetically indistinguishable from stale junk, and delete it.
  it('never treats a memory created this epoch as discardable', () => {
    const { manager } = makeManager();
    const fresh = manager.createForSession(AUTHOR, { tldr: 'brand new', content: 'b' });

    expect(manager.isDiscardEligible(fresh.id)).toBe(false);
  });

  it('becomes discardable only after the grace epochs have elapsed', () => {
    const readers = Object.fromEntries(
      Array.from({ length: GRACE_EPOCHS }, (_, i) => [`reader-${i + 1}`, PROJECT]),
    );
    const { manager } = makeManager(readers);
    const written = manager.createForSession(AUTHOR, { tldr: 'a', content: 'b' });

    for (let epoch = 1; epoch <= GRACE_EPOCHS; epoch += 1) {
      expect(manager.isDiscardEligible(written.id)).toBe(epoch > GRACE_EPOCHS);
      manager.getRecordForSession(`reader-${epoch}`, written.id);
    }

    expect(manager.projectEpoch(PROJECT)).toBe(GRACE_EPOCHS);
    expect(manager.isDiscardEligible(written.id)).toBe(true);
  });

  it('never treats an unscoped memory as discardable', () => {
    const { manager } = makeManager();
    const written = manager.createForSession(UNSCOPED, { tldr: 'a', content: 'b' });

    expect(manager.isDiscardEligible(written.id)).toBe(false);
  });
});

describe('dormancy', () => {
  function seedDormant() {
    const context = makeManager({ 'reader-1': PROJECT, 'reader-2': PROJECT, 'reader-3': PROJECT });
    const { manager } = context;
    const dormant = manager.createForSession(AUTHOR, { tldr: 'faded needle', content: 'body' });
    const active = manager.createForSession(AUTHOR, { tldr: 'live needle', content: 'body' });
    manager.setDormant(dormant.id, true);
    return { ...context, dormant, active };
  }

  it('hides dormant memories from list, search and forest unless asked for', () => {
    const { manager, dormant, active } = seedDormant();

    expect(manager.listRecordsForSession(LATER).map((r) => r.id)).toEqual([active.id]);
    expect(manager.searchForSession(LATER, 'needle').hits.map((hit) => hit.id)).toEqual([active.id]);
    expect(manager.forestForSession(LATER).records.map((r) => r.id)).toEqual([active.id]);

    const all = manager.listRecordsForSession(LATER, { includeDormant: true }).map((r) => r.id);
    expect(all).toContain(dormant.id);
    expect(manager.forestForSession(LATER, { includeDormant: true }).records).toHaveLength(2);
  });

  // Forgetting is not editing. If it advanced updatedAt, every dream pass would
  // make the memories it hid look like the freshest things in the store.
  it('does not touch updatedAt or attachments when marking dormant', () => {
    const { manager, dormant } = seedDormant();
    const record = manager.getRecord(dormant.id)!;

    expect(record.updatedAt).toBe(record.createdAt);
    expect(record.attachments).toEqual([]);
    expect(record.dormantSince).toBe(1000);
  });

  it('wakes a dormant memory that is read again', () => {
    const { manager, dormant } = seedDormant();

    expect(manager.getRecordForSession(LATER, dormant.id, { includeDormant: true })?.id).toBe(dormant.id);

    expect(manager.getRecord(dormant.id)!.dormantSince).toBeUndefined();
    expect(manager.listRecordsForSession(LATER).map((r) => r.id)).toContain(dormant.id);
  });
});
