/**
 * SuggestionScorer — the G4 hint-only suggester that fires on UserPromptSubmit.
 *
 * DESIGN (decided; do not re-derive — see plan P-0785 and the "scoring is on
 * demand" context node):
 * - POINTERS ONLY. The whole payload is `possibly related: skill/x, memory/y`.
 *   The agent fetches what it wants via skill_get / memory_get, or ignores it.
 *   A miss costs nothing; a hit costs ~10 tokens. There is no "inject body"
 *   tier to tune and there never will be one.
 * - NO MODEL. BM25 over name + description + declared triggers, pure
 *   TypeScript, zero dependencies. SemIf / Qwen / WebGPU / a Python sidecar
 *   were all considered and rejected.
 * - SCORE ON DEMAND. The candidate list is built when a prompt arrives and
 *   thrown away. No index, no worker, no re-indexing. The interface stays
 *   async anyway — that Promise is the seam for a future worker; do not
 *   "tidy" it to sync.
 * - BELOW THRESHOLD SENDS NOTHING. That is the common case and it must be
 *   free.
 *
 * Known, accepted weakness: BM25 misses oblique phrasing. Declared triggers
 * cover anticipated phrasings; the rest is an un-suggested pointer. Revisit
 * only with evidence from real use.
 */

import { logger } from '../../utils/logger.js';

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
}

export interface ScoredSuggestion {
  type: SuggestionType;
  id: string;
  name: string;
  score: number;
}

/**
 * The one-method scorer interface. Graph signals and usage feedback (G5)
 * arrive as alternative implementations of exactly this shape.
 */
export interface SuggestionScorer {
  score(prompt: string, candidates: readonly SuggestionCandidate[]): Promise<ScoredSuggestion[]>;
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
const MIN_SCORE = 3.5;

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
 * Rank candidates against a prompt. Pure, synchronous inside — the async
 * signature is the future-worker seam, not a lie about today's cost.
 */
export class Bm25SuggestionScorer implements SuggestionScorer {
  async score(prompt: string, candidates: readonly SuggestionCandidate[]): Promise<ScoredSuggestion[]> {
    const queryTerms = new Set(tokenize(prompt));
    if (queryTerms.size === 0 || candidates.length === 0) return [];

    const docs = candidates.map(buildDoc);
    const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;

    const scored: ScoredSuggestion[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const doc = docs[i];
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
      const promptLower = prompt.toLowerCase();
      const triggerHit = triggersOf(candidate).some(
        (phrase) => phrase.length > 1 && promptLower.includes(phrase.toLowerCase()),
      );
      if (triggerHit) score = Math.max(score, TRIGGER_SCORE);

      if (score >= MIN_SCORE) {
        scored.push({ type: candidate.type, id: candidate.id, name: candidate.name, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored;
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
      : await this.scorer.score(prompt, fresh);

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
    return payload;
  }

  /** A session that closed takes its ledger with it. */
  forgetSession(sessionId: string): void {
    this.suggested.delete(sessionId);
  }

  private key(candidate: { type: SuggestionType; id: string }): string {
    return `${candidate.type}/${candidate.id}`;
  }

  private tuple(item: { type: SuggestionType; id: string }): string {
    return `${item.type}/${item.id}`;
  }
}
