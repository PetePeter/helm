// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PlanChip from '../renderer/components/chips/PlanChip.vue';
import ChipActionBar from '../renderer/components/chips/ChipActionBar.vue';
import ChipBar from '../renderer/components/chips/ChipBar.vue';
import { state } from '../renderer/state.js';
import { useChipBarStore } from '../renderer/stores/chip-bar.js';
import { executeSequenceForSession } from '../renderer/bindings.js';

vi.mock('../renderer/stores/draft-editor-registry.js', () => ({
  showPlanInEditor: vi.fn(),
}));

vi.mock('../renderer/bindings.js', () => ({
  executeSequenceForSession: vi.fn(),
}));

describe('Chip components', () => {
  it('puts the human id and textual status on row one and the full title on row two', () => {
    const wrapper = mount(PlanChip, {
      props: { humanId: 'P-0193', title: 'Refine chip bar with a very long title', status: 'coding' },
    });
    const top = wrapper.find('.plan-chip__top');
    expect(top.find('.plan-chip__id').text()).toBe('P-0193');
    expect(top.find('.plan-chip__status').text()).toBe('- coding');
    expect(top.find('.plan-chip__copy').exists()).toBe(true);
    expect(wrapper.find('.plan-chip__title').text()).toBe('Refine chip bar with a very long title');
    expect(wrapper.attributes('title')).toBe('P-0193 Refine chip bar with a very long title');
    expect(wrapper.classes()).toContain('plan-chip--two-line');
  });

  it('derives the status class from the status prop on every update', async () => {
    const wrapper = mount(PlanChip, { props: { humanId: 'P-1', title: 'T', status: 'ready' } });
    expect(wrapper.classes()).toContain('plan-chip--ready');
    await wrapper.setProps({ status: 'coding' });
    expect(wrapper.classes()).toContain('plan-chip--coding');
    expect(wrapper.classes()).not.toContain('plan-chip--ready');
    expect(wrapper.find('.plan-chip__status').text()).toBe('- coding');
  });

  it('shows only the status on row one when there is no human id', () => {
    const wrapper = mount(PlanChip, { props: { title: 'No ref', status: 'blocked' } });
    expect(wrapper.find('.plan-chip__id').exists()).toBe(false);
    expect(wrapper.find('.plan-chip__status').text()).toBe('blocked');
  });

  it('renders action button previews as tooltips with the Alt accelerator', () => {
    const wrapper = mount(ChipActionBar, {
      props: {
        actions: [{ label: 'Apply', sequence: 'run', preview: 'resolved preview' }],
      },
    });
    expect(wrapper.find('button').attributes('title')).toBe('Alt+1 — resolved preview');
  });

  it('hides the chip bar when there are no plan chips or actions', () => {
    const wrapper = mount(ChipBar, {
      props: {
        planChips: [],
        actions: [],
        visible: true,
      },
    });
    expect(wrapper.find('.draft-strip').exists()).toBe(false);
  });
});

describe('useChipBarStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    state.sessions = [
      {
        id: 's1',
        name: 'Session One',
        cliType: 'claude-code',
        processId: 1,
        workingDir: '/repo',
      },
    ];
    state.activeSessionId = 's1';
    state.draftCounts.clear();
    state.planCodingCounts.clear();
    state.planStartableCounts.clear();
    (globalThis as typeof globalThis & { window: any }).window = {
      gamepadCli: {
        planDoingForSession: vi.fn().mockResolvedValue([]),
        planStartableForDir: vi.fn().mockResolvedValue([]),
        configGetChipbarActions: vi.fn().mockResolvedValue({
          actions: [{ label: 'Quick', sequence: 'echo {inboxDir}' }],
          inboxDir: '/inbox',
        }),
      },
    };
  });

  it('caches action config during refresh and reuses inboxDir on click', async () => {
    const store = useChipBarStore();

    await store.refresh('s1');
    expect(window.gamepadCli.configGetChipbarActions).toHaveBeenCalledTimes(1);
    expect(store.actions).toEqual([
      {
        label: 'Quick',
        sequence: 'echo {inboxDir}',
        preview: 'echo /inbox',
      },
    ]);

    await store.triggerAction('echo {inboxDir}');

    expect(window.gamepadCli.configGetChipbarActions).toHaveBeenCalledTimes(1);
    expect(executeSequenceForSession).toHaveBeenCalledWith('s1', 'echo /inbox');
  });

  it('resolves chipbar preview templates case-insensitively', async () => {
    window.gamepadCli.configGetChipbarActions.mockResolvedValue({
      actions: [{ label: 'Quick', sequence: 'echo {INBOXDIR}{ENTER}' }],
      inboxDir: '/inbox',
    });

    const store = useChipBarStore();
    await store.refresh('s1');

    expect(store.actions).toEqual([
      {
        label: 'Quick',
        sequence: 'echo {INBOXDIR}{ENTER}',
        preview: 'echo /inbox{ENTER}',
      },
    ]);
  });
});
