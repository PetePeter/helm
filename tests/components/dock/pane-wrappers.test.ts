/**
 * Pane wrapper tests.
 *
 * These wrappers are the seam between the docking shell and the existing views:
 * they must render their underlying component and forward exactly the events the
 * shell used to handle inline. Children are stubbed because the wrapper — not the
 * view — is the unit under test; the views keep their own suites.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';

import TerminalPane from '../../../renderer/components/dock/TerminalPane.vue';
import TerminalChips from '../../../renderer/components/chips/TerminalChips.vue';
import PlanScreenPane from '../../../renderer/components/dock/PlanScreenPane.vue';
import SessionsPane from '../../../renderer/components/dock/SessionsPane.vue';
import SchedulerPane from '../../../renderer/components/dock/SchedulerPane.vue';
import QuickSpawnPane from '../../../renderer/components/dock/QuickSpawnPane.vue';
import PlanDirectoriesPane from '../../../renderer/components/dock/PlanDirectoriesPane.vue';
import ArtifactsPane from '../../../renderer/components/dock/ArtifactsPane.vue';

import SessionList from '../../../renderer/components/sidebar/SessionList.vue';
import SortBar from '../../../renderer/components/sidebar/SortBar.vue';
import SpawnGrid from '../../../renderer/components/sidebar/SpawnGrid.vue';
import PlansGrid from '../../../renderer/components/sidebar/PlansGrid.vue';
import SchedulerSection from '../../../renderer/components/sidebar/SchedulerSection.vue';
import PlanScreen from '../../../renderer/components/panels/PlanScreen.vue';
import ArtifactViewer from '../../../renderer/components/panels/ArtifactViewer.vue';

import { HELM_PANE_CONTEXT, type HelmPaneContext } from '../../../renderer/dock-pane-context.js';
import { sessionsState } from '../../../renderer/screens/sessions-state.js';
import { appState } from '../../../renderer/stores/app.js';

interface Fake {
  context: HelmPaneContext;
  terminalContainerRef: Ref<HTMLElement | null>;
}

function makeContext(): Fake {
  const terminalContainerRef = ref<HTMLElement | null>(null);
  const sidebar = {
    overviewCollapsedIds: ref(new Set<string>()),
    overviewGroupLabel: ref('Sessions'),
    spawnCollapsed: ref(false),
    plannerCollapsed: ref(false),
    schedulerCollapsed: ref(false),
    historyModalVisible: ref(false),
    getSortField: () => 'name',
    getSortDirection: () => 'asc',
    onSortChange: vi.fn(),
    onSessionClick: vi.fn(),
    onSessionRename: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onRequestClose: vi.fn(),
    onSessionStateChange: vi.fn(),
    onOverviewToggleCollapse: vi.fn(),
    onGroupToggleCollapse: vi.fn(),
    onShowPlans: vi.fn(),
    onShowOverview: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleLock: vi.fn(),
    onCancelSchedule: vi.fn(),
    toggleSpawnCollapse: vi.fn(),
    togglePlannerCollapse: vi.fn(),
    toggleSchedulerCollapse: vi.fn(),
    openSchedulerPopup: vi.fn(),
    openSchedulerHistory: vi.fn(),
    recreateFromHistory: vi.fn(),
    deleteScheduledTask: vi.fn(),
    onSpawn: vi.fn(),
  };
  const planWorkspace = {
    onPlanPopOut: vi.fn(),
    onToggleTypeFilter: vi.fn(),
    onToggleStatusFilter: vi.fn(),
    onResetFilters: vi.fn(),
    onToggleHasAttachmentFilter: vi.fn(),
    onToggleAutoFilter: vi.fn(),
    onToggleRelatedFocus: vi.fn(),
  };
  const context = {
    terminalContainerRef,
    sidebar,
    planWorkspace,
    groups: {
      newGroup: vi.fn(),
      newGroupWithSession: vi.fn(),
      rename: vi.fn(),
      close: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(),
    },
    showArtifactsForSession: vi.fn(),
    popOutArtifacts: vi.fn(),
  } as unknown as HelmPaneContext;
  return { context, terminalContainerRef };
}

function mountPane(component: unknown, context: HelmPaneContext) {
  return mount(component as any, {
    shallow: true,
    global: { provide: { [HELM_PANE_CONTEXT as symbol]: context } },
  });
}

let fake: Fake;
const sidebar = () => fake.context.sidebar as any;
const planWorkspace = () => fake.context.planWorkspace as any;

beforeEach(() => {
  fake = makeContext();
  appState.activeSessionId = null;
  appState.sessions = [];
  appState.projects = [];
  sessionsState.cliTypes = [];
  sessionsState.directories = [];
  // groups/navList are derived getters on the store — they follow from sessions.
  sessionsState.overviewIsGlobal = false;
  sessionsState.overviewGroup = null;
  (window as any).gamepadCli = {
    planList: vi.fn().mockResolvedValue([]),
    planDeps: vi.fn().mockResolvedValue([]),
    planSequenceList: vi.fn().mockResolvedValue([]),
    planContextList: vi.fn().mockResolvedValue([]),
    planAttachmentHasAny: vi.fn().mockResolvedValue({}),
    configGetPlanFilters: vi.fn().mockResolvedValue({}),
    configSetPlanFilters: vi.fn().mockResolvedValue(undefined),
  };
});

describe('pane wrappers render their view', () => {
  it('TerminalPane hands its container element to the shell', () => {
    const wrapper = mountPane(TerminalPane, fake.context);
    const container = wrapper.find('#terminalContainer');
    expect(container.exists()).toBe(true);
    expect(fake.terminalContainerRef.value).toBe(container.element);
    wrapper.unmount();
    expect(fake.terminalContainerRef.value).toBeNull();
  });

  // The chips belong to the terminal, not to a band across the shell, so they
  // travel with the pane wherever the dock puts it.
  it('TerminalPane carries its chip bar inside the pane', () => {
    const wrapper = mountPane(TerminalPane, fake.context);
    expect(wrapper.findComponent(TerminalChips).exists()).toBe(true);
  });

  it('SessionsPane renders the sort bar and the session list', () => {
    const wrapper = mountPane(SessionsPane, fake.context);
    expect(wrapper.findComponent(SortBar).exists()).toBe(true);
    expect(wrapper.findComponent(SessionList).exists()).toBe(true);
    expect(wrapper.find('.recycle-bin-btn').exists()).toBe(true);
  });

  it('PlanScreenPane renders the plan canvas', () => {
    const wrapper = mountPane(PlanScreenPane, fake.context);
    expect(wrapper.findComponent(PlanScreen).exists()).toBe(true);
  });

  // On rehydrate the active session id is restored before the session list
  // carries workingDir, so a watcher on the id alone binds null and never
  // rebinds — the canvas stays empty until an unrelated session is opened.
  it('PlanScreenPane binds once workingDir arrives after the session id', async () => {
    appState.activeSessionId = 's-hydrating';
    appState.sessions = [];
    const wrapper = mountPane(PlanScreenPane, fake.context);
    await nextTick();
    expect(wrapper.findComponent(PlanScreen).props('dirPath')).toBe('');

    appState.sessions = [{ id: 's-hydrating', workingDir: 'X:/rehydrated' }] as any;
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.findComponent(PlanScreen).props('dirPath')).toBe('X:/rehydrated');
  });

  it('PlanScreenPane does not refetch when the session list is replaced with equal values', async () => {
    appState.activeSessionId = 's-1';
    appState.sessions = [{ id: 's-1', workingDir: 'X:/one' }] as any;
    const wrapper = mountPane(PlanScreenPane, fake.context);
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    const callsAfterMount = (window as any).gamepadCli.planList.mock.calls.length;

    appState.sessions = [{ id: 's-1', workingDir: 'X:/one' }] as any;
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.findComponent(PlanScreen).props('dirPath')).toBe('X:/one');
    expect((window as any).gamepadCli.planList.mock.calls.length).toBe(callsAfterMount);
  });

  it('SchedulerPane renders the scheduler section', () => {
    const wrapper = mountPane(SchedulerPane, fake.context);
    expect(wrapper.findComponent(SchedulerSection).exists()).toBe(true);
  });

  it('QuickSpawnPane renders one spawn entry per CLI type', () => {
    sessionsState.cliTypes = ['claude', 'codex'];
    const wrapper = mountPane(QuickSpawnPane, fake.context);
    expect(wrapper.findComponent(SpawnGrid).props('items')).toHaveLength(2);
  });

  it('PlanDirectoriesPane renders all project planner entries without an active session', () => {
    appState.projects = [
      { id: 'p1', name: 'Hub', canonicalPath: 'X:\\coding\\gamepad-cli-hub', alternatePaths: [] },
      { id: 'p2', name: 'Other', canonicalPath: 'X:\\other\\project', alternatePaths: [] },
    ];
    sessionsState.directories = [{ name: 'Standalone', path: 'X:\\standalone' }] as any;
    const wrapper = mountPane(PlanDirectoriesPane, fake.context);
    expect(wrapper.findComponent(PlansGrid).props('directories')).toHaveLength(3);
  });

  it('ArtifactsPane binds the viewer to the active session', () => {
    appState.activeSessionId = 's-42';
    const wrapper = mountPane(ArtifactsPane, fake.context);
    expect(wrapper.findComponent(ArtifactViewer).props('sessionId')).toBe('s-42');
  });

  it('session-scoped panes follow the same selected session after a switch', async () => {
    appState.sessions = [
      { id: 's-1', workingDir: 'X:/one' },
      { id: 's-2', workingDir: 'X:/two' },
    ] as any;
    appState.activeSessionId = 's-1';
    const plan = mountPane(PlanScreenPane, fake.context);
    const artifacts = mountPane(ArtifactsPane, fake.context);

    appState.activeSessionId = 's-2';
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(plan.findComponent(PlanScreen).props('dirPath')).toBe('X:/two');
    expect(artifacts.findComponent(ArtifactViewer).props('sessionId')).toBe('s-2');
    expect(appState.activeSessionId).toBe('s-2');
  });

  it('ArtifactsPane renders nothing without an active session', () => {
    const wrapper = mountPane(ArtifactsPane, fake.context);
    expect(wrapper.findComponent(ArtifactViewer).exists()).toBe(false);
  });
});

describe('pane wrappers preserve the shell event seams', () => {
  it('SessionsPane forwards list actions to the sidebar controller', async () => {
    const wrapper = mountPane(SessionsPane, fake.context);
    const list = wrapper.findComponent(SessionList);

    list.vm.$emit('session-click', 's-1');
    list.vm.$emit('request-close', 's-1');
    list.vm.$emit('toggle-lock', 's-1');
    wrapper.findComponent(SortBar).vm.$emit('change', 'state', 'desc');

    expect(sidebar().onSessionClick).toHaveBeenCalledWith('s-1');
    expect(sidebar().onRequestClose).toHaveBeenCalledWith('s-1');
    expect(sidebar().onToggleLock).toHaveBeenCalledWith('s-1');
    expect(sidebar().onSortChange).toHaveBeenCalledWith('state', 'desc');
  });

  it('SessionsPane routes the artifact badge and group actions to the shell', () => {
    const wrapper = mountPane(SessionsPane, fake.context);
    const list = wrapper.findComponent(SessionList);

    list.vm.$emit('show-artifacts', 's-7');
    list.vm.$emit('group-add-session', 'g-1', 's-7');
    list.vm.$emit('group-remove-session', 's-7');

    expect((fake.context.showArtifactsForSession as any)).toHaveBeenCalledWith('s-7');
    expect((fake.context.groups.addSession as any)).toHaveBeenCalledWith('g-1', 's-7');
    expect((fake.context.groups.removeSession as any)).toHaveBeenCalledWith('s-7');
  });

  it('QuickSpawnPane forwards a spawn request', () => {
    sessionsState.cliTypes = ['claude'];
    const wrapper = mountPane(QuickSpawnPane, fake.context);
    wrapper.findComponent(SpawnGrid).vm.$emit('spawn', 'claude');
    expect(sidebar().onSpawn).toHaveBeenCalledWith('claude');
  });

  it('PlanDirectoriesPane opens the PlanScreen view for the chosen directory', () => {
    sessionsState.directories = [{ name: 'Hub', path: 'X:\\coding\\gamepad-cli-hub' }] as any;
    const wrapper = mountPane(PlanDirectoriesPane, fake.context);
    wrapper.findComponent(PlansGrid).vm.$emit('showPlans', 'X:\\coding\\gamepad-cli-hub');
    expect(sidebar().onShowPlans).toHaveBeenCalledWith('X:\\coding\\gamepad-cli-hub');
  });

  it('SchedulerPane forwards open, delete and history', () => {
    const wrapper = mountPane(SchedulerPane, fake.context);
    const section = wrapper.findComponent(SchedulerSection);

    section.vm.$emit('open', 't-1');
    section.vm.$emit('delete', { id: 't-1' });
    section.vm.$emit('history');

    expect(sidebar().openSchedulerPopup).toHaveBeenCalledWith('t-1');
    expect(sidebar().deleteScheduledTask).toHaveBeenCalledWith({ id: 't-1' });
    expect(sidebar().openSchedulerHistory).toHaveBeenCalled();
  });

  it('PlanScreenPane forwards workspace actions to the plan controller', () => {
    const wrapper = mountPane(PlanScreenPane, fake.context);
    const screen = wrapper.findComponent(PlanScreen);

    screen.vm.$emit('pop-out');
    screen.vm.$emit('reset-filters');

    expect(planWorkspace().onPlanPopOut).toHaveBeenCalled();
    expect(planWorkspace().onResetFilters).toHaveBeenCalled();
  });

  it('ArtifactsPane pops out through the shell so the panel follows its terminal', () => {
    appState.activeSessionId = 's-9';
    const wrapper = mountPane(ArtifactsPane, fake.context);
    wrapper.findComponent(ArtifactViewer).vm.$emit('pop-out');
    expect((fake.context.popOutArtifacts as any)).toHaveBeenCalled();
  });
});
