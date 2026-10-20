/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import DreamingTab from '../../../renderer/components/settings/pages/DreamingTab.vue';
import { DEFAULT_DREAM_PROMPT } from '../../../src/types/dreaming.js';

const mocks = vi.hoisted(() => ({
  configGetDreaming: vi.fn(),
  configSetDreaming: vi.fn(),
  configGetCliTypes: vi.fn(),
  scheduledTaskList: vi.fn(),
  scheduledTaskUpdate: vi.fn(),
  scheduledTaskRunNow: vi.fn(),
  projectList: vi.fn(),
  toolsGetAll: vi.fn(),
  onScheduledTaskChanged: vi.fn(),
  onProjectChanged: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    configGetDreaming: mocks.configGetDreaming,
    configSetDreaming: mocks.configSetDreaming,
    configGetCliTypes: mocks.configGetCliTypes,
  },
  schedulerClient: {
    scheduledTaskList: mocks.scheduledTaskList,
    scheduledTaskUpdate: mocks.scheduledTaskUpdate,
    scheduledTaskRunNow: mocks.scheduledTaskRunNow,
  },
  projectsClient: { projectList: mocks.projectList },
  toolsClient: { toolsGetAll: mocks.toolsGetAll },
  eventsClient: {
    onScheduledTaskChanged: mocks.onScheduledTaskChanged,
    onProjectChanged: mocks.onProjectChanged,
  },
}));

const tasks = [
  {
    id: 'dream-alpha', title: 'Memory Dreaming', planIds: [], initialPrompt: '', cliType: 'codex',
    scheduledTime: new Date(2026, 4, 5, 9, 0), nextRunAt: new Date(2026, 4, 5, 9, 0),
    scheduleKind: 'cron', cronExpression: '0 9 * * *', dirPath: 'X:\\coding\\alpha',
    systemKind: 'dream', enabled: true, userPrompt: 'Keep project context brief.', projectId: 'alpha', status: 'pending', createdAt: 1,
  },
  {
    id: 'dream-beta', title: 'Memory Dreaming', planIds: [], initialPrompt: '', cliType: '',
    scheduledTime: new Date(2026, 4, 5, 9, 0), nextRunAt: new Date(2026, 4, 5, 9, 0),
    scheduleKind: 'cron', cronExpression: '0 9 * * *', dirPath: 'X:\\coding\\beta',
    systemKind: 'dream', enabled: false, userPrompt: '', projectId: 'beta', status: 'pending', createdAt: 1,
  },
];

let wrapper: VueWrapper | null = null;

describe('DreamingTab', () => {
  beforeEach(() => {
    mocks.configGetDreaming.mockReset().mockResolvedValue({ success: true, settings: { prompt: DEFAULT_DREAM_PROMPT } });
    mocks.configSetDreaming.mockReset().mockImplementation(async (updates: { prompt?: string }) => ({
      success: true,
      settings: { prompt: updates.prompt?.trim() || DEFAULT_DREAM_PROMPT },
    }));
    mocks.configGetCliTypes.mockReset().mockResolvedValue(['codex', 'claude']);
    mocks.scheduledTaskList.mockReset().mockResolvedValue(tasks.map((task) => ({ ...task })));
    mocks.scheduledTaskUpdate.mockReset().mockResolvedValue({ ok: true });
    mocks.scheduledTaskRunNow.mockReset().mockResolvedValue(true);
    mocks.projectList.mockReset().mockResolvedValue([
      { id: 'alpha', name: 'Alpha', canonicalPath: 'X:\\coding\\alpha' },
      { id: 'beta', name: 'Beta', canonicalPath: 'X:\\coding\\beta' },
    ]);
    mocks.toolsGetAll.mockReset().mockResolvedValue({
      cliTypes: { codex: { displayName: 'Codex' }, claude: { displayName: 'Claude' } },
    });
    mocks.onScheduledTaskChanged.mockReset().mockReturnValue(vi.fn());
    mocks.onProjectChanged.mockReset().mockReturnValue(vi.fn());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('renders project rows and saves each project addendum', async () => {
    wrapper = mount(DreamingTab);
    await flushPromises();

    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('Beta');
    expect(wrapper.get('input[aria-label="Enable dreaming for Alpha"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('input[aria-label="Enable dreaming for Beta"]').attributes('disabled')).toBeDefined();

    await wrapper.get('input[aria-label="Enable dreaming for Alpha"]').setValue(false);
    const addendum = wrapper.get('textarea[aria-label="Prompt additions for Beta"]');
    await addendum.setValue('Keep Beta project context brief.');
    await addendum.trigger('change');
    await flushPromises();

    expect(mocks.scheduledTaskUpdate).toHaveBeenCalledWith('dream-alpha', { enabled: false });
    expect(mocks.scheduledTaskUpdate).toHaveBeenCalledWith('dream-beta', { userPrompt: 'Keep Beta project context brief.' });
  });

  it('updates a project CLI and daily time and can run its dream now', async () => {
    wrapper = mount(DreamingTab);
    await flushPromises();

    await wrapper.get('select[aria-label="Select CLI for Beta"]').setValue('claude');
    await wrapper.get('input[aria-label="Set daily time for Alpha"]').setValue('22:30');
    await flushPromises();

    expect(mocks.scheduledTaskUpdate).toHaveBeenCalledWith('dream-beta', { cliType: 'claude' });
    expect(mocks.scheduledTaskUpdate).toHaveBeenCalledWith('dream-alpha', expect.objectContaining({
      scheduleKind: 'cron',
      cronExpression: '30 22 * * *',
      scheduledTime: expect.any(Date),
    }));

    mocks.scheduledTaskUpdate.mockClear();
    await wrapper.get('button[aria-label="Run dream now for Alpha"]').trigger('click');
    await flushPromises();
    expect(mocks.scheduledTaskRunNow).toHaveBeenCalledWith('dream-alpha');
    expect(mocks.scheduledTaskUpdate).not.toHaveBeenCalled();
  });

  it('applies the global CLI and daily time to every project row', async () => {
    wrapper = mount(DreamingTab);
    await flushPromises();

    await wrapper.get('select[aria-label="Apply CLI to all projects"]').setValue('claude');
    await wrapper.get('input[aria-label="Apply daily time to all projects"]').setValue('22:30');
    await wrapper.findAll('button').find((button) => button.text() === 'Apply to all projects')!.trigger('click');
    await flushPromises();

    expect(mocks.scheduledTaskUpdate).toHaveBeenCalledTimes(2);
    for (const task of tasks) {
      expect(mocks.scheduledTaskUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({
        cliType: 'claude',
        scheduleKind: 'cron',
        cronExpression: '30 22 * * *',
        scheduledTime: expect.any(Date),
      }));
    }
  });

  it('saves the global prompt on change and resets it to the shipped default', async () => {
    wrapper = mount(DreamingTab);
    await flushPromises();

    const prompt = wrapper.get('textarea[aria-label="Global dreaming prompt"]');
    await prompt.setValue('Use the project addendum as extra guidance.');
    await prompt.trigger('change');
    await flushPromises();
    expect(mocks.configSetDreaming).toHaveBeenCalledWith({ prompt: 'Use the project addendum as extra guidance.' });

    await wrapper.findAll('button').find((button) => button.text() === 'Reset to default')!.trigger('click');
    await flushPromises();
    expect(mocks.configSetDreaming).toHaveBeenLastCalledWith({ prompt: '' });
  });
});
