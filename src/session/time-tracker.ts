/**
 * TimeTracker — how long the user worked on each project, in 5-minute slots.
 *
 * A slot is "user" time for exactly one project: the one that got the most
 * user input in it (ties go to the latest). AI activity is tracked as a
 * separate "ai" kind, one per project per slot, because agents genuinely run
 * in parallel. Open slots live in memory and are appended to JSONL once they
 * end (or on flush at shutdown). See docs/time-tracking.md.
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

export type SlotKind = 'user' | 'ai';

export interface TimeSlot {
  start: number;
  kind: SlotKind;
  projectKey: string;
  projectName: string;
  dir: string;
}

/** Where a session's time is credited. projectKey is the Helm project id, else the dir. */
export interface SessionWhere {
  projectKey: string;
  projectName: string;
  dir: string;
}

interface UserTally { name: string; count: number; last: number; dirs: Map<string, number> }
interface OpenSlot { user: Map<string, UserTally>; ai: Map<string, TimeSlot> }

export interface TimeTrackerDeps {
  persistence: Pick<TimePersistence, 'append' | 'load'>;
  resolve: (sessionId: string) => SessionWhere | null;
  now?: () => number;
}

export class TimeTracker {
  private readonly open = new Map<number, OpenSlot>();
  private readonly aiActive = new Set<string>();
  /** Sessions that have been given a prompt; before that, activity is CLI boot noise. */
  private readonly aiArmed = new Set<string>();
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly deps: TimeTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  recordUser(weight: number, sessionId: string): void {
    const where = this.deps.resolve(sessionId);
    if (!where) return;
    this.armAi(sessionId);
    this.recordUserAt(weight, where);
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
    if (!ai.has(where.projectKey)) ai.set(where.projectKey, { start, kind: 'ai', ...where });
  }

  /** The session was given a prompt: from now on its activity is AI work. */
  armAi(sessionId: string): void {
    this.aiArmed.add(sessionId);
    if (this.aiActive.has(sessionId)) this.recordAi(sessionId);
  }

  /** Follow a session's activity dot: an armed, active session earns an AI slot on every tick. */
  setAiActive(sessionId: string, active: boolean): void {
    if (active) {
      this.aiActive.add(sessionId);
      if (this.aiArmed.has(sessionId)) this.recordAi(sessionId);
    } else {
      this.aiActive.delete(sessionId);
    }
  }

  /** Credit still-active sessions and persist slots that have ended. Call at least once per slot. */
  tick(): void {
    for (const id of this.aiActive) {
      // A closed session never reports going quiet; drop it once it cannot be placed.
      if (!this.deps.resolve(id)) { this.aiActive.delete(id); this.aiArmed.delete(id); }
      else if (this.aiArmed.has(id)) this.recordAi(id);
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
    // A slot flushed at shutdown and reopened after restart is written twice; the latest wins.
    const unique = new Map<string, TimeSlot>();
    for (const s of all) unique.set(s.kind === 'user' ? `u${s.start}` : `a${s.start}|${s.projectKey}`, s);
    return [...unique.values()].sort((a, b) => a.start - b.start);
  }

  private slotFor(): OpenSlot {
    const start = slotStart(this.now());
    this.closeBefore(start);
    let slot = this.open.get(start);
    if (!slot) {
      slot = { user: new Map(), ai: new Map() };
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
  const result: TimeSlot[] = [...slot.ai.values()];
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

export interface TimesheetRow { dir: string; user: number[]; ai: number[] }

export interface Timesheet {
  /** Start of each column (local time, ms). */
  columns: number[];
  rows: TimesheetRow[];
  totals: { user: number[]; ai: number[] };
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

/** Minutes per directory per column for one project. Rows sorted by dir. */
export function buildTimesheet(slots: TimeSlot[], projectKey: string, edges: number[]): Timesheet {
  const n = edges.length - 1;
  const zeros = () => new Array<number>(n).fill(0);
  const rows = new Map<string, TimesheetRow>();
  const totals = { user: zeros(), ai: zeros() };
  for (const slot of slots) {
    if (slot.projectKey !== projectKey) continue;
    const col = columnOf(edges, slot.start);
    if (col < 0) continue;
    let row = rows.get(slot.dir);
    if (!row) { row = { dir: slot.dir, user: zeros(), ai: zeros() }; rows.set(slot.dir, row); }
    row[slot.kind][col] += SLOT_MINUTES;
    totals[slot.kind][col] += SLOT_MINUTES;
  }
  return {
    columns: edges.slice(0, n),
    rows: [...rows.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
    totals,
  };
}

export interface ProjectTotal { projectKey: string; projectName: string; user: number; ai: number }

/** Minutes per project across the given slots, most user time first. */
export function summarizeProjects(slots: TimeSlot[]): ProjectTotal[] {
  const totals = new Map<string, ProjectTotal>();
  for (const slot of slots) {
    let total = totals.get(slot.projectKey);
    if (!total) { total = { projectKey: slot.projectKey, projectName: slot.projectName, user: 0, ai: 0 }; totals.set(slot.projectKey, total); }
    total[slot.kind] += SLOT_MINUTES;
  }
  return [...totals.values()].sort((a, b) => b.user - a.user || b.ai - a.ai || a.projectName.localeCompare(b.projectName));
}

function columnOf(edges: number[], t: number): number {
  for (let i = 0; i < edges.length - 1; i++) if (t >= edges[i] && t < edges[i + 1]) return i;
  return -1;
}

export function timesheetToCsv(sheet: Pick<Timesheet, 'columns' | 'rows'>, projectName: string): string {
  const lines = ['period_start,project,directory,you_minutes,ai_minutes'];
  for (const row of sheet.rows) {
    sheet.columns.forEach((col, i) => {
      if (!row.user[i] && !row.ai[i]) return;
      lines.push([localDate(col), csvField(projectName), csvField(row.dir), row.user[i], row.ai[i]].join(','));
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
