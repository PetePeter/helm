/** @vitest-environment jsdom */
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TimesheetPane from '../../../renderer/components/dock/TimesheetPane.vue';
import { appState } from '../../../renderer/stores/app.js';
import type { Timesheet } from '../../../src/session/time-tracker.js';

const day = new Date(2026, 8, 28, 9).getTime();
const sheet: Timesheet = {
  columns: [day],
  rows: [{ dir: 'C:/alpha/src', user: [10], ai: [5] }],
  totals: { user: [10], ai: [5] },
};

describe('TimesheetPane', () => {
  let query: ReturnType<typeof vi.fn>;
  let csv: ReturnType<typeof vi.fn>;

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
      ? { sheet }
      : { projects: [
        { projectKey: 'pA', projectName: 'Alpha', user: 10, ai: 5 },
        { projectKey: 'pB', projectName: 'Beta', user: 5, ai: 0 },
      ] });
    csv = vi.fn().mockResolvedValue('period_start,project,directory,you_minutes,ai_minutes\n');
    (window as any).helm = { time: { timeQuery: query, timeCsv: csv } };
  });

  it('shows all projects, drills into any project, and ignores selected-session changes', async () => {
    const wrapper = mount(TimesheetPane, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ projectKey: undefined }));
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('Beta');

    await wrapper.get('button.timesheet-project').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('C:/alpha/src');
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
});
