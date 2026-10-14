import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './helpers/temp-root.js';
import { MemoryAttachmentManager } from '../src/session/memory-attachment-manager.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { MemoryPersistence } from '../src/session/memory-persistence.js';
import type { MemoryState } from '../src/types/memory.js';

describe('MemoryManager', () => {
  it('commits mutations only after persistence and emits one change event', () => {
    const persisted: MemoryState[] = [];
    const manager = new MemoryManager({
      persist: (state) => persisted.push(state),
      now: () => 100,
      idFactory: () => 'm1',
    });
    const events: unknown[] = [];
    manager.on('memory:changed', (event) => events.push(event));

    const created = manager.create({ tldr: 'hello', content: 'world' });
    expect(created).toMatchObject({ id: 'm1', createdAt: 100, updatedAt: 100 });
    expect(persisted).toHaveLength(1);
    expect(events).toHaveLength(1);

    created.tldr = 'caller mutation';
    expect(manager.getRecord('m1')?.tldr).toBe('hello');
  });

  it('rejects stale optimistic updates without changing state, disk, or events', () => {
    let persistCalls = 0;
    const manager = new MemoryManager({
      persist: () => { persistCalls += 1; },
      now: () => 100,
      idFactory: () => 'm1',
    });
    manager.create({ tldr: 'hello', content: 'world' });
    const events: unknown[] = [];
    manager.on('memory:changed', (event) => events.push(event));

    expect(() => manager.update('m1', { tldr: 'new' }, 99)).toThrow(/concurrent/i);
    expect(manager.getRecord('m1')?.tldr).toBe('hello');
    expect(persistCalls).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('deletes through one persistence/event boundary and reroutes graph edges', () => {
    const persisted: MemoryState[] = [];
    const manager = new MemoryManager({
      persist: (state) => persisted.push(state),
      idFactory: (() => { const ids = ['a', 'b', 'c']; return () => ids.shift()!; })(),
    });
    manager.create({ tldr: 'a', content: '' });
    manager.create({ tldr: 'b', content: '' });
    manager.create({ tldr: 'c', content: '' });
    manager.link('a', 'b');
    manager.link('b', 'c');
    const eventCount = persisted.length;

    manager.delete('b');

    expect(persisted).toHaveLength(eventCount + 1);
    expect(manager.getRecord('b')).toBeNull();
    expect(manager.exportState().edges).toEqual([{ fromId: 'a', toId: 'c' }]);
  });

  it('lists edges read-only — a copy, so callers cannot mutate the graph', () => {
    const manager = new MemoryManager({ idFactory: (() => { const ids = ['a', 'b']; return () => ids.shift()!; })() });
    manager.create({ tldr: 'a', content: '' });
    manager.create({ tldr: 'b', content: '' });
    manager.link('a', 'b');

    const edges = manager.listEdges();
    expect(edges).toEqual([{ fromId: 'a', toId: 'b' }]);
    edges[0]!.fromId = 'tampered';
    edges.pop();
    expect(manager.listEdges()).toEqual([{ fromId: 'a', toId: 'b' }]);
    expect(manager.exportState().edges).toEqual([{ fromId: 'a', toId: 'b' }]);
  });

  it('searches literal by default and rejects a broken regex', () => {
    const manager = new MemoryManager({ idFactory: (() => { const ids = ['a', 'b']; return () => ids.shift()!; })() });
    manager.create({ tldr: 'Alpha', content: 'plain' });
    manager.create({ tldr: 'Beta', content: 'Alpha body' });
    manager.link('a', 'b');

    expect(manager.search('Alpha').hits.map((hit) => hit.id)).toEqual(['a', 'b']);
    expect(() => manager.search('[', { regex: true })).toThrow(/regular expression/i);
  });

  it('keeps an owned edge to a foreign record as a missing graph marker', () => {
    const manager = new MemoryManager({ idFactory: (() => { const ids = ['owned', 'foreign']; return () => ids.shift()!; })() });
    manager.createForSession('s1', { tldr: 'owned', content: '' });
    manager.createForSession('s2', { tldr: 'foreign', content: '' });
    manager.link('owned', 'foreign');

    const traversal = manager.getForSession('s1', 'owned', 1)!;
    expect(traversal.entries.at(-1)).toMatchObject({ id: 'foreign', status: 'missing', via: { fromId: 'owned', toId: 'foreign' } });
    expect(traversal.entries.at(-1)?.record).toBeUndefined();
  });

  it('scopes session operations and never reroutes through another session', () => {
    const manager = new MemoryManager({
      idFactory: (() => { const ids = ['a', 'b', 'c']; return () => ids.shift()!; })(),
    });
    manager.createForSession('s1', { tldr: 'a', content: '' });
    manager.createForSession('s2', { tldr: 'b', content: '' });
    manager.createForSession('s1', { tldr: 'c', content: '' });

    expect(manager.getRecordForSession('s2', 'a')).toBeNull();
    expect(manager.updateForSession('s2', 'a', { tldr: 'nope' })).toBeNull();
    expect(manager.linkForSession('s1', 'a', 'b')).toBe(false);
    expect(manager.linkForSession('s1', 'a', 'c')).toBe(true);
    expect(manager.unlinkForSession('s2', 'a', 'c')).toBe(false);
    expect(manager.listRecordsForSession('s1').map((record) => record.id)).toEqual(['a', 'c']);
  });

  it('lets a read-all session (the operator) read every project but write only its own', () => {
    const projects: Record<string, string> = { op: 'p-operator', w: 'p-work' };
    const manager = new MemoryManager({
      idFactory: (() => { const ids = ['mine', 'theirs']; return () => ids.shift()!; })(),
      resolveSessionProject: (id) => projects[id] ?? null,
      canReadAll: (id) => id === 'op',
    });
    manager.createForSession('op', { tldr: 'operator note', content: '' });
    manager.createForSession('w', { tldr: 'work fact', content: 'the build uses vite' });

    expect(manager.getRecordForSession('op', 'theirs')?.tldr).toBe('work fact');
    expect(manager.searchForSession('op', 'vite').hits.map((hit) => hit.id)).toEqual(['theirs']);
    expect(manager.listRecordsForSession('op').map((r) => r.id).sort()).toEqual(['mine', 'theirs']);
    // Reading is not owning: another project's memory stays read-only.
    expect(manager.updateForSession('op', 'theirs', { tldr: 'nope' })).toBeNull();
    expect(manager.deleteForSession('op', 'theirs')).toBe(false);
    // Everyone else is still fenced to their own project.
    expect(manager.getRecordForSession('w', 'mine')).toBeNull();
  });

  it('purges only the owning session and its graph and attachment records', () => {
    const manager = new MemoryManager({
      idFactory: (() => { const ids = ['a', 'b']; return () => ids.shift()!; })(),
    });
    manager.createForSession('s1', { tldr: 'a', content: '' });
    manager.createForSession('s2', { tldr: 'b', content: '' });
    manager.link('a', 'b');

    expect(manager.purgeSession('s1')).toBe(1);
    expect(manager.getRecord('a')).toBeNull();
    expect(manager.getRecord('b')).not.toBeNull();
    expect(manager.exportState().edges).toEqual([]);
  });

  it('prunes only session memories whose owners are no longer recoverable', () => {
    const manager = new MemoryManager({
      idFactory: (() => { const ids = ['global', 'live', 'bin', 'orphan']; return () => ids.shift()!; })(),
    });
    manager.create({ tldr: 'global', content: '' });
    manager.createForSession('s-live', { tldr: 'live', content: '' });
    manager.createForSession('s-bin', { tldr: 'bin', content: '' });
    manager.createForSession('s-orphan', { tldr: 'orphan', content: '' });

    expect(manager.pruneOrphanedSessions(new Set(['s-live', 's-bin']))).toBe(1);
    expect(manager.getRecord('global')).not.toBeNull();
    expect(manager.getRecord('live')).not.toBeNull();
    expect(manager.getRecord('bin')).not.toBeNull();
    expect(manager.getRecord('orphan')).toBeNull();
  });

  it('does not create cross-session self-links when deleting a legacy cross-session edge', () => {
    const manager = new MemoryManager({
      idFactory: (() => { const ids = ['a', 'b']; return () => ids.shift()!; })(),
    });
    manager.createForSession('s1', { tldr: 'a', content: '' });
    manager.createForSession('s2', { tldr: 'b', content: '' });
    manager.link('b', 'a');
    manager.link('a', 'b');

    expect(manager.deleteForSession('s1', 'a')).toBe(true);
    expect(manager.exportState().edges).toEqual([]);
  });

  it('requires explicit repair before replacing a corrupt persisted store', () => {
    const root = makeTempRoot('helm-memory-manager-');
    try {
      const filePath = join(root, 'memories.json');
      writeFileSync(filePath, '{not json', 'utf8');
      const manager = new MemoryManager({ persistence: new MemoryPersistence(filePath) });

      expect(() => manager.create({ tldr: 'blocked', content: 'until repaired' })).toThrow(/repairPersistence/i);
      expect(readFileSync(filePath, 'utf8')).toBe('{not json');
      expect(manager.repairPersistence()).toMatchObject({ repaired: true });
      expect(() => manager.create({ tldr: 'ok', content: 'after repair' })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves memory state, attachment bytes, and events unchanged when cleanup fails', () => {
    const root = makeTempRoot('helm-memory-manager-');
    try {
      const attachments = new MemoryAttachmentManager(root, undefined, {
        deleteFile: () => { throw new Error('cleanup failed'); },
      });
      const manager = new MemoryManager({ attachmentManager: attachments });
      const events: unknown[] = [];
      manager.on('memory:changed', (event) => events.push(event));
      const memory = manager.create({ tldr: 'keep', content: 'body' });
      const attachment = manager.addAttachment(memory.id, {
        filename: 'data.bin',
        content: Buffer.from('bytes'),
      });
      const beforeEvents = events.length;
      const beforeState = manager.exportState();

      const temp = attachments.getToTempFile(attachment);
      expect(() => manager.deleteAttachment(memory.id, attachment.id)).toThrow('cleanup failed');
      expect(manager.exportState()).toEqual(beforeState);
      expect(manager.getRecord(memory.id)?.attachments).toEqual([attachment]);
      expect(attachments.get(memory.id, attachment.id)).toEqual(attachment);
      expect(readFileSync(temp.tempPath, 'utf8')).toBe('bytes');
      expect(events).toHaveLength(beforeEvents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores attachment metadata and bytes when memory persistence fails after cleanup', () => {
    const root = makeTempRoot('helm-memory-manager-');
    try {
      let failPersistence = false;
      const attachments = new MemoryAttachmentManager(join(root, 'attachments'), join(root, 'temp'));
      const manager = new MemoryManager({
        attachmentManager: attachments,
        persist: () => { if (failPersistence) throw new Error('memory disk full'); },
      });
      const memory = manager.create({ tldr: 'keep', content: 'body' });
      const attachment = manager.addAttachment(memory.id, {
        filename: 'data.bin',
        content: Buffer.from('bytes'),
      });
      const beforeState = manager.exportState();
      const before = attachments.getToTempFile(attachment);
      failPersistence = true;

      expect(() => manager.deleteAttachment(memory.id, attachment.id)).toThrow('memory disk full');
      expect(manager.exportState()).toEqual(beforeState);
      expect(attachments.get(memory.id, attachment.id)).toEqual(attachment);
      expect(existsSync(before.tempPath)).toBe(true);
      expect(readFileSync(before.tempPath, 'utf8')).toBe('bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MemoryManager session-bound memories', () => {
  /** s1 and s2 share project p-a, x sits in p-b, op is the read-all operator. */
  function boundFixture(extra: { persistence?: MemoryPersistence } = {}) {
    const projects: Record<string, string> = { s1: 'p-a', s2: 'p-a', x: 'p-b', op: 'p-op' };
    const ids = ['bound', 'plain', 'other'];
    let extraIds = 0;
    const manager = new MemoryManager({
      ...extra,
      idFactory: () => ids.shift() ?? `extra-${extraIds++}`,
      resolveSessionProject: (id) => projects[id] ?? null,
      canReadAll: (id) => id === 'op',
      isProjectShared: () => true,
    });
    manager.createForSession('s1', { tldr: 'vite builds the renderer', content: 'esbuild builds main', sessionBound: true });
    manager.createForSession('s1', { tldr: 'vite config lives in root', content: 'renderer config' });
    return manager;
  }

  const rootIds = (manager: MemoryManager, sessionId: string, query: string) =>
    manager.searchForSession(sessionId, query).hits.map((hit) => hit.id).sort();

  it('returns a bound memory to its own session on every read path', () => {
    const manager = boundFixture();

    expect(manager.getRecordForSession('s1', 'bound')).toMatchObject({ sessionBound: true, projectId: 'p-a' });
    expect(rootIds(manager, 's1', 'vite')).toEqual(['bound', 'plain']);
    expect(manager.similarForSession('s1', 'plain', 5).map((hit) => hit.id)).toEqual(['bound']);
    expect(manager.listRecordsForSession('s1').map((record) => record.id)).toEqual(['bound', 'plain']);
    expect(manager.forestForSession('s1').records.find((record) => record.id === 'bound')?.sessionBound).toBe(true);
    expect(manager.updateForSession('s1', 'bound', { tldr: 'vite builds the renderer bundle' })).not.toBeNull();
  });

  it('hides a bound memory from every other session — same project, another project, the operator', () => {
    const manager = boundFixture();

    for (const sessionId of ['s2', 'x', 'op']) {
      expect(manager.getRecordForSession(sessionId, 'bound')).toBeNull();
      expect(manager.getForSession(sessionId, 'bound')).toBeNull();
      expect(rootIds(manager, sessionId, 'vite')).toEqual(['plain']);
      expect(manager.listRecordsForSession(sessionId).map((record) => record.id)).not.toContain('bound');
      expect(manager.forestForSession(sessionId).records.map((record) => record.id)).not.toContain('bound');
      // Not even as a ranking seed: its text must not shape another session's results.
      expect(manager.similarForSession(sessionId, 'bound', 5)).toEqual([]);
    }
    expect(manager.similarForSession('s2', 'plain', 5)).toEqual([]);
    // Hidden means untouchable, not merely unlisted.
    expect(manager.updateForSession('s2', 'bound', { tldr: 'nope' })).toBeNull();
    expect(manager.deleteForSession('s2', 'bound')).toBe(false);
    expect(manager.setDormantForSession('s2', 'bound', true)).toBe(false);
    expect(manager.linkForSession('s2', 'plain', 'bound')).toBe(false);
    expect(manager.getRecord('bound')?.tldr).toBe('vite builds the renderer');
  });

  it('never discloses a bound memory through an edge from a memory others can see', () => {
    const manager = boundFixture();
    expect(manager.linkForSession('s1', 'plain', 'bound', 'supports')).toBe(true);
    const reached = (sessionId: string) =>
      manager.getForSession(sessionId, 'plain', 2)!.entries.map((entry) => entry.id);

    expect(reached('s1')).toContain('bound');
    for (const sessionId of ['s2', 'x', 'op']) expect(reached(sessionId)).not.toContain('bound');
    expect(manager.forestForSession('s2').edges).toEqual([]);
    // s2 owns the source, but cutting the edge would confirm the hidden target.
    expect(manager.unlinkForSession('s2', 'plain', 'bound')).toBe(false);
    expect(manager.exportState().edges).toEqual([{ fromId: 'plain', toId: 'bound', type: 'supports' }]);
    expect(manager.unlinkForSession('s1', 'plain', 'bound')).toBe(true);
  });

  it('keeps a bound memory out of project-wide candidates and the dream review set', () => {
    const manager = boundFixture();
    // Three changes of writing session carry both records past the grace period.
    manager.createForSession('s2', { tldr: 'epoch one', content: '' });
    manager.createForSession('s1', { tldr: 'epoch two', content: '' });
    manager.createForSession('s2', { tldr: 'epoch three', content: '' });

    expect(manager.listProjectRecords('p-a').map((record) => record.id)).not.toContain('bound');
    expect(manager.isDiscardEligible('plain')).toBe(true);
    const dream = manager.dreamForSession('s1');
    expect([...dream.faded, ...dream.salient].map((candidate) => candidate.id)).toEqual(['plain']);
  });

  it('turns a bound memory into ordinary project memory when its binding is released', () => {
    const manager = boundFixture();
    const events: unknown[] = [];
    manager.on('memory:changed', (event) => events.push(event));
    const before = manager.getRecord('bound')!.updatedAt;

    expect(manager.releaseBinding('missing')).toBe(false);
    expect(manager.releaseBinding('bound')).toBe(true);

    expect(events).toEqual([{ type: 'release', id: 'bound', sessionId: 's1' }]);
    expect(manager.getRecord('bound')).not.toHaveProperty('sessionBound');
    // Promotion is not authoring: it must not make the memory look freshly written.
    expect(manager.getRecord('bound')!.updatedAt).toBe(before);
    expect(rootIds(manager, 's2', 'vite')).toEqual(['bound', 'plain']);
    expect(rootIds(manager, 'x', 'vite')).toEqual(['bound', 'plain']);
    expect(manager.listProjectRecords('p-a').map((record) => record.id)).toEqual(['bound', 'plain']);
  });

  it('keeps a project session\'s bound memories for the next dream when the session goes', () => {
    const manager = boundFixture();
    // No project means no dream will ever digest it, so it goes with its session.
    manager.createForSession('loner', { tldr: 'no project', content: '', sessionBound: true });

    expect(manager.purgeSession('s1')).toBe(0);
    expect(manager.pruneOrphanedSessions(new Set())).toBe(1);
    expect(manager.getRecord('bound')?.sessionBound).toBe(true);
    expect(manager.getRecord('other')).toBeNull();
  });

  it('refuses a binding with no session to bind to', () => {
    const manager = new MemoryManager();
    expect(() => manager.create({ tldr: 'x', content: '', sessionBound: true })).toThrow(/session/i);
  });

  it('round-trips the binding through disk and loads an older store unbound', () => {
    const root = makeTempRoot('helm-memory-bound-');
    try {
      const filePath = join(root, 'memories.json');
      boundFixture({ persistence: new MemoryPersistence(filePath) });

      const reloaded = new MemoryManager({ persistence: new MemoryPersistence(filePath) });
      expect(reloaded.getRecord('bound')?.sessionBound).toBe(true);
      expect(reloaded.getRecord('plain')).not.toHaveProperty('sessionBound');

      // A store written before the field existed: no record carries it.
      const stored = JSON.parse(readFileSync(filePath, 'utf8'));
      for (const record of stored.records) delete record.sessionBound;
      writeFileSync(filePath, JSON.stringify(stored), 'utf8');
      const legacy = new MemoryManager({ persistence: new MemoryPersistence(filePath) });
      expect(legacy.listRecords().some((record) => record.sessionBound)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists a session\'s own bound memories and nobody else\'s', () => {
    const manager = boundFixture();
    manager.createForSession('s2', { tldr: 's2 finding', content: '', sessionBound: true });

    expect(manager.listBoundForSession('s1').map((record) => record.id)).toEqual(['bound']);
    expect(manager.listBoundForSession('s2').map((record) => record.id)).toEqual(['other']);
    expect(manager.listBoundForSession('x')).toEqual([]);
  });

  it('keeps an auto-saved memory\'s source turn across a restart, moves it on update, drops it on release', () => {
    const root = makeTempRoot('helm-memory-turn-');
    try {
      const filePath = join(root, 'memories.json');
      const manager = new MemoryManager({ persistence: new MemoryPersistence(filePath), idFactory: () => 'auto' });
      manager.createForSession('s1', { tldr: 'vite runs on 5173', content: '', sessionBound: true, sourceTurn: 'turn-1' });

      const reloaded = new MemoryManager({ persistence: new MemoryPersistence(filePath) });
      expect(reloaded.listBoundForSession('s1')[0].sourceTurn).toBe('turn-1');

      reloaded.updateForSession('s1', 'auto', { tldr: 'vite runs on 5173, preview on 4173', sourceTurn: 'turn-2' });
      expect(reloaded.getRecord('auto')).toMatchObject({ sourceTurn: 'turn-2', sessionBound: true });

      // Once it is project memory the turn means nothing: no later update may bring it back.
      reloaded.releaseBinding('auto');
      reloaded.update('auto', { sourceTurn: 'turn-3' });
      expect(new MemoryManager({ persistence: new MemoryPersistence(filePath) }).getRecord('auto')).not.toHaveProperty('sourceTurn');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a source turn on a memory that is not session-bound', () => {
    const manager = boundFixture();
    expect(() => manager.createForSession('s1', { tldr: 'x', content: '', sourceTurn: 'turn-1' })).toThrow(/session-bound/i);
  });
});
