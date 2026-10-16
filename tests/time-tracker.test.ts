/** TimeTracker: 5-minute slots credited to the project the user worked in. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimeTracker, SLOT_MS, SUBMIT_WEIGHT, buildTimesheet, buildTokenSheet, summarizeProjects, periodEdges, timesheetToCsv, type SessionWhere } from '../src/session/time-tracker.js';
import { TimePersistence } from '../src/session/time-persistence.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIN = 60_000;
const SUBMIT = SUBMIT_WEIGHT;
/** A Monday, local midnight, so day bucketing is stable in any time zone. */
const DAY0 = new Date(2026, 8, 28).getTime();
const at = (h: number, m: number, s = 0) => DAY0 + h * 60 * MIN + m * MIN + s * 1000;

const SESSIONS: Record<string, SessionWhere> = {
  a1: { projectKey: 'pA', projectName: 'Alpha', dir: 'C:/alpha', cliType: 'claude-code' },
  a2: { projectKey: 'pA', projectName: 'Alpha', dir: 'C:/alpha/sub', cliType: 'codex' },
  b1: { projectKey: 'pB', projectName: 'Beta', dir: 'C:/beta' },
};

let dir: string;
let clock: number;

function tracker() {
  return new TimeTracker({
    persistence: new TimePersistence(dir),
    resolve: id => SESSIONS[id] ?? null,
    now: () => clock,
  });
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-')); clock = at(9, 0); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function userSlots(t: TimeTracker, from = DAY0, to = DAY0 + 24 * 60 * MIN) {
  return t.query(from, to).filter(s => s.kind === 'user');
}

describe('TimeTracker', () => {
  it('counts many inputs inside one slot once, and separate slots each', () => {
    const t = tracker();
    for (const m of [0, 1, 4]) { clock = at(9, m); t.recordUser(SUBMIT, 'a1'); }
    clock = at(9, 12); t.recordUser(SUBMIT, 'a1');
    expect(userSlots(t).map(s => s.start)).toEqual([at(9, 0), at(9, 10)]);
  });

  it('ignores a slot with only a few stray keystrokes, counts one with enough', () => {
    const t = tracker();
    for (let i = 0; i < SUBMIT - 1; i++) t.recordUser(1, 'a1');
    clock = at(9, 5);
    for (let i = 0; i < SUBMIT; i++) t.recordUser(1, 'a1');
    expect(userSlots(t).map(s => s.start)).toEqual([at(9, 5)]);
  });

  it('gives the slot only to a project that passed the noise floor', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1');
    t.recordUser(1, 'b1'); t.recordUser(1, 'b1');
    expect(userSlots(t).map(s => s.projectKey)).toEqual(['pA']);
  });

  it('puts 12:04:59 and 12:05:00 in different slots', () => {
    const t = tracker();
    clock = at(12, 4, 59); t.recordUser(SUBMIT, 'a1');
    clock = at(12, 5, 0); t.recordUser(SUBMIT, 'a1');
    expect(userSlots(t)).toHaveLength(2);
    expect(SLOT_MS).toBe(5 * MIN);
  });

  it('gives a contested slot to the project with the most input, ties to the latest', () => {
    const t = tracker();
    clock = at(9, 0); t.recordUser(SUBMIT, 'a1'); t.recordUser(SUBMIT, 'a1');
    clock = at(9, 1); t.recordUser(SUBMIT, 'b1');
    clock = at(9, 5); t.recordUser(SUBMIT, 'a1');
    clock = at(9, 6); t.recordUser(SUBMIT, 'b1');
    expect(userSlots(t).map(s => s.projectKey)).toEqual(['pA', 'pB']);
  });

  it('credits the winning project its busiest directory', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1'); t.recordUser(SUBMIT, 'a2'); t.recordUser(SUBMIT, 'a2');
    expect(userSlots(t)[0]).toMatchObject({ projectKey: 'pA', dir: 'C:/alpha/sub' });
  });

  it('does not count AI activity before the session received a prompt (CLI boot)', () => {
    const t = tracker();
    t.setAiActive('a1', true);
    clock = at(9, 6); t.tick();
    expect(t.query(DAY0, DAY0 + 24 * 60 * MIN)).toEqual([]);
    t.armAi('a1');
    clock = at(9, 7); t.tick();
    expect(t.query(DAY0, DAY0 + 24 * 60 * MIN).map(s => [s.kind, s.start])).toEqual([['ai', at(9, 5)]]);
  });

  it("arms AI time on the user's own input too", () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1');
    t.setAiActive('a1', true);
    expect(t.query(DAY0, DAY0 + 24 * 60 * MIN).map(s => s.kind).sort()).toEqual(['ai', 'user']);
  });

  it('credits input outside a terminal (planner, artifacts) to where it happened', () => {
    const t = tracker();
    t.recordUserAt(SUBMIT, { projectKey: 'pB', projectName: 'Beta', dir: 'C:/beta/plans' });
    expect(userSlots(t)[0]).toMatchObject({ projectKey: 'pB', dir: 'C:/beta/plans' });
  });

  it('records AI activity per project as its own kind, never as user time', () => {
    const t = tracker();
    t.recordAi('a1'); t.recordAi('a2'); t.recordAi('b1');
    const slots = t.query(DAY0, DAY0 + 24 * 60 * MIN);
    expect(slots.filter(s => s.kind === 'ai').map(s => s.projectKey).sort()).toEqual(['pA', 'pB']);
    expect(userSlots(t)).toEqual([]);
  });

  it('keeps crediting AI slots while a session stays active, until it goes quiet', () => {
    const t = tracker();
    t.armAi('a1');
    t.setAiActive('a1', true);
    clock = at(9, 6); t.tick();
    clock = at(9, 11); t.tick();
    t.setAiActive('a1', false);
    clock = at(9, 16); t.tick();
    expect(t.query(DAY0, DAY0 + 24 * 60 * MIN).filter(s => s.kind === 'ai').map(s => s.start))
      .toEqual([at(9, 0), at(9, 5), at(9, 10)]);
  });

  it('forgets an active session once it can no longer be placed (closed)', () => {
    const sessions: Record<string, SessionWhere> = { ...SESSIONS };
    const t = new TimeTracker({ persistence: new TimePersistence(dir), resolve: id => sessions[id] ?? null, now: () => clock });
    t.armAi('a1');
    t.setAiActive('a1', true);
    delete sessions.a1;
    clock = at(9, 6); t.tick();
    sessions.a1 = SESSIONS.a1; // the same id restored later starts idle
    clock = at(9, 11); t.tick();
    expect(t.query(DAY0, DAY0 + 24 * 60 * MIN).map(s => s.start)).toEqual([at(9, 0)]);
  });

  it('ignores sessions it cannot place', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'ghost');
    expect(userSlots(t)).toEqual([]);
  });

  it('persists closed slots and reloads them in a fresh tracker', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1');
    clock = at(9, 7); t.recordUser(SUBMIT, 'b1');
    t.flush();
    expect(userSlots(tracker()).map(s => s.projectKey)).toEqual(['pA', 'pB']);
  });

  it('skips a corrupt line instead of failing the month', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1');
    t.flush();
    const file = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'))!;
    fs.appendFileSync(path.join(dir, file), '{not json\n');
    expect(userSlots(tracker())).toHaveLength(1);
  });

  it('writes each slot into the file of the month it started in', () => {
    const t = tracker();
    clock = new Date(2026, 9, 31, 23, 58).getTime(); t.recordUser(SUBMIT, 'a1');
    clock = new Date(2026, 10, 1, 0, 1).getTime(); t.recordUser(SUBMIT, 'a1');
    t.flush();
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl']);
  });
});

describe('buildTimesheet', () => {
  it('sums one project into dir x day rows of minutes', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'a1'); t.recordAi('a1');
    clock = at(9, 5); t.recordUser(SUBMIT, 'a2');
    clock = at(9, 10); t.recordUser(SUBMIT, 'b1');
    clock = at(33, 0); t.recordUser(SUBMIT, 'a1');
    t.flush();
    const edges = periodEdges('day', DAY0);
    const sheet = buildTimesheet(t.query(edges[0], edges[7]), 'pA', edges);
    expect(sheet.columns).toHaveLength(7);
    expect(sheet.rows).toEqual([
      { dir: 'C:/alpha', user: [5, 5, 0, 0, 0, 0, 0], ai: [5, 0, 0, 0, 0, 0, 0] },
      { dir: 'C:/alpha/sub', user: [5, 0, 0, 0, 0, 0, 0], ai: [0, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(sheet.totals).toEqual({ user: [10, 5, 0, 0, 0, 0, 0], ai: [5, 0, 0, 0, 0, 0, 0], tokens: [0, 0, 0, 0, 0, 0, 0] });
  });

  it('cuts day, week and month views on local calendar edges', () => {
    const hour = periodEdges('hour', at(15, 20));
    expect(hour).toEqual(Array.from({ length: 25 }, (_, i) => at(i, 0)));
    const day = periodEdges('day', at(15, 0));
    expect(day).toHaveLength(8);
    expect(new Date(day[0]).getDay()).toBe(1); // weeks start Monday
    expect(day[0]).toBeLessThanOrEqual(at(15, 0));
    const week = periodEdges('week', at(15, 0));
    expect(week[0]).toBeLessThanOrEqual(new Date(2026, 8, 1).getTime());
    expect(week[week.length - 1]).toBeGreaterThanOrEqual(new Date(2026, 9, 1).getTime());
    const month = periodEdges('month', at(15, 0));
    expect(month).toEqual(Array.from({ length: 13 }, (_, i) => new Date(2026, i, 1).getTime()));
  });

  it('totals every project for the phone list, busiest first', () => {
    const t = tracker();
    t.recordUser(SUBMIT, 'b1');
    clock = at(9, 5); t.recordUser(SUBMIT, 'a1'); t.armAi('a1'); t.setAiActive('a1', true);
    clock = at(9, 10); t.recordUser(SUBMIT, 'a2');
    expect(summarizeProjects(t.query(DAY0, DAY0 + 24 * 60 * MIN))).toEqual([
      { projectKey: 'pA', projectName: 'Alpha', user: 10, ai: 5, tokens: 0 },
      { projectKey: 'pB', projectName: 'Beta', user: 5, ai: 0, tokens: 0 },
    ]);
  });

  it('exports CSV with one line per dir and day', () => {
    const sheet = { columns: [DAY0], rows: [{ dir: 'C:/a,b', user: [15], ai: [5] }], totals: { user: [15], ai: [5] } };
    expect(timesheetToCsv(sheet, 'Alpha')).toBe('period_start,project,directory,you_minutes,ai_minutes\n2026-09-28,Alpha,"C:/a,b",15,5\n');
  });
});

describe('TimeTracker tokens', () => {
  const tokens = (t: TimeTracker) => t.query(DAY0, DAY0 + 24 * 60 * MIN).filter(s => s.kind === 'tokens');
  const total = (t: TimeTracker) => tokens(t).reduce((n, s) => n + (s.tokens ?? 0), 0);

  it("takes a session's first reading as the baseline, then adds each rise", () => {
    const t = tracker();
    for (const n of [10_000, 40_000, 90_000]) t.recordTokens('a1', n);
    expect(total(t)).toBe(80_000);
  });

  it("counts a sub-agent's first reading in full, then its rises, apart from the main context", () => {
    const t = tracker();
    t.recordTokens('a1', 10_000);
    t.recordSubagentTokens('a1', 'agent-x', 30_000);
    t.recordSubagentTokens('a1', 'agent-x', 30_000); // re-read: nothing new
    t.recordSubagentTokens('a1', 'agent-x', 45_000);
    t.recordSubagentTokens('a1', 'agent-y', 5_000);
    t.recordTokens('a1', 12_000);
    expect(total(t)).toBe(45_000 + 5_000 + 2_000);
  });

  it('counts only the growth of a sub-agent primed from before a restart', () => {
    const t = tracker();
    t.primeSubagentTokens('a1', 'agent-x', 30_000);
    t.recordSubagentTokens('a1', 'agent-x', 34_000);
    expect(total(t)).toBe(4_000);
  });

  it('adds the post-drop context when it falls (compact, /clear)', () => {
    const t = tracker();
    t.recordTokens('a1', 0);
    t.recordTokens('a1', 199_000);
    t.recordTokens('a1', 50_000);
    expect(total(t)).toBe(249_000);
  });

  it("credits the session's project in the current slot, sessions tracked apart", () => {
    const t = tracker();
    t.recordTokens('a1', 0); t.recordTokens('b1', 0);
    t.recordTokens('a1', 1_000);
    clock = at(9, 7); t.recordTokens('a2', 5); t.recordTokens('a2', 505); t.recordTokens('b1', 300);
    expect(tokens(t).map(s => [s.start, s.projectKey, s.tokens])).toEqual([
      [at(9, 0), 'pA', 1_000], [at(9, 5), 'pA', 500], [at(9, 5), 'pB', 300],
    ]);
  });

  it('sums a slot written at shutdown and again after a restart', () => {
    const first = tracker();
    first.recordTokens('a1', 0); first.recordTokens('a1', 700);
    first.flush();
    const second = tracker();
    second.recordTokens('a1', 100); second.recordTokens('a1', 400);
    expect(total(second)).toBe(1_000);
  });

  it('totals tokens per column across all projects, or for one', () => {
    const t = tracker();
    t.recordTokens('a1', 0); t.recordTokens('b1', 0);
    t.recordTokens('a1', 2_000); t.recordTokens('b1', 3_000);
    t.recordUser(SUBMIT, 'a1');
    const edges = periodEdges('day', DAY0);
    const slots = t.query(edges[0], edges[7]);
    expect(buildTimesheet(slots, 'pA', edges).totals.tokens).toEqual([2_000, 0, 0, 0, 0, 0, 0]);
    const all = buildTimesheet(slots, null, edges);
    expect(all.totals.tokens[0]).toBe(5_000);
    expect(all.totals.user[0]).toBe(5);
    expect(summarizeProjects(slots).map(p => [p.projectKey, p.tokens])).toEqual([['pA', 2_000], ['pB', 3_000]]);
  });
});

describe('buildTokenSheet', () => {
  const edges = periodEdges('day', DAY0);
  const slots = (t: TimeTracker) => t.query(edges[0], edges[7]);

  it('splits tokens per configured CLI per column, sub-agents credited to the parent CLI', () => {
    const t = tracker();
    t.recordTokens('a1', 0); t.recordTokens('a2', 0);
    t.recordTokens('a1', 1_000);
    t.recordSubagentTokens('a1', 'agent-x', 500);
    t.recordTokens('a2', 2_000);
    clock = at(9, 0) + 24 * 60 * MIN;
    t.recordTokens('a1', 1_300);
    const sheet = buildTokenSheet(slots(t), edges, ['claude-code', 'codex']);
    expect(sheet.rows).toEqual([
      { cliType: 'claude-code', label: 'claude-code', tokens: [1_500, 300, 0, 0, 0, 0, 0] },
      { cliType: 'codex', label: 'codex', tokens: [2_000, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(sheet.totals).toEqual([3_500, 300, 0, 0, 0, 0, 0]);
  });

  it('keeps a row of zeros for a configured CLI with no use', () => {
    const sheet = buildTokenSheet([], edges, ['claude-code', 'copilot']);
    expect(sheet.rows.map(r => [r.cliType, r.tokens.every(v => v === 0)])).toEqual([['claude-code', true], ['copilot', true]]);
  });

  it('groups untagged and no-longer-configured CLIs into one "other" row, last', () => {
    const t = tracker();
    t.recordTokens('b1', 0); t.recordTokens('b1', 400); // no cliType (pre-change slot)
    t.recordTokens('a2', 0); t.recordTokens('a2', 100); // codex, since removed
    const sheet = buildTokenSheet(slots(t), edges, ['claude-code']);
    expect(sheet.rows.map(r => [r.cliType, r.tokens[0]])).toEqual([['claude-code', 0], ['other', 500]]);
  });

  it('labels configured rows by display name, "other" stays "other"', () => {
    const t = tracker();
    t.recordTokens('b1', 0); t.recordTokens('b1', 400);
    const names: Record<string, string> = { 'claude-code': 'Claude Code' };
    const sheet = buildTokenSheet(slots(t), edges, ['claude-code'], id => names[id] ?? 'Unknown CLI');
    expect(sheet.rows.map(r => [r.cliType, r.label])).toEqual([['claude-code', 'Claude Code'], ['other', 'other']]);
  });

  it('keeps one token slot per CLI in a project slot', () => {
    const t = tracker();
    t.recordTokens('a1', 0); t.recordTokens('a2', 0);
    t.recordTokens('a1', 10); t.recordTokens('a2', 20);
    expect(slots(t).filter(s => s.kind === 'tokens').map(s => [s.projectKey, s.cliType, s.tokens]))
      .toEqual([['pA', 'claude-code', 10], ['pA', 'codex', 20]]);
  });
});
