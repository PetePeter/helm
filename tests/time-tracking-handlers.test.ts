import { describe, expect, it } from 'vitest';
import { statisticsQuery } from '../src/electron/ipc/time-tracking-handlers.js';
import { TimeTracker, type SessionWhere } from '../src/session/time-tracker.js';

const NOW = new Date(2026, 9, 17, 12).getTime();

function tracker(): TimeTracker {
  const sessions: Record<string, SessionWhere> = {
    helm: { projectKey: 'p1', projectName: 'Helm', dir: 'C:/helm', cliType: 'codex' },
    old: { projectKey: 'p2', projectName: 'Other', dir: 'C:/other', cliType: 'retired-cli' },
  };
  const result = new TimeTracker({
    persistence: { append: () => {}, load: () => [], saveBaselines: () => {}, loadBaselines: () => null },
    resolve: id => sessions[id] ?? null,
    now: () => NOW,
  });
  result.recordUser(20, 'helm');
  result.recordAi('helm');
  result.recordTokens('helm', 0);
  result.recordTokens('helm', 1_500);
  result.recordTokens('old', 0);
  result.recordTokens('old', 400);
  return result;
}

describe('statisticsQuery', () => {
  it('defaults to the existing all-project timesheet shape and carries folder tokens', () => {
    const result = statisticsQuery(tracker(), { period: 'day', anchor: NOW }, ['codex', 'claude'], id => id) as {
      projects: Array<{ projectKey: string; user: number; ai: number; tokens: number }>;
      sheet: { rows: Array<{ dir: string; tokens: number[] }>; totals: { user: number[]; ai: number[]; tokens: number[] } };
      chartModel: { columns: number[]; series: Array<{ key: string; values: number[] }> };
    };

    expect(result.projects).toEqual([
      { projectKey: 'p1', projectName: 'Helm', user: 5, ai: 5, tokens: 1_500 },
      { projectKey: 'p2', projectName: 'Other', user: 0, ai: 0, tokens: 400 },
    ]);
    expect(result.sheet.rows).toEqual([
      { dir: 'C:/helm', user: expect.any(Array), ai: expect.any(Array), tokens: [0, 0, 0, 0, 0, 1_500, 0] },
      { dir: 'C:/other', user: expect.any(Array), ai: expect.any(Array), tokens: [0, 0, 0, 0, 0, 400, 0] },
    ]);
    const visibleColumns = result.chartModel.columns.length;
    expect(result.chartModel.series.map(({ key, values }) => [key, values])).toEqual([
      ['you', result.sheet.totals.user.slice(0, visibleColumns)],
      ['ai', result.sheet.totals.ai.slice(0, visibleColumns)],
      ['tokens', result.sheet.totals.tokens.slice(0, visibleColumns)],
    ]);
  });

  it('returns the configured CLI token sheet, including zero and other rows', () => {
    const result = statisticsQuery(tracker(), { view: 'tokens', period: 'day', anchor: NOW }, ['codex', 'claude'], id => ({ codex: 'Codex', claude: 'Claude Code' }[id] ?? id)) as {
      sheet: { rows: Array<{ cliType: string; label: string; tokens: number[] }>; totals: number[] };
      chartModel: { columns: number[]; series: Array<{ key: string; values: number[] }> };
    };

    expect(result.sheet.rows).toEqual([
      { cliType: 'codex', label: 'Codex', tokens: [0, 0, 0, 0, 0, 1_500, 0] },
      { cliType: 'claude', label: 'Claude Code', tokens: [0, 0, 0, 0, 0, 0, 0] },
      { cliType: 'other', label: 'other', tokens: [0, 0, 0, 0, 0, 400, 0] },
    ]);
    expect(result.sheet.totals).toEqual([0, 0, 0, 0, 0, 1_900, 0]);
    const visibleColumns = result.chartModel.columns.length;
    expect(result.chartModel.series.map(({ key, values }) => [key, values])).toEqual([
      ['cli:codex', result.sheet.rows[0].tokens.slice(0, visibleColumns)],
      ['cli:other', result.sheet.rows[2].tokens.slice(0, visibleColumns)],
    ]);
  });

  it('rejects an unknown view', () => {
    expect(() => statisticsQuery(tracker(), { view: 'models', period: 'day', anchor: NOW }, [], id => id))
      .toThrow('view must be timesheet, tokens or estimates');
  });
});
