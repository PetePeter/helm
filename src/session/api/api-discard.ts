/**
 * Speculative lookups (docs/api-tools.md).
 *
 * A lookup that found nothing useful should not sit in a small model's
 * context for the rest of the session. The loop marks the conversation before
 * every read-only lookup by itself, `discard` cuts back to that mark, and this
 * table remembers what was thrown away, so the same question is not run again
 * by accident. Nothing here expires: a refused repeat is told when it was
 * tried, and the model decides whether to insist with `force`.
 *
 * In memory only, per session: the table starts empty after a restart.
 */

import { createHash } from 'node:crypto';
import type { ToolSpec } from './api-agent-loop.js';

/**
 * The calls that only read. Forgetting a call removes it from the context but
 * cannot undo what it did, so nothing that writes is ever speculative.
 */
export const LOOKUP_TOOLS: ReadonlySet<string> = new Set(['memory_search', 'memory_get', 'Glob', 'Grep', 'Read']);

const LOOKUP_NAMES = [...LOOKUP_TOOLS].join(', ');

export const DISCARD_TOOL: ToolSpec = {
  name: 'discard',
  description: `Throw away your last lookup (${LOOKUP_NAMES}) when its result was no use: the call and its result `
    + 'leave your context, and you ask a different question. Only works straight after the lookup.',
  parameters: { type: 'object', properties: {} },
};

const FORCE = { type: 'boolean', description: 'Run a lookup you discarded earlier anyway' };

/** A lookup tool as offered: with the `force` argument a refused repeat is told to use. */
export function withForce(tool: ToolSpec): ToolSpec {
  if (!LOOKUP_TOOLS.has(tool.name)) return tool;
  const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>;
  return { ...tool, parameters: { ...tool.parameters, type: 'object', properties: { ...properties, force: FORCE } } };
}

/**
 * One request, however it was typed. `force` is not part of the question. A
 * ranked memory search is the same search in any case, spacing or term order.
 * Everything else is taken exactly as written: a space changes what a regular
 * expression or a glob matches, and refusing a lookup that was never run is
 * worse than running one twice.
 */
export function lookupKey(name: string, args: Record<string, unknown>): string {
  const normal: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) if (key !== 'force') normal[key] = args[key];
  if (name === 'memory_search' && typeof normal.query === 'string' && normal.regex !== true) {
    normal.query = normal.query.trim().toLowerCase().split(/\s+/).sort().join(' ');
  }
  return createHash('sha1').update(`${name}\n${JSON.stringify(normal)}`).digest('hex');
}

const MAX_TRIED_CHARS = 120;

/** A lookup as the discard note names it. */
export function describeLookup(name: string, args: Record<string, unknown>): string {
  const text = `${name}(${JSON.stringify(args)})`;
  return text.length > MAX_TRIED_CHARS ? `${text.slice(0, MAX_TRIED_CHARS)}…` : text;
}

/** Repeats listed in a refusal; a model that keeps asking is told how many came before. */
const MAX_REPEATS_SHOWN = 5;

const clock = (at: Date): string => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

/** Clock time and age together: small models are poor at subtracting times. */
function stamp(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const age = minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes} min ago`
      : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
  return `${clock(new Date(at))} (${age})`;
}

interface Discarded {
  at: number;
  /** When the newest repeats were refused. */
  repeats: number[];
  /** Repeats before those: counted, their times dropped. */
  earlier: number;
}

export class DiscardTable {
  private readonly entries = new Map<string, Discarded>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The lookup was run and thrown away. A second discard of it keeps the first time. */
  discard(key: string): void {
    if (!this.entries.has(key)) this.entries.set(key, { at: this.now().getTime(), repeats: [], earlier: 0 });
  }

  /** A lookup about to run: the refusal when it was discarded before (and this repeat is recorded), else nothing. */
  reject(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now().getTime();
    const { repeats, earlier } = entry;
    const lines = [
      'Not run: you discarded this lookup.',
      `First run and discarded: ${stamp(entry.at, now)}`,
      ...(repeats.length
        ? [`Asked again and rejected: ${earlier ? `${earlier} earlier, then ` : ''}${repeats.map((at) => stamp(at, now)).join(', ')}`]
        : []),
      `Now: ${clock(new Date(now))}. If things may have changed since, call again with "force": true.`,
    ];
    repeats.push(now);
    if (repeats.length > MAX_REPEATS_SHOWN) { repeats.shift(); entry.earlier++; }
    return lines.join('\n');
  }

  /** The model insisted: the lookup runs, and is an ordinary lookup again. */
  release(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
