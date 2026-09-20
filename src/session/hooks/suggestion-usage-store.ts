/**
 * SuggestionUsageStore — G5's usage-feedback persistence (plan P-0786).
 *
 * WHAT IS STORED, and what is never stored. The privacy boundary is the
 * design: item IDs (the same tuples the suggester already emits) and TERM
 * co-occurrence counts — single lowercased words, stopword-stripped. Prompt
 * TEXT never lands here: no sentences, no messages, no transcript. The docs
 * say so explicitly (docs/cli-hooks.md, G5) because a silent prompt log would
 * be a nasty surprise for a user.
 *
 * The correlation is deliberately narrow. A fetch only becomes evidence when
 * the SAME session was recently (correlation window) shown a suggestion
 * naming that item; the terms recorded are that suggestion's prompt terms.
 * Everything else — fetches with no matching suggestion, fetches long after,
 * fetches after the session ended — records nothing.
 *
 * Storage is one small JSON file under the caller-provided config dir (the
 * per-user app-data dir — never the repo, invariant 4). It is inspectable
 * (snapshot) and resettable (reset) from the CLI Integrations settings pane.
 * Every write is fail-open: a store that cannot be written must not break the
 * fetch that triggered it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';

export const USAGE_FILE_NAME = 'suggestion-usage.json';

const DEFAULT_CORRELATION_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TERMS_PER_KEY = 64;
const DEFAULT_MAX_RECENT = 200;

/**
 * Function words and maximally generic verbs carry no topical signal — they
 * would accumulate huge counts on everything and drown the real co-occurrence
 * evidence. Content words stay.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'as',
  'into', 'over', 'after', 'before', 'out', 'up', 'down', 'off', 'via',
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who',
  'whom', 'when', 'where', 'why', 'how', 'not', 'no', 'nor', 'so', 'too',
  'very', 'just', 'also', 'again', 'please', 'hey', 'ok',
  'make', 'get', 'put', 'use', 'used', 'using', 'run', 'need', 'want',
  'try', 'add', 'set', 'fix', 'work', 'thing', 'things', 'stuff', 'way', 'let',
]);

/**
 * The terms usage feedback records for a prompt: lowercased content words,
 * same tokenizer family as BM25 (non-alphanumeric splits) but stricter —
 * three characters minimum and stopword-stripped, because usage weights have
 * no idf to discount ubiquitous terms.
 */
export function usageTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export interface SuggestionUsageState {
  version: 1;
  /** item key (type/id) → term → co-occurrence count */
  weights: Record<string, Record<string, number>>;
  /** Bounded log of learning events, for inspection. IDs and times only. */
  recent: Array<{ at: number; key: string }>;
}

export interface SuggestionUsageOptions {
  /** Directory the JSON file lives in (the per-user config dir). */
  configDir: string;
  now?: () => number;
  correlationWindowMs?: number;
  maxTermsPerKey?: number;
  maxRecent?: number;
}

interface PendingSuggestion {
  keys: Set<string>;
  terms: string[];
  at: number;
}

export class SuggestionUsageStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly correlationWindowMs: number;
  private readonly maxTermsPerKey: number;
  private readonly maxRecent: number;
  private state: SuggestionUsageState = { version: 1, weights: {}, recent: [] };
  /** Per-session recent suggestions awaiting (maybe) a fetch. In memory only. */
  private readonly pending = new Map<string, PendingSuggestion>();

  constructor(options: SuggestionUsageOptions) {
    this.filePath = join(options.configDir, USAGE_FILE_NAME);
    this.now = options.now ?? Date.now;
    this.correlationWindowMs = options.correlationWindowMs ?? DEFAULT_CORRELATION_WINDOW_MS;
    this.maxTermsPerKey = options.maxTermsPerKey ?? DEFAULT_MAX_TERMS_PER_KEY;
    this.maxRecent = options.maxRecent ?? DEFAULT_MAX_RECENT;
    this.load();
  }

  /**
   * A suggestion payload went out for this session: its item keys and prompt
   * terms are now eligible to be correlated with a fetch. Prompt terms live
   * in memory ONLY — they are correlation input, not stored state.
   */
  noteSuggestion(sessionId: string, keys: readonly string[], promptTerms: readonly string[]): void {
    if (keys.length === 0) return;
    this.pending.set(sessionId, { keys: new Set(keys), terms: [...promptTerms], at: this.now() });
  }

  /** A closed session takes its pending correlation with it. */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /**
   * The agent fetched an item. If that correlates with a recent suggestion
   * for the same session, record the co-occurrence; otherwise this fetch is
   * not evidence and nothing is written.
   */
  recordFetch(sessionId: string, key: string): void {
    const entry = this.pending.get(sessionId);
    const correlated = entry
      && entry.keys.has(key)
      && entry.terms.length > 0
      && this.now() - entry.at <= this.correlationWindowMs;
    if (!correlated) return;

    const terms = (this.state.weights[key] ??= {});
    for (const term of entry!.terms) {
      terms[term] = (terms[term] ?? 0) + 1;
    }
    this.pruneTerms(key);

    this.state.recent.push({ at: this.now(), key });
    if (this.state.recent.length > this.maxRecent) {
      this.state.recent = this.state.recent.slice(-this.maxRecent);
    }
    this.persist();
    logger.debug(`[HookSuggestUsage] learned ${key} × ${entry!.terms.length} term(s) (session=${sessionId})`);
  }

  /** Σ co-occurrence counts over the terms this item shares with the prompt. */
  boostFor(key: string, promptTerms: readonly string[]): number {
    const terms = this.state.weights[key];
    if (!terms || promptTerms.length === 0) return 0;
    let sum = 0;
    for (const term of promptTerms) sum += terms[term] ?? 0;
    return sum;
  }

  reset(): void {
    this.state = { version: 1, weights: {}, recent: [] };
    this.pending.clear();
    try {
      rmSync(this.filePath, { force: true });
    } catch (error) {
      logger.warn(`[HookSuggestUsage] could not remove usage store: ${String(error)}`);
    }
  }

  isEmpty(): boolean {
    return Object.keys(this.state.weights).length === 0 && this.state.recent.length === 0;
  }

  /** What the settings pane shows. Terms and ids only, by construction. */
  snapshot(): SuggestionUsageState {
    return {
      version: 1,
      weights: Object.fromEntries(Object.entries(this.state.weights).map(([key, terms]) => [key, { ...terms }])),
      recent: this.state.recent.map((entry) => ({ ...entry })),
    };
  }

  private pruneTerms(key: string): void {
    const terms = this.state.weights[key]!;
    const entries = Object.entries(terms);
    if (entries.length <= this.maxTermsPerKey) return;
    entries.sort((a, b) => a[1] - b[1]);
    for (const [term] of entries.slice(0, entries.length - this.maxTermsPerKey)) {
      delete terms[term];
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.filePath, '..'), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (error) {
      // Fail-open: a store that cannot be written must not break the fetch.
      logger.warn(`[HookSuggestUsage] could not persist usage store: ${String(error)}`);
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SuggestionUsageState>;
      this.state = {
        version: 1,
        weights: parsed.weights ?? {},
        recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-this.maxRecent) : [],
      };
    } catch (error) {
      logger.warn(`[HookSuggestUsage] unreadable usage store, starting empty: ${String(error)}`);
      this.state = { version: 1, weights: {}, recent: [] };
    }
  }
}
