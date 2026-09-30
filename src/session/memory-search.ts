import MiniSearch from 'minisearch';
import type { MemoryRecord } from '../types/memory.js';
import { processSearchTerm } from './search-terms.js';

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
