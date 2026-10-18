import { describe, expect, it } from 'vitest';
import { buildTimesheetChartModel, buildTokenChartModel } from '../src/session/chart-model.js';
import type { Timesheet, TokenSheet } from '../src/session/time-tracker.js';

const DAY0 = new Date(2026, 8, 28).getTime();
const DAY = 86_400_000;

describe('ChartModel builders', () => {
  it('maps timesheet values as raw bar and line series and clips future columns', () => {
    const sheet: Timesheet = {
      columns: [DAY0, DAY0 + DAY, DAY0 + DAY * 2, DAY0 + DAY * 3],
      rows: [],
      totals: { user: [5, 6, 7, 8], ai: [1, 2, 3, 4], tokens: [10, 20, 30, 40] },
    };

    const model = buildTimesheetChartModel(sheet, 'day', DAY0 + DAY * 2);

    expect(model.columns).toEqual(sheet.columns.slice(0, 3));
    expect(model.labels).toHaveLength(3);
    expect(model.series.map(({ key, type, axis, values }) => ({ key, type, axis, values }))).toEqual([
      { key: 'you', type: 'bar', axis: 'minutes', values: [5, 6, 7] },
      { key: 'ai', type: 'bar', axis: 'minutes', values: [1, 2, 3] },
      { key: 'tokens', type: 'line', axis: 'tokens', values: [10, 20, 30] },
    ]);
  });

  it('keeps token series unstacked, removes zero rows in visible columns, and keeps colors stable by key', () => {
    const sheet: TokenSheet = {
      columns: [DAY0, DAY0 + DAY, DAY0 + DAY * 2],
      rows: [
        { cliType: 'codex', label: 'Codex', tokens: [2, 3, 999] },
        { cliType: 'claude', label: 'Claude', tokens: [5, 7, 888] },
        { cliType: 'unused', label: 'Unused', tokens: [0, 0, 100] },
      ],
      totals: [7, 10, 1_987],
    };
    const reordered = { ...sheet, rows: [...sheet.rows].reverse() };

    const model = buildTokenChartModel(sheet, 'day', DAY0 + DAY);
    const reorderedModel = buildTokenChartModel(reordered, 'day', DAY0 + DAY);
    const colorByKey = (chart: typeof model) => Object.fromEntries(chart.series.map(({ key, color }) => [key, color]));

    expect(model.columns).toEqual(sheet.columns.slice(0, 2));
    expect(model.series.map(({ key, label, type, axis, values }) => ({ key, label, type, axis, values }))).toEqual([
      { key: 'cli:codex', label: 'Codex', type: 'bar', axis: 'tokens', values: [2, 3] },
      { key: 'cli:claude', label: 'Claude', type: 'bar', axis: 'tokens', values: [5, 7] },
    ]);
    expect(colorByKey(model)).toEqual(colorByKey(reorderedModel));
  });

  it('keeps a month-view token model small when serialized for the mobile wire', () => {
    const columns = Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).getTime());
    const rows = Array.from({ length: 32 }, (_, cli) => ({
      cliType: `cli-${cli}`,
      label: `CLI ${cli}`,
      tokens: columns.map((_, month) => (cli + 1) * (month + 1) * 1_000),
    }));
    const totals = columns.map((_, month) => rows.reduce((sum, row) => sum + row.tokens[month], 0));
    const model = buildTokenChartModel({ columns, rows, totals }, 'month', new Date(2027, 0, 1).getTime());

    expect(new TextEncoder().encode(JSON.stringify(model)).length).toBeLessThan(16 * 1024);
  });
});
