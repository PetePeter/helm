/**
 * Term handling shared by every MiniSearch index in Helm (memory search and
 * the prompt hint scorer), so both agree on what a word is.
 *
 * Stop words are dropped: in a store of tens of short documents, "the" is
 * rare enough to earn a real score, and a prompt full of them would surface
 * hints on grammar alone.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'has', 'have',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/** Lowercase; null drops the term (stop word or single character). */
export function processSearchTerm(term: string): string | null {
  const lower = term.toLowerCase();
  return lower.length > 1 && !STOP_WORDS.has(lower) ? lower : null;
}
