/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { buildStatsChartConfig, formatStatsTooltipLabel, readStatsChartTheme } from '../renderer/components/charts/stats-chart-config.js';
import type { ChartModel } from '../src/session/chart-model.js';

const theme = { text: '#eeeeee', textMuted: '#999999', grid: '#222222', tooltip: '#111111' };

describe('StatsChart configuration', () => {
  it('maps raw token series into one visible-only stack with an automatic value range', () => {
    const model: ChartModel = {
      columns: [1, 2], labels: ['A', 'B'],
      series: [
        { key: 'cli:codex', label: 'Codex', color: '#5aa9ff', type: 'bar', axis: 'tokens', values: [10, 20] },
        { key: 'cli:claude', label: 'Claude', color: '#ccff00', type: 'bar', axis: 'tokens', values: [30, 40] },
      ],
    };

    const config = buildStatsChartConfig(model, 'tokens', theme);

    expect(config.data.labels).toEqual(['A', 'B']);
    expect(config.data.datasets.map(dataset => ({ label: dataset.label, data: dataset.data, stack: dataset.stack }))).toEqual([
      { label: 'Codex', data: [10, 20], stack: 'tokens' },
      { label: 'Claude', data: [30, 40], stack: 'tokens' },
    ]);
    expect(config.options?.scales?.x?.stacked).toBe(true);
    expect(config.options?.scales?.tokens?.stacked).toBe(true);
    expect(config.options?.scales?.tokens?.max).toBeUndefined();
    expect(config.options?.scales?.tokens?.ticks?.color).toBe(theme.textMuted);
    expect(config.options?.plugins?.legend?.display).toBe(true);
    expect(config.options?.plugins?.legend?.labels?.color).toBe(theme.text);
    expect(config.options?.plugins?.tooltip?.backgroundColor).toBe(theme.tooltip);
    expect(config.options?.scales?.x?.grid?.color).toBe(theme.grid);
  });

  it('puts the multiplier line on the left axis and token bars on the right', () => {
    const model: ChartModel = {
      columns: [1], labels: ['A'],
      series: [
        { key: 'multiplier', label: 'AI ×', color: '#ccff00', type: 'line', axis: 'multiplier', values: [2.5] },
        { key: 'tokens', label: 'Tokens', color: '#f0b34a', type: 'bar', axis: 'tokens', values: [1250] },
      ],
    };

    const config = buildStatsChartConfig(model, 'timesheet', theme);

    expect(config.data.datasets.map(dataset => ({ type: dataset.type, label: dataset.label, yAxisID: dataset.yAxisID }))).toEqual([
      { type: 'line', label: 'AI ×', yAxisID: 'multiplier' },
      { type: 'bar', label: 'Tokens', yAxisID: 'tokens' },
    ]);
    expect(config.options?.scales?.x?.stacked).toBe(false);
    expect(config.options?.scales?.multiplier?.position).toBe('left');
    expect(config.options?.scales?.tokens?.position).toBe('right');
    expect(config.options?.scales?.tokens?.display).toBe('auto');
    expect(config.options?.scales?.multiplier?.grid?.color).toBe(theme.grid);
  });

  it('formats tooltip values exactly and reads drawing colors from CSS tokens', () => {
    expect(formatStatsTooltipLabel({ label: 'Claude', axis: 'tokens' }, 1250)).toBe('Claude: 1,250 tokens');
    expect(formatStatsTooltipLabel({ label: 'AI ×', axis: 'multiplier' }, 2.5)).toBe('AI ×: 2.5×');

    const element = document.createElement('div');
    element.style.setProperty('--text-primary', '#e1e1e1');
    element.style.setProperty('--text-secondary', '#909090');
    element.style.setProperty('--border', '#333333');
    element.style.setProperty('--bg-secondary', '#151515');
    expect(readStatsChartTheme(element)).toEqual({ text: '#e1e1e1', textMuted: '#909090', grid: '#333333', tooltip: '#151515' });
  });
});
