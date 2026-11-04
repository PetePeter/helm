import { describe, expect, it } from 'vitest';
import { GRACE_EPOCHS, MemoryManager } from '../src/session/memory-manager.js';
import type { DreamCandidate } from '../src/types/memory.js';

const PROJECT = 'project-alpha';
const AUTHOR = 'session-author';

function makeManager() {
  const projects: Record<string, string | null> = {
    [AUTHOR]: PROJECT,
    reader1: PROJECT,
    reader2: PROJECT,
    reader3: PROJECT,
    outsider: 'project-beta',
  };
  let clock = 1000;
  let sequence = 0;
  const manager = new MemoryManager({
    persist: () => {},
    now: () => clock,
    idFactory: () => `m${++sequence}`,
    resolveSessionProject: (sessionId) => projects[sessionId] ?? null,
    resolveSessionPlan: (sessionId) => sessionId === AUTHOR ? 'plan-1' : null,
  });
  return { manager, tick: (value: number) => { clock = value; } };
}

function candidateIds(candidates: DreamCandidate[]): string[] {
  return candidates.map((candidate) => candidate.id);
}

describe('memory dreaming', () => {
  it('returns bounded, disjoint faded and salient project candidates', () => {
    const { manager } = makeManager();
    const records = Array.from({ length: 8 }, (_, index) => manager.createForSession(AUTHOR, {
      tldr: `memory ${index}`,
      content: 'body',
    }));

    manager.getRecordForSession('reader1', records[0].id);
    manager.getRecordForSession('reader2', records[1].id);
    manager.getRecordForSession('reader3', records[2].id);

    const dream = manager.dreamForSession(AUTHOR);
    const faded = candidateIds(dream.faded);
    const salient = candidateIds(dream.salient);

    expect(new Set([...faded, ...salient]).size).toBe(faded.length + salient.length);
    expect(faded.length + salient.length).toBeGreaterThanOrEqual(5);
    expect(faded.length + salient.length).toBeLessThanOrEqual(50);
    expect(dream.totals).toMatchObject({ memories: 8, dormant: 0, eligible: 8, epoch: GRACE_EPOCHS });
    expect(dream.faded.every((candidate) => candidate.recallSessionCount === 0)).toBe(true);
    expect(dream.salient[0].recallSessionCount).toBeGreaterThanOrEqual(dream.faded.at(-1)!.recallSessionCount);
  });

  it('returns both deciles at their independent bound and keeps a singleton faded', () => {
    const { manager } = makeManager();
    const records = Array.from({ length: 100 }, (_, index) => manager.createForSession(AUTHOR, {
      tldr: `memory ${index}`,
      content: 'body',
    }));
    manager.getRecordForSession('reader1', records[0].id);
    manager.getRecordForSession('reader2', records[1].id);
    manager.getRecordForSession('reader3', records[2].id);

    const dream = manager.dreamForSession(AUTHOR, { percentile: 100, minCandidates: 5, maxCandidates: 50 });
    expect(dream.faded).toHaveLength(50);
    expect(dream.salient).toHaveLength(50);

    const singletonManager = makeManager().manager;
    const singleton = singletonManager.createForSession(AUTHOR, { tldr: 'only', content: 'body' });
    singletonManager.getRecordForSession('reader1', singleton.id);
    singletonManager.getRecordForSession('reader2', singleton.id);
    singletonManager.getRecordForSession('reader3', singleton.id);
    const singletonDream = singletonManager.dreamForSession(AUTHOR);
    expect(candidateIds(singletonDream.faded)).toEqual([singleton.id]);
    expect(singletonDream.salient).toEqual([]);
  });

  it('rejects contradictory candidate bounds', () => {
    const { manager } = makeManager();
    expect(() => manager.dreamForSession(AUTHOR, { minCandidates: 10, maxCandidates: 5 }))
      .toThrow('minCandidates must not exceed maxCandidates');
  });

  it('enforces the floor and cap without reading outside the current project', () => {
    const { manager } = makeManager();
    const records = Array.from({ length: 8 }, (_, index) => manager.createForSession(AUTHOR, {
      tldr: `memory ${index}`,
      content: 'body',
    }));
    manager.createForSession('outsider', { tldr: 'foreign', content: 'body' });
    manager.getRecordForSession('reader1', records[0].id);
    manager.getRecordForSession('reader2', records[1].id);
    manager.getRecordForSession('reader3', records[2].id);

    const dream = manager.dreamForSession(AUTHOR, { percentile: 100, minCandidates: 5, maxCandidates: 50 });

    expect(dream.faded.length + dream.salient.length).toBe(8);
    expect(dream.totals.memories).toBe(8);
    expect(dream.faded.every((candidate) => candidate.id.startsWith('m'))).toBe(true);
  });

  it('excludes ineligible and dormant records, and derives connectedCount from live edges', () => {
    const { manager } = makeManager();
    const records = Array.from({ length: 3 }, (_, index) => manager.createForSession(AUTHOR, {
      tldr: `memory ${index}`,
      content: 'body',
    }));
    manager.getRecordForSession('reader1', records[0].id);
    manager.getRecordForSession('reader2', records[0].id);
    manager.getRecordForSession('reader3', records[0].id);
    manager.linkForSession(AUTHOR, records[1].id, records[0].id);
    manager.linkForSession(AUTHOR, records[2].id, records[0].id);
    const foreign = manager.createForSession('outsider', { tldr: 'foreign', content: 'body' });
    manager.link(foreign.id, records[0].id);
    manager.setDormantForSession(AUTHOR, records[2].id, true);
    const fresh = manager.createForSession(AUTHOR, { tldr: 'fresh', content: 'body' });

    const before = manager.dreamForSession(AUTHOR, { percentile: 100 });
    expect(before.totals).toMatchObject({ memories: 4, dormant: 1, eligible: 2 });
    expect(candidateIds([...before.faded, ...before.salient])).not.toContain(records[2].id);
    expect(candidateIds([...before.faded, ...before.salient])).not.toContain(fresh.id);
    expect([...before.faded, ...before.salient].find((candidate) => candidate.id === records[0].id)?.connectedCount).toBe(2);

    manager.unlinkForSession(AUTHOR, records[2].id, records[0].id);
    const after = manager.dreamForSession(AUTHOR, { percentile: 100 });
    expect([...after.faded, ...after.salient].find((candidate) => candidate.id === records[0].id)?.connectedCount).toBe(1);
  });

  it('returns plan metadata when the stamped plan still exists and null after deletion', () => {
    const { manager } = makeManager();
    const record = manager.createForSession(AUTHOR, { tldr: 'planned', content: 'body' });
    manager.getRecordForSession('reader1', record.id);
    manager.getRecordForSession('reader2', record.id);
    manager.getRecordForSession('reader3', record.id);
    const plan = { id: 'plan-1', title: 'Remember this', state: 'coding' as const, completed: false };

    const withPlan = manager.dreamForSession(AUTHOR, { percentile: 100 }, (id) => id === 'plan-1' ? plan : null);
    expect([...withPlan.faded, ...withPlan.salient][0].plan).toEqual(plan);

    const withoutPlan = manager.dreamForSession(AUTHOR, { percentile: 100 }, () => null);
    expect([...withoutPlan.faded, ...withoutPlan.salient][0].plan).toBeNull();
  });

  it('counts ideas in project totals but excludes them from faded and salient candidates', () => {
    const { manager } = makeManager();
    const ordinary = manager.createForSession(AUTHOR, { tldr: 'ordinary finding', content: 'body' });
    const idea = manager.createForSession(AUTHOR, { kind: 'idea', tldr: 'unexplained observation', content: 'evidence' });
    manager.getRecordForSession('reader1', ordinary.id);
    manager.getRecordForSession('reader2', ordinary.id);
    manager.getRecordForSession('reader3', ordinary.id);

    const dream = manager.dreamForSession(AUTHOR, { percentile: 100 });

    expect(dream.totals.memories).toBe(2);
    expect(dream.totals.eligible).toBe(1);
    expect(candidateIds([...dream.faded, ...dream.salient])).toEqual([ordinary.id]);
    expect(candidateIds([...dream.faded, ...dream.salient])).not.toContain(idea.id);
  });
});
