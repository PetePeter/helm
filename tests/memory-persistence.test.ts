import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryPersistence } from '../src/session/memory-persistence.js';
import type { MemoryState } from '../src/types/memory.js';

const sample: MemoryState = {
  records: [{ id: 'm1', tldr: 'TL;DR', content: 'body', createdAt: 10, updatedAt: 11, attachments: [] }],
  edges: [],
};

describe('MemoryPersistence', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a versioned envelope and ignores unknown record fields', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-memory-persistence-'));
    const file = join(root, 'memories.json');
    const persistence = new MemoryPersistence(file);
    persistence.save(sample);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; records: Array<Record<string, unknown>> };
    expect(raw.version).toBe(2);
    raw.records[0].unknown = 'ignored';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(persistence.load().state).toEqual(sample);
  });

  it('keeps an edge type across a save and load, dropping an unknown one', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-memory-persistence-'));
    const file = join(root, 'memories.json');
    const persistence = new MemoryPersistence(file);
    const typed: MemoryState = {
      records: [...sample.records, { ...sample.records[0]!, id: 'm2' }, { ...sample.records[0]!, id: 'm3' }],
      edges: [{ fromId: 'm1', toId: 'm2', type: 'supports' }, { fromId: 'm1', toId: 'm3' }],
    };
    persistence.save(typed);
    expect(persistence.load().state?.edges).toEqual(typed.edges);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as { edges: Array<Record<string, unknown>> };
    raw.edges[0]!.type = 'from-the-future';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(persistence.load().state?.edges[0]).toEqual({ fromId: 'm1', toId: 'm2' });
  });

  it('preserves corrupt bytes on load and repairs only when explicitly requested', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-memory-persistence-'));
    const file = join(root, 'memories.json');
    const corrupt = '{not-json';
    writeFileSync(file, corrupt, 'utf8');
    const persistence = new MemoryPersistence(file);

    const loaded = persistence.load();
    expect(loaded.state).toEqual({ records: [], edges: [] });
    expect(loaded.diagnostic?.kind).toBe('corrupt');
    expect(readFileSync(file, 'utf8')).toBe(corrupt);

    const repaired = persistence.repair();
    expect(repaired.repaired).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 2, records: [], edges: [] });
    expect(existsSync(`${file}.invalid`)).toBe(true);
    expect(readFileSync(`${file}.invalid`, 'utf8')).toBe(corrupt);
    expect(persistence.repair().repaired).toBe(false);
  });

  it('loads the supported legacy records/links shape without overwriting it', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-memory-persistence-'));
    const file = join(root, 'memories.json');
    writeFileSync(file, JSON.stringify({ records: sample.records, links: sample.edges }), 'utf8');
    const persistence = new MemoryPersistence(file);

    expect(persistence.load().state).toEqual(sample);
    expect(readFileSync(file, 'utf8')).toContain('links');
  });

  it('leaves existing bytes unchanged when an injected atomic write fails', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-memory-persistence-'));
    const file = join(root, 'memories.json');
    const original = '{"version":1,"records":[],"edges":[]}';
    writeFileSync(file, original, 'utf8');
    const persistence = new MemoryPersistence(file, {
      atomicWrite: () => { throw new Error('disk full'); },
    });

    expect(() => persistence.save(sample)).toThrow('disk full');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
