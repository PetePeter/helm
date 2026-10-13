/**
 * Memory as a knowledge graph: small memories that link into something bigger.
 *
 * Covers ranked search, similar-memory suggestions on write, typed edges, and
 * cross-project reading (search + get across projects, writes still fenced).
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../src/session/memory-manager.js';
import { MemoryAttachmentManager } from '../src/session/memory-attachment-manager.js';
import { MEMORY_SEARCH_LIMIT } from '../src/types/memory.js';
import { ATOM_SOFT_LIMIT, HelmMemoryService } from '../src/mcp/services/helm-memory-service.js';

const ALPHA = 'project-alpha';
const BETA = 'project-beta';
const PRIVATE = 'project-private';

const A1 = 'session-alpha';
const B1 = 'session-beta';
const P1 = 'session-private';

function makeManager(shared = true) {
  const projects: Record<string, string> = { [A1]: ALPHA, [B1]: BETA, [P1]: PRIVATE };
  let sequence = 0;
  const manager = new MemoryManager({
    persist: () => {},
    now: () => 1000,
    idFactory: () => `m${++sequence}`,
    resolveSessionProject: (id) => projects[id] ?? null,
    ...(shared ? { isProjectShared: (projectId: string) => projectId !== PRIVATE } : {}),
  });
  return manager;
}

describe('ranked search', () => {
  it('ranks the memory about the query above one that merely mentions it', () => {
    const manager = makeManager();
    const passing = manager.createForSession(A1, { tldr: 'Build notes', content: 'uses vite once; mostly about esbuild and packaging' });
    const focused = manager.createForSession(A1, { tldr: 'Vite config', content: 'vite dev server, vite plugins' });

    const ids = manager.searchForSession(A1, 'vite').hits.map((hit) => hit.id);

    expect(ids).toEqual([focused.id, passing.id]);
  });

  it('matches any query term rather than the whole phrase', () => {
    const manager = makeManager();
    const memory = manager.createForSession(A1, { tldr: 'RS485 wiring', content: 'baud 9600' });

    expect(manager.searchForSession(A1, 'charger rs485 baud').hits.map((hit) => hit.id)).toEqual([memory.id]);
  });

  it('forgives a typo and a half-typed word', () => {
    const manager = makeManager();
    const memory = manager.createForSession(A1, { tldr: 'Mermaid rendering', content: 'diagram ids must be unique' });

    expect(manager.searchForSession(A1, 'mermad').hits.map((hit) => hit.id)).toEqual([memory.id]);
    expect(manager.searchForSession(A1, 'diagr').hits.map((hit) => hit.id)).toEqual([memory.id]);
  });

  it('still finds a substring inside a longer word', () => {
    const manager = makeManager();
    const memory = manager.createForSession(A1, { tldr: 'Release', content: 'run prepareDeploy first' });

    expect(manager.searchForSession(A1, 'deploy').hits.map((hit) => hit.id)).toEqual([memory.id]);
  });
});

describe('compact search', () => {
  function twelve(manager: MemoryManager) {
    // Repeating the term ranks them: the first created matches best.
    return Array.from({ length: 12 }, (_, index) => manager.createForSession(A1, {
      tldr: `Vite note ${index}`,
      content: `${'vite '.repeat(12 - index)}and a long body nobody asked for`,
    }));
  }

  it('answers with id and tldr only, never the content', () => {
    const manager = makeManager();
    const memory = manager.createForSession(A1, { tldr: 'Vite config', content: 'a long body nobody asked for' });

    const result = manager.searchForSession(A1, 'vite');

    expect(result.hits).toEqual([{ id: memory.id, tldr: 'Vite config', score: expect.any(Number), projectId: ALPHA, foreign: false }]);
    expect(JSON.stringify(result)).not.toContain('nobody asked for');
  });

  it('caps the hits at the limit, keeps the ranking, and says how many matched', () => {
    const manager = makeManager();
    const created = twelve(manager);

    const all = manager.searchForSession(A1, 'vite');
    const capped = manager.searchForSession(A1, 'vite', { limit: MEMORY_SEARCH_LIMIT });

    expect(all.hits.map((hit) => hit.id)).toEqual(created.map((memory) => memory.id));
    expect(capped.matched).toBe(12);
    expect(capped.hits).toEqual(all.hits.slice(0, 5));
  });

  it('keeps an own-project hit ahead of an equal foreign one inside the cap', () => {
    const manager = makeManager();
    manager.createForSession(B1, { tldr: 'Modbus timeout', content: 'modbus needs 200ms' });
    const own = manager.createForSession(A1, { tldr: 'Modbus timeout', content: 'modbus needs 200ms' });

    const result = manager.searchForSession(A1, 'modbus', { limit: 1 });

    expect(result.hits.map((hit) => hit.id)).toEqual([own.id]);
    expect(result.matched).toBe(2);
  });

  it('holds regex search to the same cap and shape', () => {
    const manager = makeManager();
    twelve(manager);

    const result = manager.searchForSession(A1, '^Vite note', { regex: true, limit: MEMORY_SEARCH_LIMIT });

    expect(result.matched).toBe(12);
    expect(result.hits).toHaveLength(5);
    expect(result.hits[0]).toEqual({ id: 'm1', tldr: 'Vite note 0', score: 1, projectId: ALPHA, foreign: false });
  });

  it('rejects a limit that is not a positive integer', () => {
    const manager = makeManager();

    expect(() => manager.searchForSession(A1, 'vite', { limit: 0 })).toThrow(/limit/i);
  });
});

describe('cross-project reading', () => {
  it('finds another project\'s memory, tagged with its project, below an equal own-project hit', () => {
    const manager = makeManager();
    const foreign = manager.createForSession(B1, { tldr: 'Modbus timeout', content: 'modbus needs 200ms' });
    const own = manager.createForSession(A1, { tldr: 'Modbus timeout', content: 'modbus needs 200ms' });

    const result = manager.searchForSession(A1, 'modbus');

    expect(result.hits.map((hit) => hit.id)).toEqual([own.id, foreign.id]);
    expect(result.hits.map((hit) => [hit.id, hit.projectId, hit.foreign])).toEqual([
      [own.id, ALPHA, false],
      [foreign.id, BETA, true],
    ]);
  });

  it('lets a search hit from another project be fetched', () => {
    const manager = makeManager();
    const foreign = manager.createForSession(B1, { tldr: 'Beta fact', content: 'body' });

    expect(manager.getRecordForSession(A1, foreign.id)?.content).toBe('body');
  });

  it('never exposes a private project, nor lists or edits another project', () => {
    const manager = makeManager();
    const hidden = manager.createForSession(P1, { tldr: 'secret modbus', content: 'x' });
    const foreign = manager.createForSession(B1, { tldr: 'beta modbus', content: 'x' });

    expect(manager.searchForSession(A1, 'modbus').hits.map((hit) => hit.id)).toEqual([foreign.id]);
    expect(manager.getRecordForSession(A1, hidden.id)).toBeNull();
    expect(manager.listRecordsForSession(A1)).toEqual([]);
    expect(manager.updateForSession(A1, foreign.id, { content: 'changed' })).toBeNull();
    expect(manager.deleteForSession(A1, foreign.id)).toBe(false);
  });

  it('keeps projects fenced when no sharing policy is wired', () => {
    const manager = makeManager(false);
    const foreign = manager.createForSession(B1, { tldr: 'beta modbus', content: 'x' });

    expect(manager.searchForSession(A1, 'modbus').hits).toEqual([]);
    expect(manager.getRecordForSession(A1, foreign.id)).toBeNull();
  });
});

describe('typed and cross-project links', () => {
  it('links an own memory to another project\'s memory, but not the reverse', () => {
    const manager = makeManager();
    const own = manager.createForSession(A1, { tldr: 'own', content: 'x' });
    const foreign = manager.createForSession(B1, { tldr: 'foreign', content: 'x' });

    expect(manager.linkForSession(A1, own.id, foreign.id, 'example-of')).toBe(true);
    expect(manager.linkForSession(A1, foreign.id, own.id)).toBe(false);
    expect(manager.listEdges()).toEqual([{ fromId: own.id, toId: foreign.id, type: 'example-of' }]);
  });

  it('retypes an existing edge instead of duplicating it', () => {
    const manager = makeManager();
    const a = manager.createForSession(A1, { tldr: 'a', content: 'x' });
    const b = manager.createForSession(A1, { tldr: 'b', content: 'x' });

    manager.linkForSession(A1, a.id, b.id, 'supports');
    manager.linkForSession(A1, a.id, b.id, 'contradicts');

    expect(manager.listEdges()).toEqual([{ fromId: a.id, toId: b.id, type: 'contradicts' }]);
  });

  it('rejects an unknown edge type', () => {
    const manager = makeManager();
    const a = manager.createForSession(A1, { tldr: 'a', content: 'x' });
    const b = manager.createForSession(A1, { tldr: 'b', content: 'x' });

    expect(() => manager.linkForSession(A1, a.id, b.id, 'likes' as never)).toThrow(/edge type/i);
  });

  it('pulls a linked foreign neighbour into a traversal', () => {
    const manager = makeManager();
    const own = manager.createForSession(A1, { tldr: 'charger wiring', content: 'x' });
    const foreign = manager.createForSession(B1, { tldr: 'unrelated words', content: 'y' });
    manager.linkForSession(A1, own.id, foreign.id);

    const traversal = manager.getForSession(A1, own.id, 1)!;

    expect(traversal.entries.map((entry) => [entry.id, entry.status])).toEqual([
      [own.id, 'record'],
      [foreign.id, 'record'],
    ]);
  });
});

describe('similar memories', () => {
  it('suggests the closest readable memories, excluding the new one and private projects', () => {
    const manager = makeManager();
    const close = manager.createForSession(B1, { tldr: 'Modbus RS485 timing', content: 'rs485 modbus 200ms' });
    manager.createForSession(P1, { tldr: 'Modbus RS485 secret', content: 'rs485 modbus' });
    manager.createForSession(A1, { tldr: 'Unrelated', content: 'gamepad dpad' });
    const fresh = manager.createForSession(A1, { tldr: 'RS485 bus', content: 'modbus over rs485' });

    const similar = manager.similarForSession(A1, fresh.id, 5);

    expect(similar.map((hit) => hit.id)).toEqual([close.id]);
  });

  it('leaves out memories the new one already links to', () => {
    const manager = makeManager();
    const linked = manager.createForSession(A1, { tldr: 'modbus', content: 'modbus' });
    const fresh = manager.createForSession(A1, { tldr: 'modbus again', content: 'modbus' });
    manager.linkForSession(A1, fresh.id, linked.id);

    expect(manager.similarForSession(A1, fresh.id, 5)).toEqual([]);
  });
});

describe('writing a memory over MCP', () => {
  it('returns the similar memories and flags an essay, but not an atom', () => {
    const manager = makeManager();
    const service = new HelmMemoryService(manager, new MemoryAttachmentManager(join(tmpdir(), 'helm-kg-unused'), join(tmpdir(), 'helm-kg-unused', 'temp')));
    const existing = manager.createForSession(A1, { tldr: 'modbus timing', content: 'modbus 200ms' });

    const atom = service.createLinkableMemory(A1, { tldr: 'modbus retries', content: 'modbus retries 3' });
    const essay = service.createLinkableMemory(A1, { tldr: 'notes', content: 'x'.repeat(ATOM_SOFT_LIMIT + 1) });

    expect(atom.similar.map((hit) => hit.id)).toEqual([existing.id]);
    expect(atom.atomHint).toBeUndefined();
    expect(essay.atomHint).toMatch(/split/);
  });
});
