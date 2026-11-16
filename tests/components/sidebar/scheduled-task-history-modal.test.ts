/**
 * ScheduledTaskHistoryModal component tests.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ScheduledTaskHistoryModal from '../../../renderer/components/sidebar/ScheduledTaskHistoryModal.vue';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import type { ScheduledTaskHistoryEntry } from '../../../src/types/scheduled-task.js';

const mockListHistory = vi.fn();
const mockClearHistory = vi.fn();
const mockOnHistoryChanged = vi.fn();

const DAY = 86_400_000;

function entry(overrides: Partial<ScheduledTaskHistoryEntry>): ScheduledTaskHistoryEntry {
  return {
    id: 'h-' + Math.random().toString(36).slice(2),
    taskId: 'task-1',
    title: 'Nightly audit',
    initialPrompt: 'Run npm outdated and summarise.',
    cliType: 'claude',
    dirPath: 'X:\\coding\\gamepad-cli-hub',
    scheduleKind: 'cron',
    cronExpression: '0 9 * * 1-5',
    mode: 'spawn',
    planIds: [],
    ranAt: Date.now(),
    outcome: 'done',
    ...overrides,
  };
}

describe('ScheduledTaskHistoryModal', () => {
  const modalStack = useModalStack();

  beforeEach(() => {
    modalStack.clear();
    mockClearHistory.mockReset().mockResolvedValue(undefined);
    mockOnHistoryChanged.mockReset().mockReturnValue(() => {});
    mockListHistory.mockReset().mockResolvedValue([
      entry({ id: 'today-done', title: 'Today Done', ranAt: Date.now(), outcome: 'done' }),
      entry({ id: 'yesterday-failed', title: 'Yesterday Failed', ranAt: Date.now() - DAY, outcome: 'failed', error: 'Unknown CLI type' }),
      entry({ id: 'older-cancelled', title: 'Older Cancelled', ranAt: Date.now() - 4 * DAY, outcome: 'cancelled' }),
    ]);
    (window as any).gamepadCli = {
      scheduledTaskListHistory: mockListHistory,
      scheduledTaskClearHistory: mockClearHistory,
      onScheduledTaskHistoryChanged: mockOnHistoryChanged,
    };
  });

  afterEach(() => {
    modalStack.clear();
    delete (window as any).gamepadCli;
    delete (window as any).helm;
    document.body.innerHTML = '';
  });

  it('renders grouped day headers and one row per entry with correct outcome badges', async () => {
    const wrapper = mount(ScheduledTaskHistoryModal, { props: { visible: true }, attachTo: document.body });
    await flushPromises();

    const labels = [...document.querySelectorAll('.sth-day-label')].map((el) => el.textContent?.trim());
    expect(labels[0]).toBe('Today');
    expect(labels[1]).toBe('Yesterday');
    expect(labels.length).toBe(3); // Today, Yesterday, older locale date

    const runs = document.querySelectorAll('.sth-run');
    expect(runs.length).toBe(3);

    expect(document.querySelector('.badge--ok')?.textContent).toBe('Done');
    expect(document.querySelector('.badge--error')?.textContent).toBe('Failed');
    expect(document.querySelector('.scheduled-task-history-status.badge--neutral')?.textContent).toBe('Cancelled');

    wrapper.unmount();
  });

  it('emits recreate with the entry when "Recreate as new" is clicked', async () => {
    const wrapper = mount(ScheduledTaskHistoryModal, { props: { visible: true }, attachTo: document.body });
    await flushPromises();

    const firstRecreate = document.querySelector('.app-button--primary') as HTMLButtonElement;
    firstRecreate.click();
    await flushPromises();

    expect(wrapper.emitted('recreate')).toBeTruthy();
    expect((wrapper.emitted('recreate')![0][0] as ScheduledTaskHistoryEntry).id).toBe('today-done');
    // Closes after recreate.
    expect(wrapper.emitted('update:visible')?.some((e) => e[0] === false)).toBe(true);

    wrapper.unmount();
  });

  it('calls clearHistory and reloads when "Clear history" is clicked', async () => {
    const wrapper = mount(ScheduledTaskHistoryModal, { props: { visible: true }, attachTo: document.body });
    await flushPromises();
    mockListHistory.mockClear();

    const clearBtn = document.querySelector('.sth-clear') as HTMLButtonElement;
    clearBtn.click();
    await flushPromises();

    expect(mockClearHistory).toHaveBeenCalledTimes(1);
    expect(mockListHistory).toHaveBeenCalled();

    wrapper.unmount();
  });

  it('shows an empty state when there is no history', async () => {
    mockListHistory.mockResolvedValue([]);
    const wrapper = mount(ScheduledTaskHistoryModal, { props: { visible: true }, attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('No past schedules in the last 7 days');

    wrapper.unmount();
  });
});
