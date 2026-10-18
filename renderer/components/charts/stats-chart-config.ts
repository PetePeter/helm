import type { ChartConfiguration, TooltipOptions } from 'chart.js';
import { formatTokens } from '../../../src/session/format-tokens.js';
import type { ChartAxisKind, ChartModel, ChartModelSeries } from '../../../src/session/chart-model.js';
import { formatMinutes } from '../../composables/useTimesheetPane.js';

export type StatsChartKind = 'timesheet' | 'tokens';

export interface StatsChartTheme {
  text: string;
  textMuted: string;
  grid: string;
  tooltip: string;
}

export function buildStatsChartConfig(
  model: ChartModel,
  kind: StatsChartKind,
  theme: StatsChartTheme,
): ChartConfiguration {
  return {
    type: 'bar',
    data: { labels: model.labels, datasets: buildDatasets(model, kind) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: buildPlugins(theme),
      scales: buildScales(kind, theme),
    },
  };
}

function buildDatasets(model: ChartModel, kind: StatsChartKind): ChartConfiguration['data']['datasets'] {
  const stack = kind === 'tokens' ? 'tokens' : undefined;
  return model.series.map(series => ({
    type: series.type,
    label: series.label,
    data: series.values,
    backgroundColor: series.color,
    borderColor: series.color,
    borderWidth: series.type === 'line' ? 2 : 0,
    pointRadius: series.type === 'line' ? 2 : 0,
    tension: series.type === 'line' ? 0.25 : 0,
    yAxisID: series.axis,
    ...(stack ? { stack } : {}),
  }));
}

function buildPlugins(theme: StatsChartTheme): NonNullable<ChartConfiguration['options']>['plugins'] {
  return {
    legend: { display: true, labels: { color: theme.text } },
    tooltip: buildTooltipOptions(theme),
  };
}

function buildTooltipOptions(theme: StatsChartTheme): TooltipOptions {
  return {
    backgroundColor: theme.tooltip,
    titleColor: theme.text,
    bodyColor: theme.text,
    borderColor: theme.grid,
    borderWidth: 1,
    callbacks: {
      title: items => items[0]?.label ?? '',
      label: item => formatStatsTooltipLabel({
        label: item.dataset.label ?? '',
        axis: item.dataset.yAxisID as ChartAxisKind,
      }, Number(item.raw ?? 0)),
    },
  };
}

function buildScales(kind: StatsChartKind, theme: StatsChartTheme): NonNullable<ChartConfiguration['options']>['scales'] {
  const isTokens = kind === 'tokens';
  return {
    x: {
      stacked: isTokens,
      ticks: { color: theme.textMuted, autoSkip: true, maxTicksLimit: 12 },
      grid: { color: theme.grid },
      border: { color: theme.grid },
    },
    minutes: buildMinutesScale(theme, !isTokens),
    tokens: buildTokensScale(theme, isTokens),
  };
}

function buildMinutesScale(theme: StatsChartTheme, display: boolean) {
  return {
    type: 'linear' as const,
    display,
    position: 'left' as const,
    stacked: false,
    ticks: { color: theme.textMuted, callback: (value: string | number) => formatMinuteValue(Number(value)) },
    grid: { color: theme.grid },
    border: { color: theme.grid },
  };
}

function buildTokensScale(theme: StatsChartTheme, isTokens: boolean) {
  return {
    type: 'linear' as const,
    display: isTokens ? true as const : 'auto' as const,
    position: isTokens ? 'left' as const : 'right' as const,
    stacked: isTokens,
    ticks: { color: theme.textMuted, callback: formatCompactTokens },
    grid: { color: theme.grid, drawOnChartArea: isTokens },
    border: { color: theme.grid },
  };
}

export function formatStatsTooltipLabel(series: Pick<ChartModelSeries, 'label' | 'axis'>, value: number): string {
  const formatted = series.axis === 'tokens'
    ? `${formatTokens(value, false)} tokens`
    : formatMinuteValue(value);
  return `${series.label}: ${formatted}`;
}

export function readStatsChartTheme(element: HTMLElement): StatsChartTheme {
  const styles = getComputedStyle(element);
  const rootStyles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim()
    || rootStyles.getPropertyValue(name).trim()
    || 'currentColor';
  return {
    text: token('--text-primary'),
    textMuted: token('--text-secondary'),
    grid: token('--border'),
    tooltip: token('--bg-secondary'),
  };
}

function formatCompactTokens(value: string | number): string {
  return formatTokens(Number(value));
}

function formatMinuteValue(value: number): string {
  return value === 0 ? '0m' : formatMinutes(value);
}
