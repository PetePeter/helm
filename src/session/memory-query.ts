/**
 * Query expressions for memory search: `car NEAR/5 bridge`, `(deploy OR release) AND -draft`.
 *
 * A plain query stays plain — BM25 over any term, already as wide as it gets.
 * An expression is a FILTER (which memories qualify); the qualifying set is
 * then ranked by BM25 over the expression's positive words, so order still
 * means relevance.
 *
 * Grammar (operators case-insensitive; adjacency means OR, like a plain query):
 *   or      := and (OR and)*
 *   and     := unary (AND unary)*  |  unary unary…  (implicit OR)
 *   unary   := NOT unary | -unary | near
 *   near    := primary ((NEAR/n | ONEAR/n) primary)*   — within n words; ONEAR keeps order
 *   primary := ( or ) | "exact phrase" | word | word* (prefix) | word~ (typo-tolerant)
 */
import { processSearchTerm } from './search-terms.js';

type Node =
  | { kind: 'word'; text: string; mode: 'exact' | 'prefix' | 'fuzzy' }
  | { kind: 'phrase'; words: string[] }
  | { kind: 'and' | 'or'; nodes: Node[] }
  | { kind: 'not'; node: Node }
  | { kind: 'near'; left: Node; right: Node; distance: number; ordered: boolean };

const NEAR = /^(o?near)\/?(\d+)$/i;

/** True when the query uses any expression syntax; plain queries keep the BM25-only path. */
export function isQueryExpression(query: string): boolean {
  return /["()]/.test(query)
    || /(^|\s)(AND|OR|NOT)(\s|$)/.test(query)
    || /(^|\s)-\S/.test(query)
    || /(^|\s)o?near\/?\d+(\s|$)/i.test(query)
    || /\w[*~](\s|$)/.test(query);
}

function tokenize(query: string): string[] {
  return query.match(/"[^"]*"?|[()]|[^\s()"]+/g) ?? [];
}

/** Parse an expression; throws with a caller-readable message on bad syntax. */
export function parseQueryExpression(query: string): Node {
  const tokens = tokenize(query);
  let at = 0;
  const peek = () => tokens[at];
  const fail = (message: string): never => { throw new Error(`Invalid query expression: ${message}`); };

  const parsePrimary = (): Node => {
    const token = tokens[at++];
    if (token === undefined) return fail('ends early');
    if (token === '(') {
      const node = parseOr();
      if (tokens[at++] !== ')') fail('missing )');
      return node;
    }
    if (token === ')') return fail('unexpected )');
    if (token.startsWith('"')) {
      if (token.length < 2 || !token.endsWith('"')) fail('unclosed quote');
      const words = wordsOf(token.slice(1, -1));
      return words.length ? { kind: 'phrase', words } : fail('empty phrase');
    }
    const mode = token.endsWith('*') ? 'prefix' : token.endsWith('~') ? 'fuzzy' : 'exact';
    const text = (mode === 'exact' ? token : token.slice(0, -1)).toLowerCase();
    return text ? { kind: 'word', text, mode } : fail(`bad word "${token}"`);
  };

  const parseNear = (): Node => {
    let node = parsePrimary();
    for (let m = NEAR.exec(peek() ?? ''); m; m = NEAR.exec(peek() ?? '')) {
      at++;
      node = { kind: 'near', left: node, right: parsePrimary(), distance: Number(m[2]), ordered: m[1].toLowerCase() === 'onear' };
    }
    return node;
  };

  const parseUnary = (): Node => {
    const token = peek();
    if (token && /^not$/i.test(token)) { at++; return { kind: 'not', node: parseUnary() }; }
    if (token && token.length > 1 && token.startsWith('-')) { tokens[at] = token.slice(1); return { kind: 'not', node: parseUnary() }; }
    return parseNear();
  };

  const startsOperand = (token: string | undefined) => token !== undefined && token !== ')' && !/^(and|or)$/i.test(token);

  const parseAnd = (): Node => {
    const nodes = [parseUnary()];
    while (peek() && /^and$/i.test(peek()!)) { at++; nodes.push(parseUnary()); }
    return nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
  };

  function parseOr(): Node {
    const nodes = [parseAnd()];
    for (;;) {
      if (peek() && /^or$/i.test(peek()!)) { at++; nodes.push(parseAnd()); continue; }
      if (startsOperand(peek())) { nodes.push(parseAnd()); continue; }
      break;
    }
    return nodes.length === 1 ? nodes[0] : { kind: 'or', nodes };
  }

  if (tokens.length === 0) fail('empty');
  const root = parseOr();
  if (at < tokens.length) fail(`unexpected "${tokens[at]}"`);
  return root;
}

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] <= max;
}

function wordMatches(node: Extract<Node, { kind: 'word' }>, token: string): boolean {
  if (node.mode === 'prefix') return token.startsWith(node.text);
  if (node.mode === 'fuzzy') return editDistanceWithin(node.text, token, Math.max(1, Math.floor(node.text.length * 0.2)));
  return token === node.text;
}

/** Word positions where a node matches (a phrase or NEAR spans; its first word stands for it). */
function positions(node: Node, tokens: readonly string[]): number[] {
  switch (node.kind) {
    case 'word': return tokens.flatMap((token, i) => (wordMatches(node, token) ? [i] : []));
    case 'phrase':
      return tokens.flatMap((_, i) => (node.words.every((word, k) => tokens[i + k] === word) ? [i] : []));
    case 'near': {
      const right = positions(node.right, tokens);
      return positions(node.left, tokens).filter((l) => right.some((r) => (node.ordered ? r > l && r - l <= node.distance : r !== l && Math.abs(r - l) <= node.distance)));
    }
    default: return evaluate(node, tokens) ? [0] : [];
  }
}

function evaluate(node: Node, tokens: readonly string[]): boolean {
  switch (node.kind) {
    case 'and': return node.nodes.every((child) => evaluate(child, tokens));
    case 'or': return node.nodes.some((child) => evaluate(child, tokens));
    case 'not': return !evaluate(node.node, tokens);
    default: return positions(node, tokens).length > 0;
  }
}

/** A compiled expression: a record filter plus the words BM25 should rank the survivors by. */
export interface CompiledQuery {
  matches(text: string): boolean;
  rankingTerms: string;
}

export function compileQueryExpression(query: string): CompiledQuery {
  const root = parseQueryExpression(query);
  const positive: string[] = [];
  const collect = (node: Node): void => {
    switch (node.kind) {
      case 'word': if (processSearchTerm(node.text)) positive.push(node.text); break;
      case 'phrase': positive.push(...node.words.filter((word) => processSearchTerm(word))); break;
      case 'near': collect(node.left); collect(node.right); break;
      case 'and': case 'or': node.nodes.forEach(collect); break;
      case 'not': break;
    }
  };
  collect(root);
  return {
    matches: (text) => evaluate(root, wordsOf(text)),
    rankingTerms: positive.join(' '),
  };
}
