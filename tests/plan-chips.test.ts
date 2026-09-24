/**
 * Plan chips — current component and store behavior.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PlanChip from '../renderer/components/chips/PlanChip.vue';
import ChipBar from '../renderer/components/chips/ChipBar.vue';
import { setPlanEditorOpener, useChipBarStore } from '../renderer/stores/chip-bar.js';
import { state } from '../renderer/state.js';

const mockShowPlanInEditor = vi.fn();
const mockHideDraftEditor = vi.fn();
const mockDeliverBulkText = vi.fn();

vi.mock('../renderer/stores/draft-editor-registry.js', () => ({
  showDraftEditor: vi.fn(),
  hideDraftEditor: (...args: unknown[]) => mockHideDraftEditor(...args),
}));

vi.mock('../renderer/paste-handler.js', () => ({
  deliverBulkText: (...args: unknown[]) => mockDeliverBulkText(...args),
}));

describe('Plan chip components', () => {
  it.each(['planning', 'ready', 'coding', 'review', 'blocked', 'done'] as const)('renders %s as text and as its state class', (status) => {
    const wrapper = mount(PlanChip, { props: { humanId: 'P-9', title: 'Task', status } });
    expect(wrapper.find('.plan-chip__status').text()).toBe(`- ${status}`);
    expect(wrapper.classes()).toContain(`plan-chip--${status}`);
  });

  it('opens the plan on Enter and Space', async () => {
    const wrapper = mount(PlanChip, { props: { humanId: 'P-9', title: 'Task', status: 'ready' } });
    await wrapper.trigger('keydown', { key: 'Enter' });
    await wrapper.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('click')).toHaveLength(2);
  });

  it('renders plan chips through ChipBar and emits planChipClick', async () => {
    const wrapper = mount(ChipBar, {
      props: {
        drafts: [],
        planChips: [
          { id: 'p1', humanId: 'P-0001', title: 'Setup DB', status: 'planning' },
          { id: 'p2', humanId: 'P-0002', title: 'Write API', status: 'coding' },
        ],
        actions: [],
        visible: true,
      },
    });

    const chips = wrapper.findAll('.plan-chip');
    expect(chips).toHaveLength(2);

    await chips[1].trigger('click');
    expect(wrapper.emitted('planChipClick')).toEqual([['p2']]);
  });

  it('copy button emits copy without opening details', async () => {
    const wrapper = mount(PlanChip, { props: { humanId: 'P-3', title: 'Fix login', status: 'ready' } });

    await wrapper.find('.plan-chip__copy').trigger('click');

    expect(wrapper.emitted('copy')).toHaveLength(1);
    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('hides the copy button when there is no human reference', () => {
    const wrapper = mount(PlanChip, { props: { title: 'No ref', status: 'ready' } });
    expect(wrapper.find('.plan-chip__copy').exists()).toBe(false);
  });

  it('ChipBar re-emits planChipCopy with the human reference', async () => {
    const wrapper = mount(ChipBar, {
      props: {
        drafts: [],
        planChips: [{ id: 'p1', humanId: 'P-7', title: 'Setup DB', status: 'coding' }],
        actions: [],
        visible: true,
      },
    });

    await wrapper.find('.plan-chip__copy').trigger('click');
    expect(wrapper.emitted('planChipCopy')).toEqual([['P-7']]);
  });
});

describe('Plan chip store integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    state.sessions = [
      {
        id: 'session-1',
        name: 'My Session',
        cliType: 'claude-code',
        processId: 1,
        workingDir: '/test/dir',
      },
    ];
    state.activeSessionId = 'session-1';
    state.draftCounts.clear();
    state.planCodingCounts.clear();
    state.planStartableCounts.clear();
    setPlanEditorOpener(mockShowPlanInEditor);

    (globalThis as typeof globalThis & { window: any }).window = {
      gamepadCli: {
        draftList: vi.fn().mockResolvedValue([]),
        planDoingForSession: vi.fn().mockResolvedValue([]),
        planGetAllDoingForDir: vi.fn().mockResolvedValue([
          { id: 'blocked-1', title: 'Waiting on API', status: 'blocked', sessionId: 'session-1' },
          { id: 'question-1', title: 'Need answer', status: 'blocked', sessionId: 'session-2' },
        ]),
        planStartableForDir: vi.fn().mockResolvedValue([
          { id: 'start-1', title: 'Ready to start', status: 'ready' },
        ]),
        configGetChipbarActions: vi.fn().mockResolvedValue({ actions: [], inboxDir: '' }),
        planGetItem: vi.fn().mockResolvedValue({
          id: 'start-1',
          title: 'Ready to start',
          description: 'Task desc',
          status: 'ready',
          sessionId: 'session-1',
        }),
        planUpdate: vi.fn().mockResolvedValue(undefined),
        planSetState: vi.fn().mockResolvedValue(undefined),
        planDelete: vi.fn().mockResolvedValue(undefined),
        planComplete: vi.fn().mockResolvedValue(undefined),
        planApply: vi.fn().mockResolvedValue(undefined),
        writeTempContent: vi.fn().mockResolvedValue({ success: true, path: '/tmp/task.txt' }),
      },
    };
  });

  it('refresh includes active and ready plans and updates counts', async () => {
    const store = useChipBarStore();

    await store.refresh('session-1');

    expect(store.plans.map((plan) => plan.status)).toEqual(['blocked', 'blocked', 'ready']);
    expect(state.planCodingCounts.get('session-1')).toBe(2);
    expect(state.planStartableCounts.get('session-1')).toBe(1);
  });

  it('a claimed plan stays coding after switching sessions away and back', async () => {
    const store = useChipBarStore();
    state.sessions.push({ id: 'session-2', name: 'Other', cliType: 'claude-code', processId: 2, workingDir: '/other' });
    window.gamepadCli.planGetAllDoingForDir.mockImplementation(async (dir: string) => (
      dir === '/test/dir' ? [{ id: 'claimed-1', humanId: 'P-1', title: 'Claimed', status: 'coding' }] : []
    ));
    window.gamepadCli.planStartableForDir.mockResolvedValue([]);

    await store.refresh('session-1');
    state.activeSessionId = 'session-2';
    await store.refresh('session-2');
    state.activeSessionId = 'session-1';
    await store.refresh('session-1');

    expect(store.plans).toEqual([expect.objectContaining({ id: 'claimed-1', status: 'coding' })]);
  });

  it('openPlan exposes apply/save callbacks for a ready plan', async () => {
    const store = useChipBarStore();
    window.gamepadCli.planGetAllDoingForDir.mockResolvedValue([]);
    window.gamepadCli.planStartableForDir.mockResolvedValue([
      { id: 'start-1', title: 'Ready to start', status: 'ready' },
    ]);

    await store.refresh('session-1');
    await store.openPlan('start-1');

    expect(mockShowPlanInEditor).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'start-1', status: 'ready' }),
      expect.objectContaining({ onSave: expect.any(Function), onDelete: expect.any(Function) }),
    );
  });

  it('does not assign active session ownership when saving chip plans as review', async () => {
    const store = useChipBarStore();
    await store.refresh('session-1');
    await store.openPlan('start-1');

    const callbacks = mockShowPlanInEditor.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Ready to start',
      description: 'Task desc',
      status: 'review',
    });

    expect(window.gamepadCli.planSetState).toHaveBeenCalledWith('start-1', 'review', undefined);
  });

  it('saves chip plans as done through completion notes', async () => {
    const store = useChipBarStore();
    window.gamepadCli.planGetItem.mockResolvedValue({
      id: 'start-1',
      title: 'Ready to start',
      description: 'Task desc',
      status: 'review',
      sessionId: 'session-1',
    });

    await store.refresh('session-1');
    await store.openPlan('start-1');

    const callbacks = mockShowPlanInEditor.mock.calls[0][2];
    await callbacks.onSave({
      title: 'Ready to start',
      description: 'Task desc',
      status: 'done',
      stateInfo: 'Reviewed and completed',
    });

    expect(window.gamepadCli.planComplete).toHaveBeenCalledWith('start-1', 'Reviewed and completed');
    expect(window.gamepadCli.planSetState).not.toHaveBeenCalled();
  });
});
