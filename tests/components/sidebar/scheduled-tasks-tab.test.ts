/**
 * ScheduledTasksTab component tests.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import ScheduledTasksTab from '../../../renderer/components/sidebar/ScheduledTasksTab.vue';
import QuickSpawnModal from '../../../renderer/components/modals/QuickSpawnModal.vue';
import DirPickerModal from '../../../renderer/components/modals/DirPickerModal.vue';
import { FORM_KEYS, useModalStack } from '../../../renderer/composables/useModalStack.js';
import { state } from '../../../renderer/state.js';

/** A cliType id in the post-migration uuid shape. */
const CODEX_UUID = '1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b';

const mockScheduledTaskList = vi.fn();
const mockScheduledTaskCreate = vi.fn();
const mockScheduledTaskUpdate = vi.fn();
const mockScheduledTaskCancel = vi.fn();
const mockConfigGetCliTypes = vi.fn();
const mockConfigGetWorkingDirs = vi.fn();
const mockSessionGetAll = vi.fn();
const mockToolsGetAll = vi.fn();

function localDateTimeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function mountTab() {
  return mount(ScheduledTasksTab, { global: { plugins: [createPinia()] } });
}

describe('ScheduledTasksTab', () => {
  const modalStack = useModalStack();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 29, 9, 15, 0, 0));
    modalStack.clear();
    mockScheduledTaskList.mockReset().mockResolvedValue([]);
    mockScheduledTaskCreate.mockReset().mockResolvedValue({
      id: 'task-new',
      title: 'Task',
      planIds: [],
      initialPrompt: 'Prompt',
      cliType: 'codex',
      scheduledTime: new Date(2026, 3, 29, 10, 0, 0, 0),
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    });
    mockScheduledTaskUpdate.mockReset().mockResolvedValue(null);
    mockScheduledTaskCancel.mockReset().mockResolvedValue(true);
    mockConfigGetCliTypes.mockReset().mockResolvedValue(['codex', 'claude-code']);
    mockConfigGetWorkingDirs.mockReset().mockResolvedValue([
      { name: 'Hub', path: 'X:\\coding\\gamepad-cli-hub' },
    ]);
    mockToolsGetAll.mockReset().mockResolvedValue({
      cliTypes: {
      },
    });
    mockSessionGetAll.mockReset().mockResolvedValue([
      { id: 'sess-1', name: 'main', cliType: 'claude-code', workingDir: 'X:\\coding\\gamepad-cli-hub' },
      { id: 'sess-2', name: 'other', cliType: 'codex', workingDir: 'X:\\other\\project' },
    ]);

    // Path normalization is platform-sensitive and every fixture path here is
    // a Windows path, so pin the platform the renderer sees.
    (window as any).helmPlatform = 'win32';
    state.cliToolsCache = {};
    (window as any).sessionStore = {
      load: mockSessionGetAll,
    };
    (window as any).gamepadCli = {
      scheduledTaskList: mockScheduledTaskList,
      scheduledTaskCreate: mockScheduledTaskCreate,
      scheduledTaskUpdate: mockScheduledTaskUpdate,
      scheduledTaskCancel: mockScheduledTaskCancel,
      configGetCliTypes: mockConfigGetCliTypes,
      configGetWorkingDirs: mockConfigGetWorkingDirs,
      toolsGetAll: mockToolsGetAll,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    modalStack.clear();
  });

  it('shows the CLI display name on the picker button, never the raw uuid', async () => {
    state.cliToolsCache = { [CODEX_UUID]: { displayName: 'Codex CLI' } } as typeof state.cliToolsCache;
    mockConfigGetCliTypes.mockResolvedValue([CODEX_UUID]);

    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();
    wrapper.findComponent(QuickSpawnModal).vm.$emit('select', CODEX_UUID);
    await wrapper.vm.$nextTick();

    const label = wrapper.findAll('.st-picker-btn')[1].text();
    expect(label).toBe('Codex CLI');
    expect(label).not.toContain(CODEX_UUID);
  });

  it('lists target sessions whose workingDir differs only by case or trailing slash', async () => {
    mockSessionGetAll.mockResolvedValue([
      { id: 'sess-1', name: 'main', cliType: 'claude-code', workingDir: 'x:\\coding\\gamepad-cli-hub' },
    ]);

    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub\\');
    await wrapper.vm.$nextTick();

    const modeSelect = wrapper.findAll('select')[0];
    await modeSelect.setValue('direct');
    await flushPromises();

    const options = wrapper.findAll('option').filter((o) => o.attributes('value') === 'sess-1');
    expect(options).toHaveLength(1);
    expect(options[0].text()).toContain('main');
  });

  it('drops a target session that closes while the form is open', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.vm.$nextTick();
    await wrapper.findAll('select')[0].setValue('direct');
    await flushPromises();
    expect(wrapper.findAll('option').some((o) => o.attributes('value') === 'sess-1')).toBe(true);

    mockSessionGetAll.mockResolvedValue([
      { id: 'sess-2', name: 'other', cliType: 'codex', workingDir: 'X:\\other\\project' },
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(wrapper.findAll('option').some((o) => o.attributes('value') === 'sess-1')).toBe(false);
  });

  it('uses configured CLI string keys and a local next-hour datetime default', async () => {
    const wrapper = mountTab();
    await flushPromises();

    await wrapper.find('.st-create-btn').trigger('click');
    // CLI Type picker button is the second picker (Working Dir is first in new order)
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();

    const nextHour = new Date(2026, 3, 29, 10, 0, 0, 0);
    expect((wrapper.find('input[type="datetime-local"]').element as HTMLInputElement).value).toBe(localDateTimeInputValue(nextHour));
    expect(wrapper.findComponent(QuickSpawnModal).props('cliTypes')).toEqual(['codex', 'claude-code']);
  });

  it('requires a selected CLI and submits the selected configured values', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const inputs = wrapper.findAll('.st-input');
    await inputs[0].setValue('Task');
    await wrapper.findAll('textarea')[1].setValue('Prompt');
    await inputs.find((input) => input.attributes('type') === 'datetime-local')?.setValue('2026-04-29T10:00');
    // Working Dir picker is first in new order
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.st-btn--primary').attributes('disabled')).toBeDefined();

    // CLI Type picker is second
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();
    wrapper.findComponent(QuickSpawnModal).vm.$emit('select', 'codex');
    await wrapper.vm.$nextTick();
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Task',
      initialPrompt: 'Prompt',
      cliType: 'codex',
      dirPath: 'X:\\coding\\gamepad-cli-hub',
    }));
  });

  it('preserves literal spaces in the scheduler prompt when creating a task', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const inputs = wrapper.findAll('.st-input');
    await inputs[0].setValue('Task');
    await wrapper.findAll('textarea')[1].setValue('  prompt with spaces  ');
    await inputs.find((input) => input.attributes('type') === 'datetime-local')?.setValue('2026-04-29T10:00');
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();
    wrapper.findComponent(QuickSpawnModal).vm.$emit('select', 'codex');
    await wrapper.vm.$nextTick();

    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: '  prompt with spaces  ',
    }));
  });

  it('opens pending tasks for edit and saves through scheduledTaskUpdate', async () => {
    const task = {
      id: 'task-1',
      title: 'Original',
      planIds: [],
      initialPrompt: 'Original prompt',
      cliType: 'codex',
      scheduledTime: new Date(2026, 3, 29, 11, 0, 0, 0),
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    mockScheduledTaskUpdate.mockResolvedValue({ ...task, title: 'Updated' });
    const wrapper = mountTab();
    await flushPromises();

    await wrapper.find('.st-btn--secondary').trigger('click');
    await wrapper.findAll('.st-input')[0].setValue('Updated');
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({
      title: 'Updated',
      cliType: 'codex',
      dirPath: 'X:\\coding\\gamepad-cli-hub',
    }));
    expect(mockScheduledTaskCreate).not.toHaveBeenCalled();
  });

  it('lets an edited task discard its cadence without sending stale timing fields', async () => {
    const task = {
      id: 'task-1',
      title: 'Recurring task',
      planIds: [],
      initialPrompt: 'Prompt',
      cliType: 'codex',
      scheduledTime: new Date(2026, 3, 29, 11, 0, 0, 0),
      scheduleKind: 'interval',
      intervalMs: 60_000,
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    mockScheduledTaskUpdate.mockResolvedValue({ ...task, scheduleKind: 'none' });
    const wrapper = mount(ScheduledTasksTab, {
      props: { popup: true, initialEditTaskId: 'task-1' },
    });
    await flushPromises();

    const scheduleSelect = wrapper.findAll('select').find((select) =>
      select.findAll('option').some((option) => option.attributes('value') === 'none'),
    )!;
    await scheduleSelect.setValue('none');
    expect(wrapper.find('input[type="datetime-local"]').exists()).toBe(false);
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    const updates = mockScheduledTaskUpdate.mock.calls[0][1];
    expect(updates).toMatchObject({ scheduleKind: 'none' });
    expect(updates).not.toHaveProperty('scheduledTime');
    expect(updates).not.toHaveProperty('intervalMs');
  });

  it('shows an unscheduled task and requires a fresh time before re-enabling it', async () => {
    const task = {
      id: 'task-1',
      title: 'Paused task',
      planIds: [],
      initialPrompt: 'Prompt',
      cliType: 'codex',
      scheduledTime: new Date(2026, 3, 29, 9, 0, 0, 0),
      scheduleKind: 'none',
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    mockScheduledTaskUpdate.mockResolvedValue({ ...task, scheduleKind: 'once' });
    const wrapper = mountTab();
    await flushPromises();

    expect(wrapper.find('.st-task-badge').text()).toBe('Unscheduled');
    expect(wrapper.find('.st-task-countdown').exists()).toBe(false);
    await wrapper.find('.st-btn--secondary').trigger('click');

    const scheduleSelect = wrapper.findAll('select').find((select) =>
      select.findAll('option').some((option) => option.attributes('value') === 'none'),
    )!;
    expect((scheduleSelect.element as HTMLSelectElement).value).toBe('none');
    await scheduleSelect.setValue('once');

    const timeInput = wrapper.find('input[type="datetime-local"]');
    expect((timeInput.element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('.st-btn--primary').attributes('disabled')).toBeDefined();
    await timeInput.setValue('2026-04-29T11:00');
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({
      scheduleKind: 'once',
      scheduledTime: new Date(2026, 3, 29, 11, 0, 0, 0),
    }));
  });

  it('cloning an unscheduled task starts a new one-off schedule with a fresh time', async () => {
    const task = {
      id: 'task-1', title: 'Paused task', planIds: [], initialPrompt: 'Prompt', cliType: 'codex',
      scheduledTime: new Date(2026, 3, 28, 9, 0, 0, 0), scheduleKind: 'none',
      dirPath: 'X:\\coding\\gamepad-cli-hub', status: 'pending', createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    const wrapper = mount(ScheduledTasksTab, { props: { popup: true, initialEditTaskId: task.id } });
    await flushPromises();

    await wrapper.findAll('button').find((button) => button.text() === 'Clone')!.trigger('click');

    const scheduleSelect = wrapper.findAll('select').find((select) =>
      select.findAll('option').some((option) => option.text() === 'Once'),
    )!;
    expect((scheduleSelect.element as HTMLSelectElement).value).toBe('once');
    expect((wrapper.find('input[type="datetime-local"]').element as HTMLInputElement).value).toBe('2026-04-29T10:00');
    wrapper.unmount();
  });

  it('shows feedback when re-enabling an unscheduled task with a past time', async () => {
    const task = {
      id: 'task-1', title: 'Paused task', planIds: [], initialPrompt: 'Prompt', cliType: 'codex',
      scheduledTime: new Date(2026, 3, 28, 9, 0, 0, 0), scheduleKind: 'none',
      dirPath: 'X:\\coding\\gamepad-cli-hub', status: 'pending', createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    const wrapper = mount(ScheduledTasksTab, { props: { popup: true, initialEditTaskId: task.id } });
    await flushPromises();
    await wrapper.findAll('select').find((select) =>
      select.findAll('option').some((option) => option.text() === 'Once'),
    )!.setValue('once');
    await wrapper.find('input[type="datetime-local"]').setValue('2026-04-29T09:00');
    await wrapper.find('.st-btn--primary').trigger('click');

    expect(wrapper.find('[role="alert"]').text()).toMatch(/future/i);
    expect(mockScheduledTaskUpdate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('clones an edited task into a new create payload', async () => {
    const task = {
      id: 'task-1',
      title: 'Original',
      planIds: [],
      initialPrompt: '  Original prompt  ',
      cliType: 'codex',
      cliParams: '--fast',
      scheduledTime: new Date(2026, 3, 29, 11, 0, 0, 0),
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);
    const wrapper = mount(ScheduledTasksTab, {
      props: { popup: true, initialEditTaskId: 'task-1' },
    });
    await flushPromises();

    await wrapper.findAll('button').find((button) => button.text() === 'Clone')!.trigger('click');
    await wrapper.findAll('.st-input')[0].setValue('Clone title');
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Clone title',
      initialPrompt: '  Original prompt  ',
      cliType: 'codex',
      cliParams: '--fast',
      dirPath: 'X:\\coding\\gamepad-cli-hub',
    }));
    expect(mockScheduledTaskUpdate).not.toHaveBeenCalled();
  });

  it('submits interval scheduling options', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const inputs = wrapper.findAll('.st-input');
    await inputs[0].setValue('Recurring');
    await wrapper.findAll('textarea')[1].setValue('Prompt');
    await inputs.find((input) => input.attributes('type') === 'datetime-local')?.setValue('2026-04-29T10:00');
    const scheduleSelect = wrapper.findAll('select').find(s =>
      s.findAll('option').some(o => o.text() === 'Recurring interval'),
    );
    await scheduleSelect!.setValue('interval');
    await wrapper.find('input[type="number"]').setValue('15');
    // Working Dir picker is first, CLI Type picker is second
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();
    wrapper.findComponent(QuickSpawnModal).vm.$emit('select', 'codex');
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.vm.$nextTick();
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      scheduleKind: 'interval',
      intervalMs: 900000,
    }));
  });

  it('submits cron scheduling options from presets with optional end date', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const inputs = wrapper.findAll('.st-input');
    await inputs[0].setValue('Weekday Report');
    await wrapper.findAll('textarea')[1].setValue('Prompt');
    await inputs.find((input) => input.attributes('type') === 'datetime-local')?.setValue('2026-05-04T08:00');
    const scheduleSelect = wrapper.findAll('select').find(s =>
      s.findAll('option').some(o => o.text() === 'Cron calendar'),
    );
    await scheduleSelect!.setValue('cron');
    await wrapper.findAll('.st-preset-btn').find(b => b.text() === 'Weekdays 9am')!.trigger('click');
    await wrapper.find('input[type="date"]').setValue('2026-12-31');
    await wrapper.findAll('.st-picker-btn')[1].trigger('click');
    await flushPromises();
    wrapper.findComponent(QuickSpawnModal).vm.$emit('select', 'codex');
    await wrapper.findAll('.st-picker-btn')[0].trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.vm.$nextTick();
    await wrapper.find('.st-btn--primary').trigger('click');
    await flushPromises();

    expect(mockScheduledTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      scheduleKind: 'cron',
      cronExpression: '0 9 * * 1-5',
      endDate: expect.any(Date),
    }));
  });

  it('disables creation for invalid cron expressions', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const scheduleSelect = wrapper.findAll('select').find(s =>
      s.findAll('option').some(o => o.text() === 'Cron calendar'),
    );
    await scheduleSelect!.setValue('cron');
    await wrapper.findAll('input[type="text"]').at(-1)!.setValue('invalid');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.st-cron-status--invalid').exists()).toBe(true);
    expect(wrapper.find('.st-btn--primary').attributes('disabled')).toBeDefined();
  });

  it('opens the requested task for editing when mounted as a popup', async () => {
    const task = {
      id: 'task-1',
      title: 'Original',
      planIds: [],
      initialPrompt: 'Original prompt',
      cliType: 'codex',
      scheduledTime: new Date(2026, 3, 29, 11, 0, 0, 0),
      dirPath: 'X:\\coding\\gamepad-cli-hub',
      status: 'pending',
      createdAt: Date.now(),
    };
    mockScheduledTaskList.mockResolvedValue([task]);

    const wrapper = mount(ScheduledTasksTab, {
      props: { popup: true, initialEditTaskId: 'task-1' },
    });
    await flushPromises();

    expect((wrapper.findAll('.st-input')[0].element as HTMLInputElement).value).toBe('Original');
    await wrapper.find('.st-btn--secondary').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('opens the create form immediately when mounted as a new-schedule popup', async () => {
    const wrapper = mount(ScheduledTasksTab, {
      props: { popup: true, initialCreate: true },
    });
    await flushPromises();

    expect(wrapper.find('.st-form').exists()).toBe(true);
    expect((wrapper.find('input[type="datetime-local"]').element as HTMLInputElement).value).toBe(
      localDateTimeInputValue(new Date(2026, 3, 29, 10, 0, 0, 0)),
    );
  });

  it('registers popup mode as a form-style modal policy', async () => {
    mount(ScheduledTasksTab, {
      props: { popup: true, initialCreate: true },
    });
    await flushPromises();

    expect(modalStack.topId.value).toBe('scheduler-popup');
    expect([...modalStack.topInterceptKeys.value]).toEqual([...FORM_KEYS]);
  });

  it('loads sessions from the standalone session store on mount', async () => {
    mountTab();
    await flushPromises();

    expect(mockSessionGetAll).toHaveBeenCalled();
  });

  it('populates session picker with matching workingDir sessions in direct mode', async () => {
    const wrapper = mountTab();
    await flushPromises();

    await wrapper.find('.st-create-btn').trigger('click');

    // Switch to direct mode — mode selector is now near the top
    const modeSelect = wrapper.findAll('select').find(s => {
      const opts = s.findAll('option');
      return opts.some(o => o.text() === 'Send to existing session');
    });
    expect(modeSelect).toBeDefined();
    await modeSelect!.setValue('direct');
    await flushPromises();

    // Pick directory
    const dirBtn = wrapper.findAll('.st-picker-btn').find(b => b.text().includes('Select Directory'));
    expect(dirBtn).toBeDefined();
    await dirBtn!.trigger('click');
    await flushPromises();
    wrapper.findComponent(DirPickerModal).vm.$emit('select', 'X:\\coding\\gamepad-cli-hub');
    await wrapper.vm.$nextTick();

    // Session select should have the matching session
    const sessionSelect = wrapper.findAll('select').find(s =>
      s.findAll('option').some(o => o.text().includes('main (claude-code)')),
    );
    expect(sessionSelect).toBeDefined();
  });

  it('hides CLI Type row in direct mode', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    // In spawn mode, CLI Type label is visible
    const labels = () => wrapper.findAll('.st-label').map(l => l.text());

    const modeSelect = wrapper.findAll('select').find(s => {
      const opts = s.findAll('option');
      return opts.some(o => o.text() === 'Send to existing session');
    });
    await modeSelect!.setValue('direct');
    await flushPromises();

    // CLI Type label should not be present in direct mode
    expect(labels()).not.toContain('CLI Type *');
  });

  it('hides CLI Params row in direct mode', async () => {
    const wrapper = mountTab();
    await flushPromises();
    await wrapper.find('.st-create-btn').trigger('click');

    const modeSelect = wrapper.findAll('select').find(s => {
      const opts = s.findAll('option');
      return opts.some(o => o.text() === 'Send to existing session');
    });
    await modeSelect!.setValue('direct');
    await flushPromises();

    const labels = wrapper.findAll('.st-label').map(l => l.text());
    expect(labels).not.toContain('CLI Params (optional)');
  });

});
