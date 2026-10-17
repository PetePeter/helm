/**
 * TimeTracker — how long the user worked on each project, in 5-minute slots.
 *
 * A slot is "user" time for exactly one project: the one that got the most
 * user input in it (ties go to the latest). AI activity is tracked as a
 * separate "ai" kind, one per project per slot, because agents genuinely run
 * in parallel. Token use is a third kind, summed per project, CLI, and
 * directory per slot. Each context reading adds its rise; a drop (compact,
 * /clear, quick compact) adds the new, smaller context. Open slots live in
 * memory and are appended to JSONL once they end (or on flush at shutdown).
 * See docs/time-tracking.md.
 */

import type { TimePersistence } from './time-persistence.js';

export const SLOT_MS = 5 * 60_000;
/**
 * Noise floor: a project needs this much input in a slot to earn it. One
 * keystroke weighs 1; a submit (Enter, a phone/Telegram message, a phone
 * edit) weighs the whole floor, so a single deliberate send always counts
 * and a few stray keys never do.
 */
export const SUBMIT_WEIGHT = 20;
const SLOT_MINUTES = SLOT_MS / 60_000;

export type SlotKind = 'user' | 'ai' | 'tokens';

export interface TimeSlot {
  start: number;
  kind: SlotKind;
  projectKey: string;
  projectName: string;
  dir: string;
  /** Kind 'tokens' only. */
  tokens?: number;
  /** Kind 'tokens' only; absent on slots written before it was recorded. */
  cliType?: string;
}

/** Where a session's time is credited. projectKey is the Helm project id, else the dir. */
export interface SessionWhere {
  projectKey: string;
  projectName: string;
  dir: string;
  /** The session's CLI type; only token slots keep it. */
  cliType?: string;
}

interface UserTally { name: string; count: number; last: number; dirs: Map<string, number> }
interface OpenSlot { user: Map<string, UserTally>; ai: Map<string, TimeSlot>; tokens: Map<string, TimeSlot> }

export interface TimeTrackerDeps {
  persistence: Pick<TimePersistence, 'append' | 'load'>;
  resolve: (sessionId: string) => SessionWhere | null;
  now?: () => number;
}

export class TimeTracker {
  private readonly open = new Map<number, OpenSlot>();
  /** Sessions whose current turn is user-originated or has proven agent work. */
  private readonly aiArmed = new Set<string>();
  /** Last context reading per session; the first is only a baseline. */
  private readonly lastTokens = new Map<string, number>();
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly deps: TimeTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  recordUser(weight: number, sessionId: string): boolean {
    const where = this.deps.resolve(sessionId);
    if (!where) return false;
    this.recordUserAt(weight, where);
    return true;
  }

  /** Credit and arm only prompts sent on the user's behalf. System pings need real hook work. */
  recordPrompt(sessionId: string, origin: 'user' | 'system'): void {
    if (origin !== 'user' || !this.recordUser(SUBMIT_WEIGHT, sessionId)) return;
    this.armAi(sessionId);
  }

  /** Terminal keystrokes count as user time; only an accepted Enter starts an AI turn. */
  recordTerminalInput(sessionId: string, data: string): void {
    const submitted = data.includes('\r');
    if (!this.recordUser(submitted ? SUBMIT_WEIGHT : 1, sessionId) || !submitted) return;
    this.armAi(sessionId);
  }

  /** User input that happened outside a session's terminal (planner, artifacts). */
  recordUserAt(weight: number, where: SessionWhere): void {
    const tally = this.slotFor().user;
    const entry = tally.get(where.projectKey) ?? { name: where.projectName, count: 0, last: 0, dirs: new Map() };
    entry.count += weight;
    entry.last = ++this.seq;
    entry.dirs.set(where.dir, (entry.dirs.get(where.dir) ?? 0) + weight);
    tally.set(where.projectKey, entry);
  }

  recordAi(sessionId: string): void {
    const where = this.deps.resolve(sessionId);
    if (!where) return;
    const start = slotStart(this.now());
    const ai = this.slotFor().ai;
    if (!ai.has(where.projectKey)) ai.set(where.projectKey, { start, kind: 'ai', projectKey: where.projectKey, projectName: where.projectName, dir: where.dir });
  }

  /** A context-size reading: a rise adds the growth, a drop adds the new context. */
  recordTokens(sessionId: string, tokens: number): void {
    this.addTokens(sessionId, sessionId, tokens, undefined);
  }

  /**
   * A sub-agent's context reading. Its whole context is new work, so the
   * baseline is zero; each sub-agent is a stream of its own beside the main one.
   */
  recordSubagentTokens(sessionId: string, agentKey: string, tokens: number): void {
    this.addTokens(sessionId, `${sessionId}#${agentKey}`, tokens, 0);
  }

  /** A sub-agent already counted before Helm started: only its later growth is new. */
  primeSubagentTokens(sessionId: string, agentKey: string, tokens: number): void {
    this.lastTokens.set(`${sessionId}#${agentKey}`, tokens);
  }

  private addTokens(sessionId: string, stream: string, tokens: number, baseline: number | undefined): void {
    const prev = this.lastTokens.get(stream) ?? baseline;
    this.lastTokens.set(stream, tokens);
    if (prev === undefined) return;
    const added = tokens >= prev ? tokens - prev : tokens;
    if (!added) return;
    const where = this.deps.resolve(sessionId);
    if (!where) return;
    const start = slotStart(this.now());
    const map = this.slotFor().tokens;
    const key = tokenKey(where.projectKey, where.cliType, where.dir);
    const slot = map.get(key) ?? { start, kind: 'tokens' as const, ...where, tokens: 0 };
    slot.tokens! += added;
    map.set(key, slot);
  }

  private forgetTokens(sessionId: string): void {
    for (const stream of this.lastTokens.keys()) {
      if (stream === sessionId || stream.startsWith(`${sessionId}#`)) this.lastTokens.delete(stream);
    }
  }

  /** A user prompt or real agent work started a turn. */
  armAi(sessionId: string): void {
    this.aiArmed.add(sessionId);
    this.recordAi(sessionId);
  }

  /** A Stop hook or fallback idle ended the turn. */
  disarmAi(sessionId: string): void {
    this.aiArmed.delete(sessionId);
  }

  /** Credit open turns and persist slots that have ended. Call at least once per slot. */
  tick(): void {
    for (const id of this.aiArmed) {
      // A closed session never reports a turn end; drop it once it cannot be placed.
      if (!this.deps.resolve(id)) { this.aiArmed.delete(id); this.forgetTokens(id); }
      else this.recordAi(id);
    }
    this.closeBefore(slotStart(this.now()));
  }

  /** Persist every open slot, ended or not. Call at shutdown. */
  flush(): void {
    this.closeBefore(Infinity);
  }

  /** Slots starting in [from, to), persisted plus still open. */
  query(from: number, to: number): TimeSlot[] {
    const all = [...this.deps.persistence.load(from, to)];
    for (const [start, slot] of this.open) {
      if (start >= from && start < to) all.push(...resolveSlot(start, slot));
    }
    // A slot flushed at shutdown and reopened after restart is written twice:
    // time is presence, so the latest wins; tokens are disjoint partials, so they sum.
    const unique = new Map<string, TimeSlot>();
    for (const s of all) {
      const key = s.kind === 'user' ? `u${s.start}` : `${s.kind}${s.start}|${s.kind === 'tokens' ? tokenKey(s.projectKey, s.cliType, s.dir) : s.projectKey}`;
      const seen = unique.get(key);
      unique.set(key, s.kind === 'tokens' && seen ? { ...s, tokens: (seen.tokens ?? 0) + (s.tokens ?? 0) } : s);
    }
    return [...unique.values()].sort((a, b) => a.start - b.start);
  }

  private slotFor(): OpenSlot {
    const start = slotStart(this.now());
    this.closeBefore(start);
    let slot = this.open.get(start);
    if (!slot) {
      slot = { user: new Map(), ai: new Map(), tokens: new Map() };
      this.open.set(start, slot);
    }
    return slot;
  }

  private closeBefore(limit: number): void {
    const closed: TimeSlot[] = [];
    for (const [start, slot] of this.open) {
      if (start >= limit) continue;
      closed.push(...resolveSlot(start, slot));
      this.open.delete(start);
    }
    if (closed.length) this.deps.persistence.append(closed);
  }
}

function tokenKey(projectKey: string, cliType: string | undefined, dir: string): string {
  return `${projectKey}|${cliType ?? ''}|${dir}`;
}

function slotStart(ms: number): number {
  return ms - (ms % SLOT_MS);
}

function maxKey<T>(map: Map<string, T>, score: (v: T) => [number, number]): string | null {
  let best: string | null = null;
  let bestScore: [number, number] = [0, -1];
  for (const [key, v] of map) {
    const s = score(v);
    if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1])) { best = key; bestScore = s; }
  }
  return best;
}

function resolveSlot(start: number, slot: OpenSlot): TimeSlot[] {
  const result: TimeSlot[] = [...slot.ai.values(), ...slot.tokens.values()];
  const projectKey = maxKey(slot.user, t => [t.count >= SUBMIT_WEIGHT ? t.count : -1, t.last]);
  if (projectKey) {
    const tally = slot.user.get(projectKey)!;
    const dir = maxKey(tally.dirs, n => [n, 0])!;
    result.push({ start, kind: 'user', projectKey, projectName: tally.name, dir });
  }
  return result;
}

// ── Timesheet ────────────────────────────────────────────────────────

export type TimesheetPeriod = 'hour' | 'day' | 'week' | 'month';

export interface TimesheetRow { dir: string; user: number[]; ai: number[]; tokens: number[] }

export interface Timesheet {
  /** Start of each column (local time, ms). */
  columns: number[];
  rows: TimesheetRow[];
  totals: { user: number[]; ai: number[]; tokens: number[] };
}

/**
 * Column edges (n+1 values) for a view around `anchor`, on local calendar
 * boundaries: 'hour' = the 24 hours of its day, 'day' = the 7 days of its Monday week, 'week' = the Monday
 * weeks covering its month, 'month' = the 12 months of its year.
 */
export function periodEdges(period: TimesheetPeriod, anchor: number): number[] {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  if (period === 'hour') {
    return Array.from({ length: 25 }, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), i).getTime());
  }
  if (period === 'month') {
    return Array.from({ length: 13 }, (_, i) => new Date(d.getFullYear(), i, 1).getTime());
  }
  if (period === 'day') {
    const monday = mondayOf(d);
    return Array.from({ length: 8 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i).getTime());
  }
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const cursor = mondayOf(new Date(d.getFullYear(), d.getMonth(), 1));
  const edges = [cursor.getTime()];
  while (edges[edges.length - 1] < monthEnd) {
    cursor.setDate(cursor.getDate() + 7);
    edges.push(cursor.getTime());
  }
  return edges;
}

function mondayOf(d: Date): Date {
  const offset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

/**
 * Minutes and tokens per directory and column for one project (null = every
 * project). Rows sorted by dir.
 */
export function buildTimesheet(slots: TimeSlot[], projectKey: string | null, edges: number[]): Timesheet {
  const n = edges.length - 1;
  const zeros = () => new Array<number>(n).fill(0);
  const rows = new Map<string, TimesheetRow>();
  const totals = { user: zeros(), ai: zeros(), tokens: zeros() };
  for (const slot of slots) {
    if (projectKey !== null && slot.projectKey !== projectKey) continue;
    const col = columnOf(edges, slot.start);
    if (col < 0) continue;
    let row = rows.get(slot.dir);
    if (!row) { row = { dir: slot.dir, user: zeros(), ai: zeros(), tokens: zeros() }; rows.set(slot.dir, row); }
    if (slot.kind === 'tokens') {
      row.tokens[col] += slot.tokens ?? 0;
      totals.tokens[col] += slot.tokens ?? 0;
      continue;
    }
    row[slot.kind][col] += SLOT_MINUTES;
    totals[slot.kind][col] += SLOT_MINUTES;
  }
  return {
    columns: edges.slice(0, n),
    rows: [...rows.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
    totals,
  };
}

/** Tokens per CLI per column. */
export interface TokenSheet {
  columns: number[];
  rows: { cliType: string; label: string; tokens: number[] }[];
  totals: number[];
}

export const OTHER_CLI = 'other';

/**
 * Tokens per configured CLI per column, in config order and zero-filled;
 * untagged or no-longer-configured CLIs share one trailing "other" row.
 */
export function buildTokenSheet(slots: TimeSlot[], edges: number[], cliTypes: string[], labelOf: (cliType: string) => string = id => id): TokenSheet {
  const n = edges.length - 1;
  const rows = new Map(cliTypes.map(cliType => [cliType, new Array<number>(n).fill(0)]));
  const totals = new Array<number>(n).fill(0);
  for (const slot of slots) {
    if (slot.kind !== 'tokens' || !slot.tokens) continue;
    const col = columnOf(edges, slot.start);
    if (col < 0) continue;
    const cliType = slot.cliType && rows.has(slot.cliType) ? slot.cliType : OTHER_CLI;
    let row = rows.get(cliType);
    if (!row) { row = new Array<number>(n).fill(0); rows.set(cliType, row); }
    row[col] += slot.tokens;
    totals[col] += slot.tokens;
  }
  const other = rows.get(OTHER_CLI);
  rows.delete(OTHER_CLI);
  if (other) rows.set(OTHER_CLI, other);
  return { columns: edges.slice(0, n), rows: [...rows].map(([cliType, tokens]) => ({ cliType, label: cliType === OTHER_CLI ? OTHER_CLI : labelOf(cliType), tokens })), totals };
}

export interface ProjectTotal { projectKey: string; projectName: string; user: number; ai: number; tokens: number }

/** A Time view (desktop pane, phone tab); both shapes carry the shared chart markup. */
export type TimesheetQueryResult =
  | { sheet: Timesheet; chartHtml: string }
  | { projects: ProjectTotal[]; sheet: Timesheet; chartHtml: string };

/** Minutes and tokens per project across the given slots, most user time first. */
export function summarizeProjects(slots: TimeSlot[]): ProjectTotal[] {
  const totals = new Map<string, ProjectTotal>();
  for (const slot of slots) {
    let total = totals.get(slot.projectKey);
    if (!total) { total = { projectKey: slot.projectKey, projectName: slot.projectName, user: 0, ai: 0, tokens: 0 }; totals.set(slot.projectKey, total); }
    if (slot.kind === 'tokens') total.tokens += slot.tokens ?? 0;
    else total[slot.kind] += SLOT_MINUTES;
  }
  return [...totals.values()].sort((a, b) => b.user - a.user || b.ai - a.ai || a.projectName.localeCompare(b.projectName));
}

function columnOf(edges: number[], t: number): number {
  for (let i = 0; i < edges.length - 1; i++) if (t >= edges[i] && t < edges[i + 1]) return i;
  return -1;
}

export function timesheetToCsv(sheet: Pick<Timesheet, 'columns' | 'rows'>, projectName: string): string {
  const lines = ['period_start,project,directory,you_minutes,ai_minutes,tokens'];
  for (const row of sheet.rows) {
    sheet.columns.forEach((col, i) => {
      if (!row.user[i] && !row.ai[i] && !row.tokens[i]) return;
      lines.push([localDate(col), csvField(projectName), csvField(row.dir), row.user[i], row.ai[i], row.tokens[i]].join(','));
    });
  }
  return lines.join('\n') + '\n';
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() ? `${date} ${pad(d.getHours())}:00` : date;
}

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
