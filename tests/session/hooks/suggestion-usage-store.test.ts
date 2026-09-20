/**
 * SuggestionUsageStore — G5's usage-feedback persistence.
 *
 * Binding decisions under test (plan P-0786 + orchestrator review 2026-09-20):
 * - Records ITEM IDS and TERM CO-OCCURRENCE only, never prompt text. The file
 *   is asserted never to contain the prompt sentence.
 * - Lives under the caller-provided config dir, never the repo (invariant 4).
 * - Correlates a fetch with a recent suggestion for the same session within a
 *   window; anything else is not evidence and records no weight.
 * - Resettable; a fresh store degrades to zero signal.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuggestionUsageStore, summarizeSuggestionUsage, usageTerms } from '../../../src/session/hooks/suggestion-usage-store';

function freshDir(): string {
  return join(tmpdir(), `g5-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const PROMPT = 'the secret pineapple passphrase rules for deploy';

function learnedStore(configDir: string, nowMs: number): SuggestionUsageStore {
  const store = new SuggestionUsageStore({ configDir, now: () => nowMs });
  store.noteSuggestion('s1', ['skill/deploy-check', 'memory/stall'], usageTerms(PROMPT));
  store.recordFetch('s1', 'skill/deploy-check');
  return store;
}

describe('usageTerms', () => {
  it('keeps content words, drops stopwords and single characters', () => {
    expect(usageTerms(PROMPT)).toEqual(['secret', 'pineapple', 'passphrase', 'rules', 'deploy']);
    expect(usageTerms('How do I make this faster?')).toEqual(['faster']);
  });
});

describe('SuggestionUsageStore', () => {
  it('round-trips learned weights through disk', () => {
    const dir = freshDir();
    const at = Date.parse('2026-09-20T00:00:00Z');
    learnedStore(dir, at);
    // A NEW instance over the same config dir reads the same weights.
    const reloaded = new SuggestionUsageStore({ configDir: dir });
    expect(reloaded.boostFor('skill/deploy-check', usageTerms(PROMPT))).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'suggestion-usage.json'))).toBe(true);
  });

  it('stores ids and terms but never prompt text', () => {
    const dir = freshDir();
    learnedStore(dir, Date.now());
    const raw = readFileSync(join(dir, 'suggestion-usage.json'), 'utf8');
    expect(raw).toContain('skill/deploy-check');
    expect(raw).toContain('pineapple'); // a term is sanctioned co-occurrence
    expect(raw).not.toContain('secret pineapple'); // the sentence is not
    expect(raw).not.toContain('passphrase rules');
  });

  it('resets to an empty store and removes the file', () => {
    const dir = freshDir();
    const store = learnedStore(dir, Date.now());
    store.reset();
    expect(store.isEmpty()).toBe(true);
    expect(store.boostFor('skill/deploy-check', usageTerms(PROMPT))).toBe(0);
    const reloaded = new SuggestionUsageStore({ configDir: dir });
    expect(reloaded.isEmpty()).toBe(true);
    expect(existsSync(join(dir, 'suggestion-usage.json'))).toBe(false);
  });

  it('a fetch outside the correlation window records no weight', () => {
    const dir = freshDir();
    let clock = Date.parse('2026-09-20T00:00:00Z');
    const store = new SuggestionUsageStore({ configDir: dir, now: () => clock });
    store.noteSuggestion('s1', ['skill/deploy-check'], usageTerms(PROMPT));
    store.recordFetch('s1', 'skill/deploy-check'); // inside the window
    expect(store.boostFor('skill/deploy-check', usageTerms(PROMPT))).toBeGreaterThan(0);

    store.noteSuggestion('s2', ['memory/stall'], usageTerms(PROMPT));
    clock += 20 * 60 * 1000; // past the 15-minute window
    store.recordFetch('s2', 'memory/stall');
    expect(store.boostFor('memory/stall', usageTerms(PROMPT))).toBe(0);
  });

  it('a fetch of an item that was never suggested records no weight', () => {
    const dir = freshDir();
    const store = new SuggestionUsageStore({ configDir: dir });
    store.noteSuggestion('s1', ['skill/deploy-check'], usageTerms(PROMPT));
    store.recordFetch('s1', 'skill/pdf-extract');
    expect(store.boostFor('skill/pdf-extract', usageTerms(PROMPT))).toBe(0);
    expect(store.snapshot().recent).toEqual([]);
  });

  it('a fetch after the session ended records no weight', () => {
    const dir = freshDir();
    const store = new SuggestionUsageStore({ configDir: dir });
    store.noteSuggestion('s1', ['skill/deploy-check'], usageTerms(PROMPT));
    store.forgetSession('s1');
    store.recordFetch('s1', 'skill/deploy-check');
    expect(store.boostFor('skill/deploy-check', usageTerms(PROMPT))).toBe(0);
  });

  it('repeated fetches accumulate weight, capped per co-occurrence later at scoring', () => {
    const dir = freshDir();
    const store = new SuggestionUsageStore({ configDir: dir });
    store.noteSuggestion('s1', ['skill/deploy-check'], usageTerms(PROMPT));
    store.recordFetch('s1', 'skill/deploy-check');
    store.recordFetch('s1', 'skill/deploy-check');
    expect(store.boostFor('skill/deploy-check', usageTerms(PROMPT))).toBe(2 * usageTerms(PROMPT).length);
  });

  it('the recent log is bounded and records learning events, newest last', () => {
    const dir = freshDir();
    const at = Date.parse('2026-09-20T00:00:00Z');
    const store = new SuggestionUsageStore({ configDir: dir, now: () => at, maxRecent: 3 });
    for (let i = 0; i < 5; i++) {
      store.noteSuggestion(`s${i}`, ['skill/k'], ['term']);
      store.recordFetch(`s${i}`, 'skill/k');
    }
    const recent = store.snapshot().recent;
    expect(recent).toHaveLength(3);
    expect(recent.map((entry) => entry.at)).toEqual([at, at, at]);
    expect(recent.every((entry) => entry.key === 'skill/k')).toBe(true);
  });

  it('an empty store is empty and boosts nothing', () => {
    const store = new SuggestionUsageStore({ configDir: freshDir() });
    expect(store.isEmpty()).toBe(true);
    expect(store.boostFor('skill/anything', ['word'])).toBe(0);
    // And nothing is written until something is actually learned.
    expect(existsSync(join(store.filePath))).toBe(false);
    rmSync(store.filePath, { force: true });
  });

  it('the pane summary ranks items by weight and shows their top terms', () => {
    const dir = freshDir();
    const store = new SuggestionUsageStore({ configDir: dir });
    store.noteSuggestion('s1', ['skill/deploy-check', 'skill/pdf-extract'], ['deploy', 'checklist', 'pdf']);
    store.recordFetch('s1', 'skill/deploy-check');
    store.recordFetch('s1', 'skill/deploy-check');
    store.recordFetch('s1', 'skill/pdf-extract');
    const summary = summarizeSuggestionUsage(store.snapshot());
    expect(summary.items).toBe(2);
    expect(summary.top[0]?.key).toBe('skill/deploy-check');
    expect(summary.top[0]?.weight).toBe(2 * 3);
    // 'deploy' and 'checklist' tie at 2 — ties break alphabetically.
    expect(summary.top[0]?.topTerms[0]).toEqual({ term: 'checklist', count: 2 });
    expect(summary.recent).toHaveLength(3);
  });
});
