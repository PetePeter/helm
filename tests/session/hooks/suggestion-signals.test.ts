/**
 * BoostedSuggestionScorer — G5 ranking signals behind the G4 scorer interface.
 *
 * Binding decisions under test (plan P-0786 + orchestrator review 2026-09-20):
 * - THE THRESHOLD IS BM25'S JOB. Every signal — adjacency, scope, recency,
 *   usage — REORDERS PASSERS ONLY. Nothing crosses MIN_SCORE except on base
 *   score. A suggestion→fetch→weight→suggestion loop must never be able to
 *   promote an irrelevant item over the line; see docs/cli-hooks.md, G5.
 * - Adjacency evidence: memory_graph edges to a passer, plus workspace
 *   membership (a memory whose plan is the session's claimed plan, a sequence
 *   sibling, or shares a bound context node). Bounded per anchor and overall.
 * - Weights are configuration: an override must visibly change the ordering.
 * - With every signal at zero the output equals bare BM25 exactly — that is
 *   the fresh-install guarantee.
 *
 * Base scores come from a fixed fake so the threshold rules are tested
 * exactly; real-BM25 tests cover ordering stability and the whole-layer
 * regression (real store + real scorer, wired like production).
 */

import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Bm25SuggestionScorer,
  BoostedSuggestionScorer,
  SuggestionService,
  type SuggestionCandidate,
  type SuggestionScorer,
  type SuggestionSignalDeps,
} from '../../../src/session/hooks/suggestion-scorer';
import { SuggestionUsageStore, usageTerms } from '../../../src/session/hooks/suggestion-usage-store';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../src/utils/logger.js';

const MIN_SCORE = 3.5;
const now = Date.parse('2026-09-20T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A fake base scorer handing out exact base scores by candidate id. */
function fixedBase(scores: Record<string, number>): SuggestionScorer {
  return {
    async score(_prompt, candidates) {
      return candidates
        .map((candidate) => ({
          type: candidate.type,
          id: candidate.id,
          name: candidate.name,
          score: scores[candidate.id] ?? 0,
        }))
        .filter((item) => item.score >= MIN_SCORE);
    },
  };
}

function skill(id: string, extra: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return { type: 'skill', id, name: `Skill ${id}`, description: `A skill called ${id}.`, ...extra };
}

function memory(id: string, extra: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return { type: 'memory', id, name: `Memory ${id}`, description: `A memory about ${id}.`, ...extra };
}

/** Empty signals — the fresh-install shape. */
function emptyDeps(): SuggestionSignalDeps {
  return {
    getMemoryEdges: () => [],
    getWorkspacePlanIds: () => new Set<string>(),
    usageBoost: () => 0,
  };
}

describe('BoostedSuggestionScorer — adjacency', () => {
  const anchor = memory('anchor-a');
  const linked = memory('linked-b');
  const unlinked = memory('unlinked-c');

  it('a memory linked to a passer outranks an equal unlinked one', async () => {
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'anchor-a': 4.2, 'linked-b': 3.6, 'unlinked-c': 3.6 }),
      { ...emptyDeps(), getMemoryEdges: () => [{ fromId: 'anchor-a', toId: 'linked-b' }] },
    );
    const ranked = await scorer.score('anything', [anchor, linked, unlinked]);
    // The edge is symmetric, so the anchor is boosted too — but the LINKED
    // memory outranks its unlinked equal, which is the claim under test.
    const at = (id: string) => ranked.find((item) => item.id === id)!.score;
    expect(at('linked-b')).toBeCloseTo(3.6 + 1.0, 5);
    expect(at('unlinked-c')).toBeCloseTo(3.6, 5);
    expect(ranked.findIndex((item) => item.id === 'linked-b'))
      .toBeLessThan(ranked.findIndex((item) => item.id === 'unlinked-c'));
  });

  it('edges count in both directions — linked FROM a passer is boosted too', async () => {
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'anchor-a': 4.2, 'linked-b': 3.6, 'unlinked-c': 3.6 }),
      { ...emptyDeps(), getMemoryEdges: () => [{ fromId: 'linked-b', toId: 'anchor-a' }] },
    );
    const ranked = await scorer.score('anything', [anchor, linked, unlinked]);
    expect(ranked.find((item) => item.id === 'linked-b')?.score).toBeCloseTo(3.6 + 1.0, 5);
    expect(ranked.findIndex((item) => item.id === 'linked-b'))
      .toBeLessThan(ranked.findIndex((item) => item.id === 'unlinked-c'));
  });

  it('adjacency is capped: five anchors give the cap, not five times the boost', async () => {
    const anchors = [1, 2, 3, 4, 5].map((i) => memory(`anchor-${i}`));
    const edges = [1, 2, 3, 4, 5].map((i) => ({ fromId: `anchor-${i}`, toId: 'linked-b' }));
    const scores = Object.fromEntries([
      ...[1, 2, 3, 4, 5].map((i) => [`anchor-${i}`, 5.0]),
      ['linked-b', 3.6],
    ]);
    const scorer = new BoostedSuggestionScorer(fixedBase(scores), { ...emptyDeps(), getMemoryEdges: () => edges });
    const ranked = await scorer.score('anything', [linked, ...anchors]);
    // Default weights: adjacencyPerAnchor 1.0, adjacencyMax 2.0.
    expect(ranked.find((item) => item.id === 'linked-b')?.score).toBeCloseTo(3.6 + 2.0, 5);
  });

  it('never crosses the threshold from nothing, however strong the neighbourhood', async () => {
    // THE pinned invariant: base 0 + 5 adjacent passers → still nothing.
    const anchors = [1, 2, 3, 4, 5].map((i) => memory(`anchor-${i}`));
    const edges = [1, 2, 3, 4, 5].map((i) => ({ fromId: `anchor-${i}`, toId: 'isolated' }));
    const scores = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`anchor-${i}`, 5.0]));
    const scorer = new BoostedSuggestionScorer(fixedBase(scores), { ...emptyDeps(), getMemoryEdges: () => edges });
    const ranked = await scorer.score('anything', [memory('isolated'), ...anchors]);
    expect(ranked.find((item) => item.id === 'isolated')).toBeUndefined();
  });

  it('never rescues a near-miss either — no signal may decide a crossing', async () => {
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'anchor-a': 5.0, 'near-miss': MIN_SCORE - 0.1 }),
      { ...emptyDeps(), getMemoryEdges: () => [{ fromId: 'anchor-a', toId: 'near-miss' }] },
    );
    const ranked = await scorer.score('anything', [anchor, memory('near-miss')]);
    expect(ranked.find((item) => item.id === 'near-miss')).toBeUndefined();
  });

  it('workspace membership boosts a memory whose plan is the current work', async () => {
    const onPlan = memory('plan-memo', { planId: 'plan-1' });
    const other = memory('other-memo');
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'plan-memo': 3.6, 'other-memo': 3.6 }),
      {
        ...emptyDeps(),
        getWorkspacePlanIds: (sessionId) => (sessionId === 's1' ? new Set(['plan-1']) : new Set<string>()),
      },
    );
    const ranked = await scorer.score('anything', [onPlan, other], { sessionId: 's1' });
    expect(ranked[0]?.id).toBe('plan-memo');
    // A different session with no workspace does not get the boost.
    const noWorkspace = await scorer.score('anything', [onPlan, other], { sessionId: 's2' });
    expect(noWorkspace[0]?.score).toBeCloseTo(noWorkspace[1]!.score, 5);
  });
});

describe('BoostedSuggestionScorer — usage', () => {
  it('a previously-fetched passer outranks an equal-scoring peer', async () => {
    const fetched = memory('fetched');
    const peer = memory('peer');
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ fetched: 3.6, peer: 3.6 }),
      { ...emptyDeps(), usageBoost: (key, terms) => (key === 'memory/fetched' && terms.length > 0 ? 0.5 : 0) },
    );
    const ranked = await scorer.score('anything', [peer, fetched]);
    expect(ranked[0]?.id).toBe('fetched');
  });

  it('repeated fetches still never cross the threshold on usage alone', async () => {
    // THE pinned invariant, usage side: base 0 + weight 100 → still nothing.
    const scorer = new BoostedSuggestionScorer(fixedBase({}), { ...emptyDeps(), usageBoost: () => 100 });
    const ranked = await scorer.score('anything', [memory('oblique')]);
    expect(ranked).toEqual([]);
  });
});

describe('BoostedSuggestionScorer — scope and recency', () => {
  it('a project-scoped skill outranks an equal-scoring global one', async () => {
    const scoped = skill('scoped', { allProjects: false });
    const global = skill('global', { allProjects: true });
    const scorer = new BoostedSuggestionScorer(fixedBase({ scoped: 4.0, global: 4.0 }), emptyDeps());
    const ranked = await scorer.score('anything', [global, scoped]);
    expect(ranked[0]?.id).toBe('scoped');
    expect(ranked[0]?.score).toBeCloseTo(4.0 + 0.75, 5);
  });

  it('two identical matches rank by age, newest first', async () => {
    const fresh = memory('fresh', { createdAt: now });
    const stale = memory('stale', { createdAt: now - 100 * DAY });
    const scorer = new BoostedSuggestionScorer(fixedBase({ fresh: 4.0, stale: 4.0 }), emptyDeps());
    const ranked = await scorer.score('anything', [stale, fresh]);
    expect(ranked[0]?.id).toBe('fresh');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('a memory older than the recency window gets no recency boost', async () => {
    const stale = memory('stale', { createdAt: now - 100 * DAY });
    const scorer = new BoostedSuggestionScorer(fixedBase({ stale: 4.0 }), emptyDeps());
    const ranked = await scorer.score('anything', [stale]);
    expect(ranked[0]?.score).toBeCloseTo(4.0, 5);
  });
});

describe('BoostedSuggestionScorer — explainability and configuration', () => {
  it('every contribution is present in the log line', async () => {
    const anchor = memory('anchor-a');
    const linked = memory('linked-b');
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'anchor-a': 5.0, 'linked-b': 3.6 }),
      {
        getMemoryEdges: () => [{ fromId: 'anchor-a', toId: 'linked-b' }],
        getWorkspacePlanIds: () => new Set<string>(),
        usageBoost: () => 0.25,
      },
    );
    await scorer.score('anything', [anchor, linked], { sessionId: 's1' });
    const lines = vi.mocked(logger.debug).mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes('memory/linked-b'));
    expect(line).toBeDefined();
    for (const field of ['base=', 'adjacency=', 'scope=', 'usage=', 'recency=', 'final=']) {
      expect(line).toContain(field);
    }
  });

  it('weights are configuration: a tiny adjacency override cannot reorder past base', async () => {
    const anchor = memory('anchor-a');
    const linked = memory('linked-b');
    const unlinked = memory('unlinked-c');
    const scorer = new BoostedSuggestionScorer(
      fixedBase({ 'anchor-a': 5.0, 'linked-b': 3.6, 'unlinked-c': 3.7 }),
      { ...emptyDeps(), getMemoryEdges: () => [{ fromId: 'anchor-a', toId: 'linked-b' }] },
      { adjacencyPerAnchor: 0.01, adjacencyMax: 0.01 },
    );
    const ranked = await scorer.score('anything', [anchor, linked, unlinked]);
    const at = (id: string) => ranked.findIndex((item) => item.id === id);
    expect(at('unlinked-c')).toBeLessThan(at('linked-b'));
  });
});

describe('BoostedSuggestionScorer — fresh-install guarantee', () => {
  const REAL_CANDIDATES: SuggestionCandidate[] = [
    {
      type: 'skill',
      id: 'graphify',
      name: 'graphify',
      description: 'Any input to a knowledge graph with clustered communities. Trigger: /graphify',
    },
    {
      type: 'skill',
      id: 'bq-import',
      name: 'BigQuery Import',
      description: 'Import CSV exports into BigQuery tables, schema inference, partitioning setup.',
    },
    {
      type: 'memory',
      id: 'stall-recovery',
      name: 'Helm chain stall recovery',
      description: 'A usage-limit stall looks like a working session; press Esc and resume.',
    },
  ];
  const prompt = 'turn this repo into a knowledge graph with communities';

  it('all-zero signals produce exactly bare-BM25 output, in the same order', async () => {
    const bare = await new Bm25SuggestionScorer().score(prompt, REAL_CANDIDATES);
    const boosted = await new BoostedSuggestionScorer(new Bm25SuggestionScorer(), emptyDeps())
      .score(prompt, REAL_CANDIDATES);
    expect(boosted).toEqual(bare);
  });

  it('ordering is stable when all boosts are zero — ties keep the bare order', async () => {
    const tied: SuggestionCandidate[] = [
      { type: 'memory', id: 'b-one', name: 'Same Thing', description: 'identical text twins share the score' },
      { type: 'memory', id: 'a-two', name: 'Same Thing', description: 'identical text twins share the score' },
    ];
    const bare = await new Bm25SuggestionScorer().score('the identical twins', tied);
    const boosted = await new BoostedSuggestionScorer(new Bm25SuggestionScorer(), emptyDeps())
      .score('the identical twins', tied);
    expect(bare.map((item) => item.id)).toEqual(boosted.map((item) => item.id));
  });

  it('whole layer with an empty real store behaves exactly as G4', async () => {
    const configDir = join(tmpdir(), `g5-fresh-${now}`);
    const scorerDeps: SuggestionSignalDeps = {
      ...emptyDeps(),
      usageBoost: (key, terms) => new SuggestionUsageStore({ configDir }).boostFor(key, terms),
    };
    const g4 = await new SuggestionService({ getCandidates: () => REAL_CANDIDATES, scorer: new Bm25SuggestionScorer() })
      .suggest('s1', prompt, null);
    const g5 = await new SuggestionService({
      getCandidates: () => REAL_CANDIDATES,
      scorer: new BoostedSuggestionScorer(new Bm25SuggestionScorer(), scorerDeps),
    }).suggest('s2', prompt, null);
    expect(g4).toContain('skill/graphify');
    expect(g5).toEqual(g4);
  });

  it('a recorded fetch is learned through the full chain — ids and terms, only for the fetched item', async () => {
    const twins: SuggestionCandidate[] = [
      { type: 'memory', id: 'alpha-tool', name: 'Twin Tool', description: 'two twins with identical text' },
      { type: 'memory', id: 'zulu-tool', name: 'Twin Tool', description: 'two twins with identical text' },
    ];
    const configDir = join(tmpdir(), `g5-learned-${now}`);
    const store = new SuggestionUsageStore({ configDir });
    const service = new SuggestionService({
      getCandidates: () => twins,
      scorer: new BoostedSuggestionScorer(new Bm25SuggestionScorer(), {
        ...emptyDeps(),
        usageBoost: (key, terms) => store.boostFor(key, terms),
      }),
      onSuggested: (sessionId, keys, terms) => store.noteSuggestion(sessionId, keys, terms),
    });
    // Naming the candidates keeps this deterministic: equal scores, tie broken
    // by id — alpha first. (Ordering under usage is pinned at scorer level,
    // where base scores are controlled exactly.)
    const promptText = 'please run the twin tool on the folder';
    const before = await service.suggest('s1', promptText, null);
    expect(before).toBe('possibly related: memory/alpha-tool, memory/zulu-tool');
    // The agent fetched zulu after that suggestion (the dispatcher's call in
    // production); the correlation learns ONLY zulu.
    store.recordFetch('s1', 'memory/zulu-tool');
    expect(store.boostFor('memory/zulu-tool', usageTerms(promptText))).toBeGreaterThan(0);
    expect(store.boostFor('memory/alpha-tool', usageTerms(promptText))).toBe(0);
    // And what was learned cannot ADD a tuple — the payload is unchanged,
    // fresh session ledger or not.
    const after = await service.suggest('s2', promptText, null);
    expect(after).toBe(before);
  });
});
