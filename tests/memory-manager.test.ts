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

  it('searches literal by default and returns graph expansion per matching root', () => {
    const manager = new MemoryManager({ idFactory: (() => { const ids = ['a', 'b']; return () => ids.shift()!; })() });
    manager.create({ tldr: 'Alpha', content: 'plain' });
    manager.create({ tldr: 'Beta', content: 'Alpha body' });
    manager.link('a', 'b');

    const result = manager.search('Alpha', { graphDepth: 1 });
    expect(result.results.map((item) => item.rootId)).toEqual(['a', 'b']);
    expect(result.results[0].entries.map((entry) => entry.id)).toEqual(['a', 'b']);
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
