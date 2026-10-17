/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ScheduledTask } from '../../../../src/types/scheduled-task.js';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    title: 'Daily check',
    planIds: [],
    initialPrompt: 'status',
    cliType: 'codex',
    scheduledTime: new Date(2026, 0, 2, 12, 0),
    dirPath: '/repo',
    mode: 'direct',
    targetSessionId: 's1',
    status: 'pending',
    createdAt: 0,
    ...overrides,
  };
}

function mountList() {
  return mount(SessionList, {
    props: {
      hasSessions: true,
      groups: [{
        dirPath: '/repo',
        displayName: '/repo',
        collapsed: false,
        sessions: [
          { id: 's1', name: 'worker', cliType: 'codex' },
          { id: 's2', name: 'other', cliType: 'codex' },
        ],
      }],
      directories: [],
      navIndexMap: new Map<string, number>(),
      activeFocus: 'sessions',
      focusedNavItem: null,
      focusColumn: 0,
      activeSessionId: null,
      editingSessionId: null,
      sessionStates: new Map<string, string>(),
      sessionActivityLevels: new Map<string, string>(),
      artifactCounts: new Map<string, number>(),
      workingPlanLabels: new Map<string, string>(),
      workingPlanTooltips: new Map<string, string>(),
      pendingSchedules: new Map<string, string>(),
      snappedOutSessions: new Set<string>(),
      llmNotifications: new Map(),
      getCliDisplayName: (cliType: string) => cliType,
      resolveGroupDisplayName: (dirPath: string) => dirPath,
      sessionElapsedText: () => '',
      sessionShortcutMap: new Map<string, number>(),
    },
    global: { stubs: { SessionGroup: { template: '<div><slot /></div>' } } },
  });
}

describe('SessionList scheduled task indicators', () => {
  function tooltipFor(sessionId: string): string | undefined {
    const icon = wrapper!.find(`[data-session-id="${sessionId}"] .session-status-scheduled-task`);
    return icon.exists() ? icon.attributes('title') : undefined;
  }

  let tasks: ScheduledTask[];
  let listTasks: ReturnType<typeof vi.fn>;
  let taskChanged: ((task: { id: string; title: string; status: string }) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let previousGamepadCli: unknown;
  let wrapper: ReturnType<typeof mountList> | null;

  beforeEach(() => {
    tasks = [];
    taskChanged = null;
    wrapper = null;
    previousGamepadCli = (window as unknown as { gamepadCli?: unknown }).gamepadCli;
    listTasks = vi.fn(async () => tasks);
    unsubscribe = vi.fn();
    const onTaskChanged = (callback: (task: { id: string; title: string; status: string }) => void) => {
      taskChanged = callback;
      return unsubscribe;
    };
    (window as unknown as { gamepadCli: unknown }).gamepadCli = {
      scheduledTaskList: listTasks,
      onScheduledTaskChanged: onTaskChanged,
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    const windowWithApi = window as unknown as { gamepadCli?: unknown };
    if (previousGamepadCli === undefined) delete windowWithApi.gamepadCli;
    else windowWithApi.gamepadCli = previousGamepadCli;
  });

  it('shows the nearest pending direct task for its target session only', async () => {
    const soon = new Date(2026, 0, 2, 10, 0);
    const later = new Date(2026, 0, 2, 11, 0);
    tasks = [
      task({ id: 'later', title: 'Later', nextRunAt: later }),
      task({ id: 'soon', title: 'Soon', nextRunAt: soon }),
      task({ id: 'off', scheduleKind: 'none', nextRunAt: new Date(2026, 0, 2, 9, 0) }),
      task({ id: 'done', status: 'completed' }),
      task({ id: 'spawn', mode: 'spawn' }),
      task({ id: 'other', targetSessionId: 's2', title: 'Other session' }),
    ];
    wrapper = mountList();
    await flushPromises();

    expect(wrapper.get('[data-session-id="s1"] .session-status-scheduled-task').text()).toBe('🕒');
    expect(tooltipFor('s1'))
      .toBe(`Scheduled task: Soon  next ${soon.toLocaleString()}`);
    expect(tooltipFor('s2'))
      .toBe(`Scheduled task: Other session  next ${task({ targetSessionId: 's2' }).scheduledTime.toLocaleString()}`);
  });

  it('keeps the newest task snapshot if an older request resolves last', async () => {
    let resolveInitial: (tasks: ScheduledTask[]) => void = () => {};
    listTasks = vi.fn()
      .mockImplementationOnce(() => new Promise<ScheduledTask[]>((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce([task({ id: 'fresh', title: 'Fresh task' })]);
    const api = (window as unknown as { gamepadCli: { scheduledTaskList: unknown } }).gamepadCli;
    api.scheduledTaskList = listTasks;
    wrapper = mountList();
    expect(listTasks).toHaveBeenCalledOnce();

    const fresh = task({ id: 'fresh', title: 'Fresh task' });
    taskChanged?.({ id: fresh.id, title: fresh.title, status: fresh.status });
    await flushPromises();
    expect(tooltipFor('s1'))
      .toContain('Scheduled task: Fresh task');

    resolveInitial([]);
    await flushPromises();
    expect(tooltipFor('s1'))
      .toContain('Scheduled task: Fresh task');
  });
  it('refreshes indicators after task creation, completion, and deletion events', async () => {
    wrapper = mountList();
    await flushPromises();
    expect(tooltipFor('s1')).toBeUndefined();
    expect(taskChanged).not.toBeNull();

    const created = task({ id: 'created', title: 'Created task' });
    tasks = [created];
    taskChanged?.({ id: created.id, title: created.title, status: created.status });
    await flushPromises();
    expect(tooltipFor('s1'))
      .toContain('Scheduled task: Created task');

    tasks = [{ ...created, status: 'completed' }];
    taskChanged?.({ id: created.id, title: created.title, status: 'completed' });
    await flushPromises();
    expect(tooltipFor('s1')).toBeUndefined();

    tasks = [created];
    taskChanged?.({ id: created.id, title: created.title, status: created.status });
    await flushPromises();
    expect(tooltipFor('s1'))
      .toContain('Scheduled task: Created task');

    tasks = [];
    taskChanged?.({ id: created.id, title: '', status: 'deleted' });
    await flushPromises();
    expect(tooltipFor('s1')).toBeUndefined();

    wrapper.unmount();
    wrapper = null;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
