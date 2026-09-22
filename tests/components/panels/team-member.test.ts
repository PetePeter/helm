/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TeamMember from '../../../renderer/components/panels/TeamMember.vue';

describe('TeamMember', () => {
  it.each([
    ['planning', 'busy'], ['implementing', 'busy'], ['waiting', 'input'],
    ['completed', 'done'], ['idle', 'idle'],
  ] as const)('renders the %s state with its canonical %s desk pose', (state, pose) => {
    const wrapper = mount(TeamMember, { props: { state } });
    expect(wrapper.classes()).toContain(`team-member--${pose}`);
    expect(wrapper.attributes('aria-hidden')).toBe('true');
  });
});
