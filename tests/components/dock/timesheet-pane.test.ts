/** @vitest-environment jsdom */
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TimesheetPane from '../../../renderer/components/dock/TimesheetPane.vue';
import type { ChartModel } from '../../../src/session/chart-model.js';
import { appState } from '../../../renderer/stores/app.js';
import type { Timesheet } from '../../../src/session/time-tracker.js';

const day = new Date(2026, 8, 28, 9).getTime();
const sheet: Timesheet = {
  columns: [day],
  rows: [{ dir: 'C:/alpha/src', user: [10], ai: [5], tokens: [1_200] }],
  totals: { user: [10], ai: [5], tokens: [1_200] },
};
const chartModel: ChartModel = {
  columns: [day],
  labels: ['Mon 28'],
  series: [
    { key: 'you', label: 'You', color: '#5aa9ff', type: 'bar', axis: 'minutes', values: [10] },
    { key: 'ai', label: 'AI', color: '#4fd08b', type: 'bar', axis: 'minutes', values: [5] },
    { key: 'tokens', label: 'Tokens', color: '#f0b34a', type: 'line', axis: 'tokens', values: [1_200] },
  ],
};
const statsChartStub = {
  props: ['model', 'kind'],
  template: '<div class="stats-chart-stub" :data-kind="kind">{{ model.labels.join(" ") }}</div>',
};

describe('TimesheetPane', () => {
  let query: ReturnType<typeof vi.fn>;
  let csv: ReturnType<typeof vi.fn>;
  let keys: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appState.sessions = [
      { id: 's1', name: 'Alpha session', projectId: 'pA', workingDir: 'C:/alpha' },
      { id: 's2', name: 'Beta session', projectId: 'pB', workingDir: 'C:/beta' },
    ] as any;
    appState.projects = [
      { id: 'pA', name: 'Alpha', canonicalPath: 'C:/alpha', alternatePaths: [] },
      { id: 'pB', name: 'Beta', canonicalPath: 'C:/beta', alternatePaths: [] },
    ];
    appState.activeSessionId = 's1';
    query = vi.fn(async (params: { projectKey?: string }) => params.projectKey
      ? { sheet, chartModel }
      : { sheet, chartModel, projects: [
        { projectKey: 'pA', projectName: 'Alpha', user: 10, ai: 5 },
        { projectKey: 'pB', projectName: 'Beta', user: 5, ai: 0 },
      ] });
    csv = vi.fn().mockResolvedValue('period_start,project,directory,you_minutes,ai_minutes\n');
    keys = vi.fn().mockResolvedValue({ sheet: {
      columns: [day],
      rows: [{ projectKey: 'pA', projectName: 'Alpha', keys: [1200] }],
      totals: [1200],
    } });
    (window as any).helm = { time: { timeQuery: query, timeCsv: csv, timeKeys: keys } };
  });

  it('shows all projects, drills into any project, and ignores selected-session changes', async () => {
    const wrapper = mount(TimesheetPane, { global: { plugins: [createPinia()], stubs: { StatsChart: statsChartStub } } });
    await flushPromises();

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ projectKey: undefined }));
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('Beta');
    expect(wrapper.find('.stats-chart-stub').attributes('data-kind')).toBe('timesheet');
    expect(wrapper.find('.stats-chart-stub').text()).toBe('Mon 28');

    await wrapper.get('button.timesheet-project').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('C:/alpha/src');
    expect(wrapper.findAll('.timesheet-tokens')).toHaveLength(4);
    expect(wrapper.text()).toContain('Tokens 1.2k');
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ projectKey: 'pA' }));

    appState.activeSessionId = 's2';
    await flushPromises();
    expect(query).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('C:/alpha/src');

    const previousCreateUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const previousRevokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await wrapper.findAll('button').find(button => button.text().includes('CSV'))!.trigger('click');
    expect(csv).toHaveBeenCalledWith('pA', 'day', expect.any(Number), 'Alpha');
    click.mockRestore();
    if (previousCreateUrl) Object.defineProperty(URL, 'createObjectURL', previousCreateUrl);
    else delete (URL as Partial<typeof URL>).createObjectURL;
    if (previousRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', previousRevokeUrl);
    else delete (URL as Partial<typeof URL>).revokeObjectURL;

    await wrapper.get('button[aria-label="Back to projects"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Beta');
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ projectKey: undefined }));
    wrapper.unmount();
  });

  it('shows project keypress totals in the Keys tab', async () => {
    const wrapper = mount(TimesheetPane, { global: { plugins: [createPinia()], stubs: { StatsChart: statsChartStub } } });
    await wrapper.findAll('[role="tab"]').find(tab => tab.text().includes('Keys'))!.trigger('click');
    await flushPromises();

    expect(keys).toHaveBeenCalledWith('day', expect.any(Number));
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('1,200');
    expect(wrapper.findAll('.timesheet-table tbody tr')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows a retryable error when the running app has no Keys service yet', async () => {
    (window as any).helm.time.timeKeys = undefined;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(TimesheetPane, { global: { plugins: [createPinia()], stubs: { StatsChart: statsChartStub } } });
    await wrapper.findAll('[role="tab"]').find(tab => tab.text().includes('Keys'))!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Keypresses unavailable');
    expect(wrapper.text()).toContain('Restart Helm');
    expect(wrapper.text()).not.toContain('Loading keypresses');
    (window as any).helm.time.timeKeys = keys;
    await wrapper.findAll('button').find(button => button.text() === 'Retry')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('1,200');
    wrapper.unmount();
    errorLog.mockRestore();
  });
});
