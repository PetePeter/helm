/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TeamView from '../../../renderer/components/panels/TeamView.vue';
import type { TeamViewProjection } from '../../../renderer/team-view/team-view-projection.js';

const projection: TeamViewProjection = {
  deskCount: 1,
  visibleDeskCount: 1,
  departments: [{
    id: 'alpha', name: 'Alpha', collapsed: false, visibleDeskCount: 1,
    desks: [{
      sessionId: 's1', name: 'Ada', cliType: 'codex', state: 'waiting', waitingReason: 'human',
      terminalTail: ['Need approval'], hidden: false, focusIndex: 0, focusLabel: '^1',
    }],
  }],
};

describe('TeamView', () => {
  it('renders actual state, waiting cue, shortcut, and a passive clipped tail', () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    expect(wrapper.text()).toContain('waiting · human');
    expect(wrapper.text()).toContain('^1');
    expect(wrapper.find('.team-desk__monitor').text()).toContain('Need approval');
    expect(wrapper.find('textarea, input, [contenteditable="true"]').exists()).toBe(false);
  });

  it('collapses a department and selects a desk', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    await wrapper.find('.team-department__header').trigger('click');
    expect(wrapper.find('.team-desk').exists()).toBe(false);
    await wrapper.find('.team-department__header').trigger('click');
    await wrapper.find('.team-desk').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['s1']]);
  });
});
