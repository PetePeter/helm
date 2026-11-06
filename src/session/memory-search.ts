import MiniSearch from 'minisearch';
import type { MemoryRecord } from '../types/memory.js';
import { processSearchTerm } from './search-terms.js';
import { compileQueryExpression, isQueryExpression } from './memory-query.js';

export interface RankedMemory {
  id: string;
  score: number;
}

export interface RankOptions {
  /** Per-record multiplier — the caller's own project ranks above a foreign one. */
  boost?: (record: MemoryRecord) => number;
  /**
   * Query typing is loose (typos, half-typed words); a whole memory used as the
   * query is not, and fuzzy expansion of hundreds of terms only adds noise.
   */
  loose?: boolean;
}

/** A hit found only by substring ranks below every real term match. */
const SUBSTRING_SCORE = 0.001;

/**
 * BM25 over tldr (weighted) and content, any term matching.
 *
 * The index is built per call and thrown away: a store is tens to hundreds of
 * memories, so building costs less than keeping a second copy in sync.
 *
 * Tokens miss a word buried inside another (`deploy` in `prepareDeploy`), which
 * the old substring search found — so a literal substring match still counts,
 * ranked last.
 */
export function rankMemories(records: readonly MemoryRecord[], query: string, options: RankOptions = {}): RankedMemory[] {
  if (query.trim() === '' || records.length === 0) return [];
  if (options.loose !== false && isQueryExpression(query)) return rankExpression(records, query, options);
  const byId = new Map(records.map((record) => [record.id, record]));
  const index = new MiniSearch<MemoryRecord>({ fields: ['tldr', 'content'], processTerm: processSearchTerm });
  index.addAll(records as MemoryRecord[]);
  const boost = options.boost;
  const loose = options.loose ?? true;
  const ranked: RankedMemory[] = index.search(query, {
    boost: { tldr: 2 },
    combineWith: 'OR',
    // Short words get no typo or prefix slack: it would match unrelated words.
    ...(loose ? { prefix: (term: string) => term.length > 3, fuzzy: (term: string) => (term.length > 4 ? 0.2 : false) } : {}),
    ...(boost ? { boostDocument: (id: unknown) => boost(byId.get(id as string)!) } : {}),
  }).map((hit) => ({ id: hit.id as string, score: hit.score }));

  if (loose) {
    const found = new Set(ranked.map((hit) => hit.id));
    const needle = query.toLowerCase();
    for (const record of records) {
      if (found.has(record.id)) continue;
      if (record.tldr.toLowerCase().includes(needle) || record.content.toLowerCase().includes(needle)) {
        ranked.push({ id: record.id, score: SUBSTRING_SCORE * (boost?.(record) ?? 1) });
      }
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** An expression filters; BM25 over its positive words orders what survives. */
function rankExpression(records: readonly MemoryRecord[], query: string, options: RankOptions): RankedMemory[] {
  const compiled = compileQueryExpression(query);
  const matching = records.filter((record) => compiled.matches(`${record.tldr}\n${record.content}`));
  const scored = compiled.rankingTerms ? rankMemories(matching, compiled.rankingTerms, { ...options, loose: false }) : [];
  const found = new Set(scored.map((hit) => hit.id));
  const rest = matching
    .filter((record) => !found.has(record.id))
    .map((record) => ({ id: record.id, score: SUBSTRING_SCORE * (options.boost?.(record) ?? 1) }));
  return [...scored, ...rest].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
