import type { ChartConfiguration } from 'chart.js';
import { chartSeriesColors } from '../../../src/session/chart-model.js';
import type { EstimateView } from '../../../src/session/eta-stats.js';
import type { StatsChartTheme } from './stats-chart-config.js';

export interface EstimateChartTheme extends StatsChartTheme { accent: string; warning: string }

function axis(theme: StatsChartTheme, title?: string) {
  return {
    ticks: { color: theme.textMuted },
    grid: { color: theme.grid },
    border: { color: theme.grid },
    ...(title ? { title: { display: true, text: title, color: theme.textMuted } } : {}),
  };
}

/** Wheel/pinch zooms, drag pans, never past the data; double-click resets (EstimatesView). */
function zoom(mode: 'x' | 'xy') {
  return {
    pan: { enabled: true, mode },
    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode },
    limits: { x: { min: 'original', max: 'original' }, y: { min: 'original', max: 'original' } },
  } as const;
}

function plugins(theme: StatsChartTheme, legend: boolean, zoomMode: 'x' | 'xy' = 'x') {
  return {
    zoom: zoom(zoomMode),
    legend: { display: legend, labels: { color: theme.text } },
    tooltip: { backgroundColor: theme.tooltip, titleColor: theme.text, bodyColor: theme.text, borderColor: theme.grid, borderWidth: 1 },
  };
}

/** Predicted vs actual minutes, one colour per CLI, unmarked as hollow amber rings, y = x guide. */
export function buildScatterConfig(view: EstimateView, theme: EstimateChartTheme): ChartConfiguration {
  const labels = [...new Set(view.points.filter(p => !p.unmarked).map(p => p.label))];
  const colors = chartSeriesColors(labels);
  const max = Math.max(10, ...view.points.flatMap(p => [p.predictedMin, p.actualMin]));
  const xy = (pts: EstimateView['points']) => pts.map(p => ({ x: p.predictedMin, y: p.actualMin }));
  return {
    type: 'scatter',
    data: {
      datasets: [
        ...labels.map(label => ({
          label,
          data: xy(view.points.filter(p => !p.unmarked && p.label === label)),
          backgroundColor: colors.get(label),
          pointRadius: 4,
        })),
        { label: 'unmarked', data: xy(view.points.filter(p => p.unmarked)), backgroundColor: 'transparent', borderColor: theme.warning, borderWidth: 1.5, pointRadius: 4 },
        { type: 'line', label: 'on target', data: [{ x: 0, y: 0 }, { x: max, y: max }], borderColor: theme.textMuted, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: plugins(theme, true, 'xy'),
      scales: { x: { ...axis(theme, 'predicted (min)'), min: 0 }, y: { ...axis(theme, 'actual (min)'), min: 0 } },
    },
  } as ChartConfiguration;
}

/** How far off finished estimates were (actual ÷ predicted); unmarked is its own amber bar. */
export function buildRatioConfig(view: EstimateView, theme: EstimateChartTheme): ChartConfiguration {
  const { labels, counts, unmarked } = view.histogram;
  return {
    type: 'bar',
    data: {
      labels: [...labels, 'unmarked'],
      datasets: [{
        label: 'estimates',
        data: [...counts, unmarked],
        backgroundColor: [...counts.map(() => theme.accent), theme.warning],
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: plugins(theme, false),
      scales: {
        x: axis(theme, 'actual ÷ predicted'),
        y: { ...axis(theme), beginAtZero: true, ticks: { color: theme.textMuted, precision: 0 } },
      },
    },
  };
}

/** On-time % per period column. */
export function buildTrendConfig(view: EstimateView, theme: EstimateChartTheme): ChartConfiguration {
  return {
    type: 'line',
    data: {
      labels: view.trend.labels,
      datasets: [{
        label: 'on time %',
        data: view.trend.values,
        borderColor: theme.accent,
        backgroundColor: theme.accent,
        borderWidth: 2,
        pointRadius: 3,
        spanGaps: true,
        tension: 0.25,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: plugins(theme, false),
      scales: { x: axis(theme), y: { ...axis(theme), min: 0, max: 100 } },
    },
  };
}
