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
 * per-user app-data dir — never the repo, invariant 4), partitioned by project.
 * Existing global feedback migrates to a visible legacy partition that is not
 * used for scoring. The store is inspectable and resettable from Auto memory.
 * Every write is fail-open: a store that cannot be written must not break the
 * fetch that triggered it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import {
  UNATTRIBUTED_SCOPE_ID,
  type SuggestionUsageItemSummary,
  type SuggestionUsagePartition,
  type SuggestionUsageState,
  type SuggestionUsageSummary,
} from '../../types/suggestion-usage.js';

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
  projectId: string;
}

function emptyPartition(): SuggestionUsagePartition {
  return { weights: {}, recent: [] };
}

function emptyState(): SuggestionUsageState {
  return { version: 2, projects: {}, legacy: emptyPartition() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWeights(value: unknown): Record<string, Record<string, number>> {
  if (!isRecord(value)) return {};
  const weights: Record<string, Record<string, number>> = {};
  for (const [key, rawTerms] of Object.entries(value)) {
    if (!isRecord(rawTerms)) continue;
    const terms = Object.fromEntries(Object.entries(rawTerms)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0));
    if (Object.keys(terms).length > 0) weights[key] = terms;
  }
  return weights;
}

function normalizeRecent(value: unknown, maxRecent: number): SuggestionUsagePartition['recent'] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is { at: number; key: string } =>
    isRecord(entry) && typeof entry.at === 'number' && Number.isFinite(entry.at) && typeof entry.key === 'string')
    .slice(-maxRecent);
}

function normalizePartition(value: unknown, maxRecent: number): SuggestionUsagePartition {
  if (!isRecord(value)) return emptyPartition();
  return {
    weights: normalizeWeights(value.weights),
    recent: normalizeRecent(value.recent, maxRecent),
  };
}

export class SuggestionUsageStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly correlationWindowMs: number;
  private readonly maxTermsPerKey: number;
  private readonly maxRecent: number;
  private state: SuggestionUsageState = emptyState();
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
  noteSuggestion(sessionId: string, keys: readonly string[], promptTerms: readonly string[], projectId: string | null): void {
    if (!projectId || keys.length === 0 || promptTerms.length === 0) {
      this.pending.delete(sessionId);
      return;
    }
    this.pending.set(sessionId, { keys: new Set(keys), terms: [...promptTerms], at: this.now(), projectId });
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
  recordFetch(sessionId: string, key: string, projectId: string | null): void {
    const entry = this.pending.get(sessionId);
    const correlated = entry
      && projectId !== null
      && entry.projectId === projectId
      && entry.keys.has(key)
      && entry.terms.length > 0
      && this.now() - entry.at <= this.correlationWindowMs;
    if (!correlated) return;

    const partition = (this.state.projects[projectId] ??= emptyPartition());
    const terms = (partition.weights[key] ??= {});
    for (const term of entry!.terms) {
      terms[term] = (terms[term] ?? 0) + 1;
    }
    this.pruneTerms(partition, key);

    partition.recent.push({ at: this.now(), key });
    if (partition.recent.length > this.maxRecent) {
      partition.recent = partition.recent.slice(-this.maxRecent);
    }
    this.persist();
    logger.debug(`[HookSuggestUsage] learned ${key} × ${entry!.terms.length} term(s) (session=${sessionId})`);
  }

  /** Σ co-occurrence counts over the terms this item shares with the prompt. */
  boostFor(key: string, promptTerms: readonly string[], projectId: string | null): number {
    if (!projectId) return 0;
    const terms = this.state.projects[projectId]?.weights[key];
    if (!terms || promptTerms.length === 0) return 0;
    let sum = 0;
    for (const term of promptTerms) sum += terms[term] ?? 0;
    return sum;
  }

  reset(): void {
    this.state = emptyState();
    this.pending.clear();
    try {
      rmSync(this.filePath, { force: true });
    } catch (error) {
      logger.warn(`[HookSuggestUsage] could not remove usage store: ${String(error)}`);
    }
  }

  isEmpty(): boolean {
    return Object.keys(this.state.projects).length === 0
      && Object.keys(this.state.legacy.weights).length === 0
      && this.state.legacy.recent.length === 0;
  }

  /** What the settings pane shows. Terms and ids only, by construction. */
  snapshot(): SuggestionUsageState {
    return {
      version: 2,
      projects: Object.fromEntries(Object.entries(this.state.projects).map(([id, partition]) => [id, {
        weights: Object.fromEntries(Object.entries(partition.weights).map(([key, terms]) => [key, { ...terms }])),
        recent: partition.recent.map((entry) => ({ ...entry })),
      }])),
      legacy: {
        weights: Object.fromEntries(Object.entries(this.state.legacy.weights).map(([key, terms]) => [key, { ...terms }])),
        recent: this.state.legacy.recent.map((entry) => ({ ...entry })),
      },
    };
  }

  private pruneTerms(partition: SuggestionUsagePartition, key: string): void {
    const terms = partition.weights[key]!;
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
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('invalid root');
      if (parsed.version === 1) {
        this.state = { ...emptyState(), legacy: normalizePartition(parsed, this.maxRecent) };
        this.persist();
      } else if (parsed.version === 2) {
        const projects: Record<string, SuggestionUsagePartition> = {};
        if (isRecord(parsed.projects)) {
          for (const [projectId, partition] of Object.entries(parsed.projects)) {
            if (projectId && projectId !== UNATTRIBUTED_SCOPE_ID) projects[projectId] = normalizePartition(partition, this.maxRecent);
          }
        }
        this.state = {
          version: 2,
          projects,
          legacy: normalizePartition(parsed.legacy, this.maxRecent),
        };
      } else {
        throw new Error('unsupported version');
      }
    } catch (error) {
      logger.warn(`[HookSuggestUsage] unreadable usage store, starting empty: ${String(error)}`);
      this.state = emptyState();
    }
  }
}

/** A learnt item's display name and text, or null once it no longer exists. */
export type SuggestionUsageItemResolver = (key: string) => { name: string; body?: string } | null;

/**
 * All projects here are for reporting; the scorer reads only one project
 * partition. An item learnt in several projects is one row listing each of them.
 */
export function summarizeSuggestionUsage(
  state: SuggestionUsageState,
  knownProjects: ReadonlyArray<{ id: string; name: string }> = [],
  resolveItem: SuggestionUsageItemResolver = () => null,
): SuggestionUsageSummary {
  const projectNames = new Map(knownProjects.map(({ id, name }) => [id, name]));
  const projectIds = new Set([...Object.keys(state.projects), ...knownProjects.map(({ id }) => id)]);
  const projectStats = new Map<string, { items: number; totalWeight: number }>();
  const byKey = new Map<string, { item: SuggestionUsageItemSummary; terms: Map<string, number> }>();

  const appendPartition = (projectId: string, projectName: string, partition: SuggestionUsagePartition): void => {
    for (const [key, terms] of Object.entries(partition.weights)) {
      const weight = Object.values(terms).reduce((sum, count) => sum + count, 0);
      const stats = projectStats.get(projectId) ?? { items: 0, totalWeight: 0 };
      stats.items += 1;
      stats.totalWeight += weight;
      projectStats.set(projectId, stats);
      let entry = byKey.get(key);
      if (!entry) {
        const slash = key.indexOf('/');
        const resolved = resolveItem(key);
        entry = {
          item: {
            id: key,
            key,
            type: slash < 0 ? 'unknown' : key.slice(0, slash),
            itemId: slash < 0 ? key : key.slice(slash + 1),
            name: resolved?.name || key,
            ...(resolved?.body !== undefined ? { body: resolved.body } : {}),
            projects: [],
            weight: 0,
            topTerms: [],
            recent: [],
          },
          terms: new Map(),
        };
        byKey.set(key, entry);
      }
      entry.item.projects.push({ id: projectId, name: projectName, weight });
      entry.item.weight += weight;
      for (const [term, count] of Object.entries(terms)) entry.terms.set(term, (entry.terms.get(term) ?? 0) + count);
      entry.item.recent.push(...partition.recent.filter((event) => event.key === key).map((event) => event.at));
    }
  };

  for (const projectId of projectIds) {
    appendPartition(projectId, projectNames.get(projectId) ?? `Unknown project (${projectId})`, state.projects[projectId] ?? emptyPartition());
  }
  if (Object.keys(state.legacy.weights).length > 0 || state.legacy.recent.length > 0) {
    appendPartition(UNATTRIBUTED_SCOPE_ID, 'Unattributed legacy', state.legacy);
  }
  const items = [...byKey.values()].map(({ item, terms }) => {
    item.projects.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    item.topTerms = [...terms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([term, count]) => ({ term, count }));
    item.recent.sort((a, b) => a - b);
    return item;
  }).sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  const projects = [...projectIds].map((id) => ({
    id,
    name: projectNames.get(id) ?? `Unknown project (${id})`,
    ...(projectStats.get(id) ?? { items: 0, totalWeight: 0 }),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    items,
    projects,
    totalWeight: items.reduce((sum, item) => sum + item.weight, 0),
  };
}
