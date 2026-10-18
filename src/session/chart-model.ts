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
const FALLBACK_SATURATION = [55, 70, 85] as const;
const FALLBACK_LIGHTNESS = [35, 45, 55, 65, 75] as const;

/** Assign stable chart colours independent of the configured row order. */
export function chartSeriesColors(keys: readonly string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    const roleColor = COLOR_BY_ROLE[key as keyof typeof COLOR_BY_ROLE];
    if (roleColor) {
      assigned.set(key, roleColor);
      used.add(roleColor);
    }
  }
  for (const key of [...new Set(keys)].sort()) {
    if (assigned.has(key)) continue;
    const color = nextSeriesColor(key, used);
    assigned.set(key, color);
    used.add(color);
  }
  return assigned;
}

/** Stable for a series key when a chart has only one series. */
export function chartSeriesColor(key: string): string {
  return chartSeriesColors([key]).get(key)!;
}

function nextSeriesColor(key: string, used: Set<string>): string {
  const hash = hashSeriesKey(key);
  const start = hash % SERIES_PALETTE.length;
  for (let offset = 0; offset < SERIES_PALETTE.length; offset++) {
    const color = SERIES_PALETTE[(start + offset) % SERIES_PALETTE.length];
    if (!used.has(color)) return color;
  }
  for (const saturation of FALLBACK_SATURATION) {
    for (const lightness of FALLBACK_LIGHTNESS) {
      for (let offset = 0; offset < 360; offset++) {
        const hue = (hash + offset * 137) % 360;
        // Hex, not hsl(): the Android client only accepts #rrggbb.
        const color = hslToHex(hue, saturation, lightness);
        if (!used.has(color)) return color;
      }
    }
  }
  throw new Error('Too many chart series for unique colours');
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100, l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [0, 8, 4].map(n => channel(n).toString(16).padStart(2, '0')).join('');
}

function hashSeriesKey(key: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16_777_619);
  return hash >>> 0;
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
  const rows = sheet.rows.map(row => ({ row, values: row.tokens.slice(0, count) }));
  const colors = chartSeriesColors(rows.map(({ row }) => `cli:${row.cliType}`));
  const series = rows
    .filter(({ values }) => values.some(value => value !== 0))
    .map(({ row, values }): ChartModelSeries => ({
      key: `cli:${row.cliType}`,
      label: row.label,
      color: colors.get(`cli:${row.cliType}`)!,
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
