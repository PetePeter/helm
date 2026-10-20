/**
 * SchedulerSection component tests.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SchedulerSection from '../../../renderer/components/sidebar/SchedulerSection.vue';

const mockScheduledTaskList = vi.fn();
const mockOffChanged = vi.fn();

const task = {
  id: 'task-1',
  title: 'Daily check',
  planIds: [],
  initialPrompt: 'status',
  cliType: 'codex',
  scheduledTime: new Date(2026, 4, 4, 10, 0, 0),
  dirPath: 'X:\\coding\\gamepad-cli-hub',
  status: 'pending',
  createdAt: Date.now(),
};

describe('SchedulerSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 4, 9, 0, 0));
    mockScheduledTaskList.mockReset().mockResolvedValue([task]);
    mockOffChanged.mockReset();
    (window as any).gamepadCli = {
      scheduledTaskList: mockScheduledTaskList,
      onScheduledTaskChanged: vi.fn(() => mockOffChanged),
    };
  });

  it('does not open edit when the row body is clicked', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    await wrapper.find('.scheduler-row').trigger('click');

    expect(wrapper.emitted('open')).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('shows the total schedule count, including tasks beyond the preview rows', async () => {
    mockScheduledTaskList.mockResolvedValue([
      task,
      { ...task, id: 'task-2', title: 'Second' },
      { ...task, id: 'task-3', title: 'Third' },
      { ...task, id: 'task-4', title: 'Fourth' },
      { ...task, id: 'task-5', title: 'Fifth' },
    ]);

    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    expect(wrapper.find('.scheduler-count-badge').text()).toBe('5');
    expect(wrapper.findAll('.scheduler-row')).toHaveLength(4);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('keeps unscheduled tasks visible after active schedules without treating them as due', async () => {
    mockScheduledTaskList.mockResolvedValue([
      { ...task, id: 'paused', title: 'Paused', scheduleKind: 'none', scheduledTime: new Date(2026, 4, 4, 8, 0, 0) },
      { ...task, id: 'active', title: 'Active', scheduledTime: new Date(2026, 4, 4, 10, 0, 0) },
    ]);

    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    expect(wrapper.findAll('.scheduler-title').map((node) => node.text())).toEqual(['Active', 'Paused']);
    expect(wrapper.findAll('.scheduler-time').map((node) => node.text())).toEqual(['1h 0m', 'off']);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('marks every acting control focusable so the gamepad can walk the pane', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    const focusIds = wrapper.findAll('.focusable').map(el => el.attributes('data-focus-id'));
    expect(focusIds).toEqual([
      'scheduler:new',
      'scheduler:history',
      'scheduler:schedules',
      'scheduler:edit:task-1',
      'scheduler:delete:task-1',
    ]);
    // The inert row body stays out of the focus walk — it has nothing to activate.
    expect(wrapper.find('.scheduler-row').classes()).not.toContain('focusable');

    wrapper.unmount();
    vi.useRealTimers();
  });

  it('opens edit only from the info action', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    await wrapper.find('[aria-label="Edit schedule"]').trigger('click');

    expect(wrapper.emitted('open')).toEqual([['task-1']]);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('emits delete only from the delete action', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    await wrapper.find('[aria-label="Delete schedule"]').trigger('click');

    expect(wrapper.emitted('delete')?.[0]?.[0]).toMatchObject({ id: 'task-1', title: 'Daily check' });
    expect(wrapper.emitted('open')).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('emits open with null from the main split-button segment', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    await wrapper.find('.scheduler-create--main').trigger('click');

    expect(wrapper.emitted('open')).toEqual([[null]]);
    expect(wrapper.emitted('history')).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('emits history when the 🕘 segment is clicked', async () => {
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    await wrapper.find('.scheduler-create--hist').trigger('click');

    expect(wrapper.emitted('history')?.length).toBe(1);
    expect(wrapper.emitted('open')).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('does not render system dreaming rows in the scheduler pane', async () => {
    mockScheduledTaskList.mockResolvedValue([
      task,
      { ...task, id: 'dream-1', title: 'Memory Dreaming', systemKind: 'dream', enabled: true, userPrompt: '', cliType: 'codex' },
    ]);
    const wrapper = mount(SchedulerSection, { props: { collapsed: false } });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Dreaming');
    expect(wrapper.text()).not.toContain('Run dream now');
    expect(wrapper.find('.scheduler-count-badge').text()).toBe('1');
    wrapper.unmount();
    vi.useRealTimers();
  });
});
