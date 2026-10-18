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
        { key: 'cli:claude', label: 'Claude', color: '#4fd08b', type: 'bar', axis: 'tokens', values: [30, 40] },
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

  it('keeps timesheet bars grouped and maps the token line to its own axis', () => {
    const model: ChartModel = {
      columns: [1], labels: ['A'],
      series: [
        { key: 'you', label: 'You', color: '#5aa9ff', type: 'bar', axis: 'minutes', values: [90] },
        { key: 'ai', label: 'AI', color: '#4fd08b', type: 'bar', axis: 'minutes', values: [30] },
        { key: 'tokens', label: 'Tokens', color: '#f0b34a', type: 'line', axis: 'tokens', values: [1250] },
      ],
    };

    const config = buildStatsChartConfig(model, 'timesheet', theme);

    expect(config.data.datasets.map(dataset => ({ type: dataset.type, label: dataset.label, yAxisID: dataset.yAxisID }))).toEqual([
      { type: 'bar', label: 'You', yAxisID: 'minutes' },
      { type: 'bar', label: 'AI', yAxisID: 'minutes' },
      { type: 'line', label: 'Tokens', yAxisID: 'tokens' },
    ]);
    expect(config.options?.scales?.x?.stacked).toBe(false);
    expect(config.options?.scales?.minutes?.stacked).toBe(false);
    expect(config.options?.scales?.tokens?.position).toBe('right');
    expect(config.options?.scales?.tokens?.display).toBe('auto');
    expect(config.options?.scales?.minutes?.grid?.color).toBe(theme.grid);
  });

  it('formats tooltip values exactly and reads drawing colors from CSS tokens', () => {
    expect(formatStatsTooltipLabel({ label: 'Claude', axis: 'tokens' }, 1250)).toBe('Claude: 1,250 tokens');
    expect(formatStatsTooltipLabel({ label: 'You', axis: 'minutes' }, 90)).toBe('You: 1h30');
    expect(formatStatsTooltipLabel({ label: 'AI', axis: 'minutes' }, 0)).toBe('AI: 0m');

    const element = document.createElement('div');
    element.style.setProperty('--text-primary', '#e1e1e1');
    element.style.setProperty('--text-secondary', '#909090');
    element.style.setProperty('--border', '#333333');
    element.style.setProperty('--bg-secondary', '#151515');
    expect(readStatsChartTheme(element)).toEqual({ text: '#e1e1e1', textMuted: '#909090', grid: '#333333', tooltip: '#151515' });
  });
});
