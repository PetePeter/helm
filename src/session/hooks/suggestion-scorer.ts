/**
 * SuggestionScorer — the hint-only suggester that fires on UserPromptSubmit.
 *
 * DESIGN (decided; do not re-derive — see plans P-0785/P-0786 and the
 * "scoring is on demand" context node):
 * - POINTERS ONLY. The whole payload is `possibly related: skill/x (Name),
 *   memory/y` — id is the address, name is the label (G7: a bare UUID forces
 *   a fetch to judge relevance, the exact cost pointers exist to avoid).
 *   The agent fetches what it wants via skill_get / memory_get, or ignores it.
 *   A miss costs nothing; a hit costs ~15 tokens. There is no "inject body"
 *   tier to tune and there never will be one.
 * - NO MODEL. BM25 over name + description + declared triggers, pure
 *   TypeScript, zero dependencies. SemIf / Qwen / WebGPU / a Python sidecar
 *   were all considered and rejected.
 * - SCORE ON DEMAND. The candidate list is built when a prompt arrives and
 *   thrown away. No index, no worker, no re-indexing. The interface stays
 *   async anyway — that Promise is the seam for a future worker; do not
 *   "tidy" it to sync.
 * - BELOW THRESHOLD SENDS NOTHING. That is the common case and it must be
 *   free. The threshold is BM25's job ALONE: G5's signals (graph adjacency,
 *   scope, recency, usage feedback — `BoostedSuggestionScorer`) REORDER
 *   PASSERS ONLY. Nothing may cross MIN_SCORE except on base score, or a
 *   suggestion→fetch→weight→suggestion loop could drift the ranking toward
 *   whatever was suggested early. See docs/cli-hooks.md, G5.
 *
 * Known, accepted weakness: BM25 misses oblique phrasing. Declared triggers
 * cover anticipated phrasings; the rest is an un-suggested pointer. Revisit
 * only with evidence from real use — e.g. relevant items consistently sitting
 * just below the line would be evidence for a bounded rescue signal.
 */

import { logger } from '../../utils/logger.js';
import { usageTerms } from './suggestion-usage-store.js';

export type SuggestionType = 'skill' | 'memory';

/** One scoreable thing: a skill or memory reduced to its pointer text. */
export interface SuggestionCandidate {
  type: SuggestionType;
  /** The id the agent passes to skill_get / memory_get. */
  id: string;
  name: string;
  description: string;
  /**
   * Explicit trigger phrases for pre-parsed sources. When absent they are
   * parsed out of the description's `Trigger:` lines — the shape real skill
   * descriptions actually use (e.g. graphify's `Trigger: /graphify`).
   */
  triggers?: string[];
  // -- G5 signal inputs (optional; absent means the signal is unavailable,
  //    not zero — the scorer never guesses) -----------------------------------
  /** True when the candidate is global (all projects) — scope boost is 0. */
  allProjects?: boolean;
  /** Creation time (epoch ms); recency decays from this. */
  createdAt?: number;
  /** For memories: the plan the memory was written under — workspace adjacency. */
  planId?: string;
}

export interface ScoredSuggestion {
  type: SuggestionType;
  id: string;
  name: string;
  score: number;
}

/** Per-call scoring context; optional so 2-arg implementations stay valid. */
export interface SuggestionScoreContext {
  sessionId?: string;
}

/**
 * The one-method scorer interface. G4's BM25 and G5's boosted composition are
 * alternative implementations of exactly this shape.
 */
export interface SuggestionScorer {
  score(
    prompt: string,
    candidates: readonly SuggestionCandidate[],
    ctx?: SuggestionScoreContext,
  ): Promise<ScoredSuggestion[]>;
}

/**
 * Extract `Trigger:` / `Triggers:` phrases from a description, splitting
 * lists on commas. An author knows their triggers better than any classifier
 * infers them; exact match beats probability. The phrase may sit mid-line —
 * real descriptions read "… an audit report. Trigger: /graphify".
 */
export function declaredTriggers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/triggers?\s*:\s*([^\n]+)/gi)) {
    for (const part of match[1].split(',')) {
      const phrase = part.trim().replace(/^`|`$/g, '');
      if (phrase) out.push(phrase);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BM25 — over ~40 candidates this is sub-millisecond, deterministic, and
// explainable. No dependency: this is the whole engine.
// ---------------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;
// The NAME field is indexed three times (weight 3): names are intent.
/** A declared trigger phrase found verbatim in the prompt clears any doubt. */
const TRIGGER_SCORE = 10;
/** Minimum BM25 score to surface a candidate at all. */
export const MIN_SCORE = 3.5;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

/** Explicit triggers win; otherwise the description's `Trigger:` lines are the declaration. */
function triggersOf(candidate: SuggestionCandidate): string[] {
  return candidate.triggers ?? declaredTriggers(candidate.description);
}

interface Bm25Doc {
  tokens: string[];
  length: number;
}

function buildDoc(candidate: SuggestionCandidate): Bm25Doc {
  const name = tokenize(candidate.name);
  const description = tokenize(candidate.description);
  const triggers = triggersOf(candidate).flatMap(tokenize);
  const tokens = [
    ...name, ...name, ...name, // weight 3
    ...description,
    ...triggers, ...triggers, // triggers also index as terms
  ];
  return { tokens, length: tokens.length };
}

function termFrequency(tokens: string[], term: string): number {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

/**
 * Raw BM25 (plus the declared-trigger override) for every candidate, aligned
 * with the input order — no threshold applied. The threshold is applied by
 * the scorer that ranks: bare BM25 here, and the same rule in the boosted
 * composition (G5 may reorder passers but never decides a crossing).
 */
export function bm25RawScores(prompt: string, candidates: readonly SuggestionCandidate[]): number[] {
  const queryTerms = new Set(tokenize(prompt));
  if (queryTerms.size === 0 || candidates.length === 0) return candidates.map(() => 0);

  const docs = candidates.map(buildDoc);
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const promptLower = prompt.toLowerCase();

  return candidates.map((candidate, i) => {
    const doc = docs[i]!;
    let score = 0;

    for (const term of queryTerms) {
      const tf = termFrequency(doc.tokens, term);
      if (tf === 0) continue;
      // Document frequency across the candidate set, this query only.
      let df = 0;
      for (const other of docs) if (termFrequency(other.tokens, term) > 0) df += 1;
      const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
      const denominator = tf + K1 * (1 - B + (B * doc.length) / (averageLength || 1));
      score += idf * ((tf * (K1 + 1)) / denominator);
    }

    // A declared trigger phrase present verbatim wins outright — the author
    // said "this is when", and the prompt said exactly that.
    const triggerHit = triggersOf(candidate).some(
      (phrase) => phrase.length > 1 && promptLower.includes(phrase.toLowerCase()),
    );
    if (triggerHit) score = Math.max(score, TRIGGER_SCORE);
    return score;
  });
}

/**
 * Rank candidates against a prompt. Pure, synchronous inside — the async
 * signature is the future-worker seam, not a lie about today's cost.
 */
export class Bm25SuggestionScorer implements SuggestionScorer {
  async score(
    prompt: string,
    candidates: readonly SuggestionCandidate[],
  ): Promise<ScoredSuggestion[]> {
    const scores = bm25RawScores(prompt, candidates);
    const scored: ScoredSuggestion[] = [];
    candidates.forEach((candidate, i) => {
      if (scores[i]! >= MIN_SCORE) {
        scored.push({ type: candidate.type, id: candidate.id, name: candidate.name, score: scores[i]! });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored;
  }
}

// ---------------------------------------------------------------------------
// G5 — BoostedSuggestionScorer: graph adjacency, scope, recency, and usage
// feedback, composed EXPLICITLY on top of the base scorer.
// ---------------------------------------------------------------------------

/**
 * The signal weights. Configuration, not magic constants: shipped defaults
 * live here, overrides come from the `suggestionScoring` section of the
 * user's settings.yaml.
 */
export interface SuggestionScoringWeights {
  /** Added per adjacent anchor, capped at `adjacencyMax`. */
  adjacencyPerAnchor: number;
  adjacencyMax: number;
  /** Flat boost for a project-scoped (non-global) skill. */
  scope: number;
  /** Full boost for a just-created memory, decaying to 0 over the window. */
  recencyMax: number;
  recencyWindowDays: number;
  /** Added per recorded co-occurrence, capped at `usageMax`. */
  usagePerCooccurrence: number;
  usageMax: number;
}

export const DEFAULT_SUGGESTION_SCORING: SuggestionScoringWeights = {
  adjacencyPerAnchor: 1.0,
  adjacencyMax: 2.0,
  scope: 0.75,
  recencyMax: 0.75,
  recencyWindowDays: 30,
  usagePerCooccurrence: 1.0,
  usageMax: 2.0,
};

/**
 * Read-only adjacency lookups, injected so the scorer stays pure and
 * testable. All of it is on-demand: one prompt, one walk, then throw away.
 */
export interface SuggestionSignalDeps {
  /** memory_graph edges (memory↔memory links). */
  getMemoryEdges(): ReadonlyArray<{ fromId: string; toId: string }>;
  /**
   * Plan ids adjacent to the session's current work: the claimed plan, its
   * sequence siblings, and plans sharing a context node bound to that plan
   * or its sequence. Context nodes have no direct edges to candidates, so
   * they contribute through the plans they are bound to.
   */
  getWorkspacePlanIds(sessionId: string): ReadonlySet<string>;
  /** Co-occurrence weight of an item for the prompt's terms (usage feedback). */
  usageBoost(key: string, promptTerms: readonly string[]): number;
}

/**
 * The G5 composition: final = base + adjacency + scope + recency + usage,
 * with EVERY contribution on the log line — explainability is the entire
 * reason this exists instead of a model, so there is no opaque blend.
 *
 * THE RULE (decided, do not "improve" it back): the threshold is BM25's job.
 * The base decides who passes; the signals reorder passers only. No signal —
 * not adjacency, not a hundred recorded fetches — may lift a candidate over
 * MIN_SCORE, because a usage signal that could decide would make the ranking
 * drift toward whatever was suggested early: suggested → fetched → weighted
 * → suggested again, forever plausibly, never relevantly.
 */
export class BoostedSuggestionScorer implements SuggestionScorer {
  private readonly weights: SuggestionScoringWeights;

  constructor(
    private readonly base: SuggestionScorer = new Bm25SuggestionScorer(),
    private readonly deps: SuggestionSignalDeps,
    weights: Partial<SuggestionScoringWeights> = {},
  ) {
    this.weights = { ...DEFAULT_SUGGESTION_SCORING, ...weights };
  }

  async score(
    prompt: string,
    candidates: readonly SuggestionCandidate[],
    ctx?: SuggestionScoreContext,
  ): Promise<ScoredSuggestion[]> {
    const passers = await this.base.score(prompt, candidates, ctx);
    if (passers.length === 0) return [];

    const byKey = new Map(candidates.map((candidate) => [`${candidate.type}/${candidate.id}`, candidate]));
    // Edge endpoints are raw memory ids — the graph never carries skills.
    const anchorIds = new Set(passers.filter((passer) => passer.type === 'memory').map((passer) => passer.id));
    const edges = new Set(this.deps.getMemoryEdges().map((edge) => `${edge.fromId} ${edge.toId}`));
    const workspace = ctx?.sessionId ? this.deps.getWorkspacePlanIds(ctx.sessionId) : new Set<string>();
    const promptTerms = usageTerms(prompt);
    const now = Date.now();

    const ranked: ScoredSuggestion[] = [];
    for (const passer of passers) {
      const candidate = byKey.get(`${passer.type}/${passer.id}`);
      if (!candidate) continue;

      let adjacentAnchors = 0;
      if (passer.type === 'memory') {
        for (const anchorId of anchorIds) {
          if (anchorId === passer.id) continue;
          if (edges.has(`${passer.id} ${anchorId}`) || edges.has(`${anchorId} ${passer.id}`)) {
            adjacentAnchors += 1;
          }
        }
      }
      if (candidate.planId && workspace.has(candidate.planId)) adjacentAnchors += 1;

      const adjacency = Math.min(adjacentAnchors * this.weights.adjacencyPerAnchor, this.weights.adjacencyMax);
      // Scope distinguishes project-bound from global among skills; memories
      // are already pre-filtered to the project, so the signal is theirs
      // by construction and stays 0. Absent `allProjects` is UNKNOWN, not
      // scoped — the scorer never guesses, so it boosts nothing.
      const scope = candidate.type === 'skill' && candidate.allProjects === false ? this.weights.scope : 0;
      const ageDays = candidate.createdAt === undefined ? Infinity : (now - candidate.createdAt) / (24 * 60 * 60 * 1000);
      const recency = Number.isFinite(ageDays)
        ? this.weights.recencyMax * Math.max(0, 1 - ageDays / (this.weights.recencyWindowDays || 1))
        : 0;
      const usage = Math.min(
        this.deps.usageBoost(`${passer.type}/${passer.id}`, promptTerms) * this.weights.usagePerCooccurrence,
        this.weights.usageMax,
      );

      const final = passer.score + adjacency + scope + recency + usage;
      logger.debug(
        `[HookSuggestSignals] ${passer.type}/${passer.id} base=${passer.score.toFixed(2)} ` +
        `adjacency=${adjacency.toFixed(2)} scope=${scope.toFixed(2)} usage=${usage.toFixed(2)} ` +
        `recency=${recency.toFixed(2)} final=${final.toFixed(2)}`,
      );
      ranked.push({ type: passer.type, id: passer.id, name: passer.name, score: final });
    }

    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return ranked;
  }
}

// ---------------------------------------------------------------------------
// SuggestionService — caps, once-per-item-per-session, and the payload format.
// ---------------------------------------------------------------------------

export interface SuggestionServiceDeps {
  /** Live read of the scoreable candidates for a project (pre-filtered). */
  getCandidates: (projectId: string | null) => SuggestionCandidate[];
  /** Swap the backend (tests, G5 graph ranking). Defaults to BM25. */
  scorer?: SuggestionScorer;
  /**
   * G5 usage feedback: called with the tuples actually sent and the prompt's
   * usable terms, for the usage store to correlate with a later fetch.
   * Absent (G4 wiring) means nothing is recorded.
   */
  onSuggested?: (sessionId: string, keys: readonly string[], promptTerms: readonly string[]) => void;
}

export interface SuggestionServiceOptions {
  /** Maximum tuples in one payload. */
  topK?: number;
  /** Maximum payload length in bytes; tuples are dropped whole, never split. */
  maxBytes?: number;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_BYTES = 400;
const PAYLOAD_PREFIX = 'possibly related: ';

/** A prompt that NAMES a candidate matches it without consulting the scorer. */
function explicitlyNamed(prompt: string, candidates: readonly SuggestionCandidate[]): SuggestionCandidate[] {
  const promptLower = prompt.toLowerCase();
  return candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    if (name.length < 3) return false;
    const at = promptLower.indexOf(name);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : promptLower.charAt(at - 1);
    const after = at + name.length >= promptLower.length ? ' ' : promptLower.charAt(at + name.length);
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  });
}

export class SuggestionService {
  private readonly deps: SuggestionServiceDeps;
  private readonly topK: number;
  private readonly maxBytes: number;
  private readonly scorer: SuggestionScorer;
  /** Per-session ledger of already-suggested items — one pointer, ever. */
  private readonly suggested = new Map<string, Set<string>>();

  constructor(deps: SuggestionServiceDeps, options: SuggestionServiceOptions = {}) {
    this.deps = deps;
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.scorer = deps.scorer ?? new Bm25SuggestionScorer();
  }

  /**
   * Build the one-line pointer payload for a prompt, or null when there is
   * nothing worth saying. Null is the common case and costs nothing.
   */
  async suggest(sessionId: string, prompt: string, projectId: string | null): Promise<string | null> {
    if (!prompt.trim()) return null;
    const startedAt = performance.now();

    const candidates = this.deps.getCandidates(projectId);
    if (candidates.length === 0) return null;

    const seen = this.suggested.get(sessionId);
    const fresh = candidates.filter((candidate) => !seen?.has(this.key(candidate)));

    // An explicit mention bypasses scoring: the prompt already knows.
    const named = explicitlyNamed(prompt, fresh);
    const ranked = named.length > 0
      ? named.map((candidate) => ({ ...candidate, score: TRIGGER_SCORE }))
      : await this.scorer.score(prompt, fresh, { sessionId });

    const chosen: ScoredSuggestion[] = [];
    let payload = '';
    for (const item of ranked.slice(0, this.topK)) {
      const next = chosen.length === 0
        ? PAYLOAD_PREFIX + this.tuple(item)
        : payload + ', ' + this.tuple(item);
      if (next.length > this.maxBytes && chosen.length > 0) break;
      payload = next;
      chosen.push(item);
      if (chosen.length >= this.topK) break;
    }
    if (chosen.length === 0) return null;

    // Record AFTER deciding: only what was actually sent counts as suggested.
    for (const item of chosen) {
      let ledger = this.suggested.get(sessionId);
      if (!ledger) {
        ledger = new Set();
        this.suggested.set(sessionId, ledger);
      }
      ledger.add(this.key(item));
    }

    const elapsedMs = performance.now() - startedAt;
    logger.info(`[HookSuggest] session=${sessionId} "${payload}"`);
    logger.debug(`[HookSuggest] scored ${candidates.length} candidates in ${elapsedMs.toFixed(2)}ms`);
    // G5 usage feedback: what was sent, and the prompt's usable terms, for the
    // usage store to correlate with a fetch of one of these items.
    this.deps.onSuggested?.(sessionId, chosen.map((item) => this.key(item)), usageTerms(prompt));
    return payload;
  }

  /** A session that closed takes its ledger with it. */
  forgetSession(sessionId: string): void {
    this.suggested.delete(sessionId);
  }

  private key(candidate: { type: SuggestionType; id: string }): string {
    return `${candidate.type}/${candidate.id}`;
  }

  /**
   * One pointer: `type/id (name)`. The id is the ADDRESS — it is what
   * skill_get / memory_get take, and names are not unique. The name is the
   * LABEL — what lets the recipient judge relevance WITHOUT fetching, which
   * a bare UUID never can. It is appended only when it adds information the
   * id lacks (never `skill/graphify (graphify)`) and never carries the
   * characters that build the line format (comma, parens, newline), so a
   * hostile or accident-prone name cannot forge another tuple.
   */
  private tuple(item: { type: SuggestionType; id: string; name?: string }): string {
    const name = (item.name ?? '')
      .replace(/[,()\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.toLowerCase() === item.id.toLowerCase()) return `${item.type}/${item.id}`;
    return `${item.type}/${item.id} (${name})`;
  }
}
