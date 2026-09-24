/**
 * Recursive dock renderer behavior. The registered pane implementations are
 * replaced with a tiny stateful stub so this suite exercises the shell's tree,
 * tab, splitter, rail, and focus contracts without bootstrapping app singletons.
 *
 * @vitest-environment jsdom
 */
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DockWorkspace from '../../../renderer/components/dock/DockWorkspace.vue';
import type { DockWorkspaceLayout } from '../../../renderer/dock-types';
import {
  DOCK_LAYOUT_VERSION,
  PANE_ARTIFACTS,
  PANE_OVERVIEW,
  PANE_PLAN_SCREEN,
  PANE_TERMINAL,
} from '../../../renderer/dock-types';

const PaneStub = defineComponent({
  name: 'PaneStub',
  props: { paneId: { type: String, required: true } },
  setup(props) {
    const visits = ref(0);
    return () => h('div', {
      class: 'pane-stub-content',
      'data-pane-content': props.paneId,
      onClick: () => { visits.value++; },
    }, `${props.paneId}:${visits.value}`);
  },
});

function layout(root: DockWorkspaceLayout['root']): DockWorkspaceLayout {
  return {
    version: DOCK_LAYOUT_VERSION,
    root,
    closed: [],
  };
}

describe('DockWorkspace', () => {
  it('renders recursive splits, docks, tabs, and all tab panes mounted', async () => {
    const wrapper = mount(DockWorkspace, {
      props: { layout: layout({
        type: 'split',
        direction: 'horizontal',
        sizes: [0.65, 0.35],
        children: [
          { type: 'group', tabs: [PANE_TERMINAL, PANE_OVERVIEW], activeTab: PANE_TERMINAL },
          { type: 'dock', side: 'right', mode: 'pinned', child: { type: 'group', tabs: [PANE_ARTIFACTS, PANE_PLAN_SCREEN], activeTab: PANE_ARTIFACTS } },
        ],
      }), focusedPaneId: PANE_TERMINAL, paneComponents: {
        [PANE_TERMINAL]: PaneStub,
        [PANE_OVERVIEW]: PaneStub,
        [PANE_ARTIFACTS]: PaneStub,
        [PANE_PLAN_SCREEN]: PaneStub,
      } },
    });

    expect(wrapper.findAll('.dock-node--split')).toHaveLength(1);
    expect(wrapper.findAll('.dock-node--dock')).toHaveLength(1);
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(4);
    expect(wrapper.findAll('.dock-pane[data-dock-pane-id]')).toHaveLength(4);
    expect(wrapper.find('.dock-pane[data-dock-pane-id="overview"]').attributes('style')).toContain('display: none');

    await wrapper.find('[role="tab"][aria-controls="dock-pane-overview"]').trigger('click');
    expect(wrapper.emitted('focus-pane')?.at(-1)).toEqual([PANE_OVERVIEW, 'tab:overview']);
  });

  it('exposes keyboard tab semantics and an accessible splitter', async () => {
    const wrapper = mount(DockWorkspace, {
      props: { layout: layout({
        type: 'split',
        direction: 'vertical',
        sizes: [0.5, 0.5],
        children: [
          { type: 'group', tabs: [PANE_TERMINAL, PANE_OVERVIEW], activeTab: PANE_TERMINAL },
          { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS },
        ],
      }), focusedPaneId: PANE_TERMINAL, paneComponents: {
        [PANE_TERMINAL]: PaneStub,
        [PANE_OVERVIEW]: PaneStub,
        [PANE_ARTIFACTS]: PaneStub,
      } },
    });

    const splitter = wrapper.find('[role="separator"]');
    expect(splitter.attributes('aria-orientation')).toBe('vertical');
    await wrapper.find('[role="tab"][aria-controls="dock-pane-terminal"]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('focus-pane')?.at(-1)).toEqual([PANE_OVERVIEW, 'tab:overview']);
    await splitter.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.emitted('resize-split')).toBeTruthy();
    expect(wrapper.emitted('resize-split')?.at(-1)?.[1]).toEqual([0.55, 0.45]);
  });

  it('asks the workspace to reveal an autohide dock and to collapse it when focus leaves', async () => {
    const wrapper = mount(DockWorkspace, {
      props: { layout: layout({ type: 'dock', side: 'right', mode: 'autohide', child: { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS } }), focusedPaneId: PANE_TERMINAL, revealedPaneIds: [], paneComponents: {
        [PANE_ARTIFACTS]: PaneStub,
      } },
    });

    const rail = wrapper.find('[data-dock-rail="right"]');
    expect(rail.exists()).toBe(true);
    expect(wrapper.find('.dock-node__content').attributes('style')).toContain('display: none');

    await rail.get(`[data-dock-rail-pane="${PANE_ARTIFACTS}"]`).trigger('click');
    expect(wrapper.emitted('reveal-pane')).toEqual([[PANE_ARTIFACTS]]);

    // Reveal is workspace state, so the rail only asks; the prop drives the DOM.
    await wrapper.setProps({ revealedPaneIds: [PANE_ARTIFACTS] });
    await nextTick();
    expect(wrapper.find('.dock-node__content').attributes('style')).not.toContain('display: none');
    expect(wrapper.find('.dock-node--dock').classes()).not.toContain('dock-node--collapsed');

    await wrapper.find('.dock-node--dock').trigger('focusout', { relatedTarget: document.body });
    expect(wrapper.emitted('autohide-close')).toEqual([[PANE_ARTIFACTS]]);

    await wrapper.setProps({ revealedPaneIds: [] });
    await nextTick();
    expect(wrapper.find('.dock-node__content').attributes('style')).toContain('display: none');
    expect(wrapper.find('.dock-node--dock').classes()).toContain('dock-node--collapsed');
  });

  // The rail used to advertise only the dock's first pane, as a rotated pane id.
  it('gives the rail one icon button per pane in the dock', async () => {
    const wrapper = mount(DockWorkspace, {
      props: {
        layout: layout({
          type: 'dock',
          side: 'right',
          mode: 'autohide',
          child: { type: 'group', tabs: [PANE_ARTIFACTS, PANE_OVERVIEW], activeTab: PANE_ARTIFACTS },
        }),
        focusedPaneId: PANE_TERMINAL,
        revealedPaneIds: [],
        paneComponents: { [PANE_ARTIFACTS]: PaneStub, [PANE_OVERVIEW]: PaneStub },
      },
    });

    const rail = wrapper.get('[data-dock-rail="right"]');
    const buttons = rail.findAll('[data-dock-rail-pane]');
    expect(buttons.map(b => b.attributes('data-dock-rail-pane'))).toEqual([PANE_ARTIFACTS, PANE_OVERVIEW]);
    expect(buttons.map(b => b.attributes('title'))).toEqual(['Artifacts', 'Team View']);

    // Clicking an icon opens that pane, not the dock's first one.
    await buttons[1].trigger('click');
    expect(wrapper.emitted('reveal-pane')).toEqual([[PANE_OVERVIEW]]);
  });

  // A pinned dock has no collapse affordance: its rail rendered as a blank
  // full-width strip at the bottom of left/right docks.
  it('renders no rail for a pinned dock, but keeps rail items for an autohide dock', () => {
    const dock = (mode: 'pinned' | 'autohide') => mount(DockWorkspace, {
      props: {
        layout: layout({
          type: 'dock',
          side: 'left',
          mode,
          child: { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS },
        }),
        focusedPaneId: PANE_TERMINAL,
        revealedPaneIds: [],
        paneComponents: { [PANE_ARTIFACTS]: PaneStub },
      },
    });

    expect(dock('pinned').find('.dock-rail').exists()).toBe(false);
    const autohide = dock('autohide');
    expect(autohide.find(`[data-dock-rail="left"] [data-dock-rail-pane="${PANE_ARTIFACTS}"]`).exists()).toBe(true);
  });

  it('gives a collapsed dock a rail-sized track instead of its split share', async () => {
    const wrapper = mount(DockWorkspace, {
      props: { layout: layout({
        type: 'split',
        direction: 'horizontal',
        sizes: [0.7, 0.3],
        children: [
          { type: 'group', tabs: [PANE_TERMINAL], activeTab: PANE_TERMINAL },
          { type: 'dock', side: 'right', mode: 'autohide', child: { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS } },
        ],
      }), focusedPaneId: PANE_TERMINAL, revealedPaneIds: [], paneComponents: {
        [PANE_TERMINAL]: PaneStub,
        [PANE_ARTIFACTS]: PaneStub,
      } },
    });

    const style = () => wrapper.find('.dock-node--split').attributes('style') ?? '';
    expect(style()).toContain('minmax(96px, 0.7fr) 4px auto');

    await wrapper.setProps({ revealedPaneIds: [PANE_ARTIFACTS] });
    await nextTick();
    expect(style()).toContain('minmax(96px, 0.7fr) 4px minmax(96px, 0.3fr)');
  });

  it('keeps a top-side rail out of the vertical writing mode used by edge rails', () => {
    const wrapper = mount(DockWorkspace, {
      props: { layout: layout({ type: 'dock', side: 'top', mode: 'autohide', child: { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS } }), focusedPaneId: PANE_TERMINAL, revealedPaneIds: [], paneComponents: {
        [PANE_ARTIFACTS]: PaneStub,
      } },
    });

    const dock = wrapper.find('.dock-node--dock');
    expect(dock.classes()).toContain('dock-node--side-top');
    expect(dock.classes()).toContain('dock-node--collapsed');
    expect(wrapper.find('[data-dock-rail="top"]').exists()).toBe(true);
  });
});
