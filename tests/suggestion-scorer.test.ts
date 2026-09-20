/**
 * SuggestionScorer — the G4 hint-only suggester behind UserPromptSubmit.
 *
 * Binding decisions under test (plan P-0785 / "Skill & Memory Suggester"):
 * - tuples ONLY: the payload is `possibly related: skill/x, memory/y`, never a body
 * - NO model, no new dependency: BM25 + declared triggers, pure TypeScript
 * - below threshold sends NOTHING — the common case is free and empty
 * - a prompt that NAMES a candidate bypasses scoring
 * - once per item per session; top-K and byte caps; truncation never mid-tuple
 *
 * Candidates use real-shaped skill/memory descriptions — no mocks.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Bm25SuggestionScorer,
  SuggestionService,
  declaredTriggers,
  type SuggestionCandidate,
  type SuggestionScorer,
} from '../src/session/hooks/suggestion-scorer';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * A fake backend for the CAP tests: ranking everything is the scorer's job,
 * capping is the service's. (Real BM25 cannot rank a pile of identical
 * candidates — df = N for every term, so idf collapses — which is correct
 * behaviour, not a bug to test around.)
 */
const rankAll: SuggestionScorer = {
  async score(_prompt, candidates) {
    return candidates.map((candidate, index) => ({
      type: candidate.type,
      id: candidate.id,
      name: candidate.name,
      score: candidates.length - index,
    }));
  },
};

const SKILLS: SuggestionCandidate[] = [
  {
    type: 'skill',
    id: 'graphify',
    name: 'graphify',
    description:
      'Any input (code, docs, papers, images) to a knowledge graph with clustered communities, HTML + JSON output and an audit report. Trigger: /graphify',
  },
  {
    type: 'skill',
    id: 'bq-import',
    name: 'BigQuery Import',
    description: 'Import CSV exports into BigQuery tables, schema inference, partitioning setup.',
  },
  {
    type: 'skill',
    id: 'pdf-extract',
    name: 'PDF Text Extraction',
    description: 'A so-called unreadable scan is usually the reader, not the file: try pdftotext -layout first.',
  },
];

const MEMORIES: SuggestionCandidate[] = [
  {
    type: 'memory',
    id: 'helm-chain-stall-recovery',
    name: 'Helm chain stall recovery',
    description: 'A usage-limit stall looks like a working session; press Esc and resume the chain.',
  },
  {
    type: 'memory',
    id: 'eo-genius-charger',
    name: 'EO Genius charger',
    description: 'EG004 controller plus ESP32 over RS485 feeding Home Assistant sensors.',
  },
];

const ALL = [...SKILLS, ...MEMORIES];

describe('declaredTriggers', () => {
  it('reads Trigger/Triggers lines out of a description', () => {
    expect(declaredTriggers('Does things.\nTrigger: /graphify, build graph')).toEqual(['/graphify', 'build graph']);
    expect(declaredTriggers('Triggers: /deploy')).toEqual(['/deploy']);
  });

  it('returns empty for descriptions with no declared triggers', () => {
    expect(declaredTriggers('Plain description of a skill')).toEqual([]);
  });
});

describe('Bm25SuggestionScorer', () => {
  it('returns a promise even though the work is synchronous — the worker seam', async () => {
    const scorer = new Bm25SuggestionScorer();
    const result = scorer.score('build a knowledge graph from these docs', ALL);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('ranks an obvious match above an unrelated one', async () => {
    const scorer = new Bm25SuggestionScorer();
    const ranked = await scorer.score('turn this repo into a knowledge graph with communities', ALL);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]).toMatchObject({ type: 'skill', id: 'graphify' });
    // The unrelated candidates rank strictly below the obvious match.
    for (const other of ranked.slice(1)) {
      expect(other.score).toBeLessThan(ranked[0].score);
    }
  });

  it('scores nothing for a prompt with no hint of any candidate', async () => {
    const scorer = new Bm25SuggestionScorer();
    const ranked = await scorer.score('rename the variable and run the linter again', ALL);
    expect(ranked).toEqual([]);
  });
});

describe('SuggestionService', () => {
  function makeService(candidates: SuggestionCandidate[] = ALL) {
    return new SuggestionService({ getCandidates: () => candidates });
  }

  it('sends NOTHING below threshold — empty, not small', async () => {
    const service = makeService();
    expect(await service.suggest('s1', 'rename the variable and run the linter again', null)).toBeNull();
  });

  it('returns a tuples-only payload when something matches', async () => {
    const service = makeService();
    const payload = await service.suggest('s1', 'graphify this folder into a knowledge graph', null);
    // The WHOLE payload is tuple text — nothing else ever leaks.
    expect(payload).toMatch(/^possibly related: (skill|memory)\/[a-z0-9-]+(, (skill|memory)\/[a-z0-9-]+)*$/);
    // No body text is ever emitted.
    expect(payload).not.toContain('clustered');
    expect(payload).not.toContain('audit');
  });

  it('a prompt that NAMES a candidate bypasses scoring entirely', async () => {
    // The description says nothing about being named; only the explicit
    // mention can produce this tuple.
    const service = makeService([SKILLS[1], MEMORIES[0]]);
    const payload = await service.suggest('s1', 'please run BigQuery Import on yesterday exports', null);
    expect(payload).toBe('possibly related: skill/bq-import');
  });

  it('a declared trigger matches even when the description does not', async () => {
    const quiet: SuggestionCandidate[] = [
      {
        type: 'skill',
        id: 'deploy-check',
        name: 'Deploy Check',
        description: 'Runs a checklist. Trigger: /shipit',
      },
      ...ALL,
    ];
    const service = makeService(quiet);
    const payload = await service.suggest('s1', 'hey can you /shipit the build', null);
    expect(payload).toContain('skill/deploy-check');
  });

  it('suggests an item only once per session', async () => {
    const service = makeService();
    const prompt = 'graphify this folder into a knowledge graph';
    expect(await service.suggest('s1', prompt, null)).toContain('skill/graphify');
    // Same item matched again in the same session -> nothing left to say.
    expect(await service.suggest('s1', prompt, null)).toBeNull();
    // A different session is a different ledger.
    expect(await service.suggest('s2', prompt, null)).toContain('skill/graphify');
  });

  it('enforces the top-K cap', async () => {
    const many: SuggestionCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'skill' as const,
      id: `k-${i}`,
      name: `kernel-${i}`,
      description: 'kernel build compile flags for module loading',
    }));
    const service = new SuggestionService({ getCandidates: () => many, scorer: rankAll }, { topK: 3 });
    const payload = await service.suggest('s1', 'rebuild the kernel with new module flags', null);
    // Deterministic truncation: the top three in ranked order.
    expect(payload).toBe('possibly related: skill/k-0, skill/k-1, skill/k-2');
  });

  it('enforces the byte cap without truncating mid-tuple', async () => {
    const long: SuggestionCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      type: 'skill' as const,
      id: `very-long-identifier-number-${i}`,
      name: `very-long-identifier-number-${i}`,
      description: 'kernel build compile flags for module loading and driver verification',
    }));
    const service = new SuggestionService({ getCandidates: () => long, scorer: rankAll }, { maxBytes: 120 });
    const payload = await service.suggest('s1', 'rebuild the kernel with new module flags', null);
    expect(payload).not.toBeNull();
    // The cap actually bit: tuples were dropped whole, never split.
    expect(payload!.length).toBeLessThanOrEqual(120);
    for (const tuple of payload!.slice('possibly related: '.length).split(', ')) {
      expect(tuple).toMatch(/^(skill|memory)\/[a-z0-9-]+$/);
    }
  });
});
