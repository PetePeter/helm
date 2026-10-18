import type { Timesheet, TimesheetPeriod, TokenSheet } from './time-tracker.js';

export type ChartSeriesType = 'bar' | 'line';
export type ChartAxisKind = 'minutes' | 'tokens';

/** Transport-neutral chart data. Series values stay raw and unstacked. */
export interface ChartModel {
  columns: number[];
  labels: string[];
  series: ChartModelSeries[];
}

export interface ChartModelSeries {
  key: string;
  label: string;
  color: string;
  type: ChartSeriesType;
  axis: ChartAxisKind;
  values: number[];
}

const COLOR_BY_ROLE = {
  you: '#5aa9ff',
  ai: '#4fd08b',
  tokens: '#f0b34a',
} as const;

const SERIES_PALETTE = [
  COLOR_BY_ROLE.tokens,
  COLOR_BY_ROLE.you,
  COLOR_BY_ROLE.ai,
  '#c58af0',
  '#f07a7a',
  '#5fd3d3',
  '#9aa0a6',
] as const;

/** Stable for a series key, independent of configured row order. */
export function chartSeriesColor(key: string): string {
  if (key in COLOR_BY_ROLE) return COLOR_BY_ROLE[key as keyof typeof COLOR_BY_ROLE];
  let hash = 2_166_136_261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16_777_619);
  return SERIES_PALETTE[(hash >>> 0) % SERIES_PALETTE.length];
}

export function buildTimesheetChartModel(
  sheet: Pick<Timesheet, 'columns' | 'totals'>,
  period: TimesheetPeriod,
  now = Date.now(),
): ChartModel {
  const columns = visibleColumns(sheet.columns, now);
  const count = columns.length;
  const values = [sheet.totals.user, sheet.totals.ai, sheet.totals.tokens].map(series => series.slice(0, count));
  const [you, ai, tokens] = values;

  return {
    columns,
    labels: columns.map(column => columnLabel(period, column)),
    series: [
      { key: 'you', label: 'You', color: chartSeriesColor('you'), type: 'bar', axis: 'minutes', values: you },
      { key: 'ai', label: 'AI', color: chartSeriesColor('ai'), type: 'bar', axis: 'minutes', values: ai },
      { key: 'tokens', label: 'Tokens', color: chartSeriesColor('tokens'), type: 'line', axis: 'tokens', values: tokens },
    ],
  };
}

export function buildTokenChartModel(sheet: TokenSheet, period: TimesheetPeriod, now = Date.now()): ChartModel {
  const columns = visibleColumns(sheet.columns, now);
  const count = columns.length;
  const series = sheet.rows
    .map(row => ({ row, values: row.tokens.slice(0, count) }))
    .filter(({ values }) => values.some(value => value !== 0))
    .map(({ row, values }): ChartModelSeries => ({
      key: `cli:${row.cliType}`,
      label: row.label,
      color: chartSeriesColor(`cli:${row.cliType}`),
      type: 'bar',
      axis: 'tokens',
      values,
    }));

  return { columns, labels: columns.map(column => columnLabel(period, column)), series };
}

function visibleColumns(columns: number[], now: number): number[] {
  const count = Math.max(1, columns.filter(column => column <= now).length);
  return columns.slice(0, count);
}

/** Column heading for a view; shared with tables and chart clients. */
export function columnLabel(period: TimesheetPeriod, start: number): string {
  const date = new Date(start);
  if (period === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`;
  if (period === 'day') return date.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  if (period === 'week') return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return date.toLocaleDateString([], { month: 'short' });
}
