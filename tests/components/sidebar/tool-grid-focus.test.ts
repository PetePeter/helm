/**
 * The default tool grids must be reachable by gamepad.
 *
 * `useInputRouter` walks `.focusable` inside the focused dock pane and restores
 * the last position from `data-focus-id`, so a grid button without both is
 * invisible to the D-pad no matter which pane holds focus.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SpawnGrid from '../../../renderer/components/sidebar/SpawnGrid.vue';
import PlansGrid from '../../../renderer/components/sidebar/PlansGrid.vue';

const directory = {
  name: 'Hub',
  path: 'X:\\coding\\gamepad-cli-hub',
  startableCount: 0,
  codingCount: 0,
  blockedCount: 0,
  reviewCount: 0,
  planningCount: 0,
  suggestedCount: 0,
};

describe('tool grid focus contract', () => {
  it('SpawnGrid marks every spawn button focusable with a stable identity', () => {
    const wrapper = mount(SpawnGrid, {
      props: {
        items: [
          { cliType: 'claude', displayName: 'Claude' },
          { cliType: 'codex', displayName: 'Codex' },
        ],
        focusIndex: 0,
        isActive: true,
      },
    });

    const buttons = wrapper.findAll('button.focusable');
    expect(buttons).toHaveLength(2);
    expect(buttons.map(b => b.attributes('data-focus-id'))).toEqual(['spawn:claude', 'spawn:codex']);
  });

  it('SpawnGrid renders the focused item from reactive props', async () => {
    const wrapper = mount(SpawnGrid, {
      props: {
        items: [
          { cliType: 'claude', displayName: 'Claude' },
          { cliType: 'codex', displayName: 'Codex' },
        ],
        focusIndex: 0,
        isActive: true,
      },
    });

    expect(wrapper.findAll('button')[0].classes()).toContain('focused');
    expect(wrapper.findAll('button')[1].classes()).not.toContain('focused');

    await wrapper.setProps({ focusIndex: 1 });
    expect(wrapper.findAll('button')[0].classes()).not.toContain('focused');
    expect(wrapper.findAll('button')[1].classes()).toContain('focused');

    await wrapper.setProps({ isActive: false });
    expect(wrapper.findAll('button').every(button => !button.classes().includes('focused'))).toBe(true);
  });

  it('PlansGrid marks every directory button focusable with a stable identity', () => {
    const wrapper = mount(PlansGrid, {
      props: { directories: [directory], focusIndex: 0, isActive: true },
    });

    const buttons = wrapper.findAll('button.focusable');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attributes('data-focus-id')).toBe('plans:X:\\coding\\gamepad-cli-hub');
  });

  it('PlansGrid renders the focused directory from reactive props', async () => {
    const wrapper = mount(PlansGrid, {
      props: { directories: [directory, { ...directory, path: '/other', name: 'Other' }], focusIndex: 0, isActive: true },
    });

    expect(wrapper.findAll('button')[0].classes()).toContain('focused');
    expect(wrapper.findAll('button')[1].classes()).not.toContain('focused');

    await wrapper.setProps({ focusIndex: 1 });
    expect(wrapper.findAll('button')[0].classes()).not.toContain('focused');
    expect(wrapper.findAll('button')[1].classes()).toContain('focused');

    await wrapper.setProps({ isActive: false });
    expect(wrapper.findAll('button').every(button => !button.classes().includes('focused'))).toBe(true);
  });
});
