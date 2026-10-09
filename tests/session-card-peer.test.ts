// @vitest-environment jsdom

/**
 * SessionCard peer-origin styling — a session created on this machine by a
 * remote Helm peer renders with the `peer-created` class (light blue card).
 */

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionCard from '../renderer/components/sidebar/SessionCard.vue';
import { getActivityColor } from '../renderer/state-colors.js';

function baseProps(session: Record<string, unknown>) {
  return {
    session: { id: 's1', name: 'Session', cliType: 'claude-code', ...session },
    navIndex: 0,
    sessionState: 'idle',
    activityLevel: 'idle',
    displayName: 'Session',
    draftCount: 0,
    artifactCount: 0,
    elapsedText: '',
    workingPlanLabel: '',
    workingPlanTooltip: '',
    loopContinues: 0,
    pendingSubagents: 0,
    isActive: false,
    isFocused: false,
    focusColumn: 0 as const,
    isEditing: false,
    isHiddenFromOverview: false,
  };
}

describe('SessionCard peer origin', () => {
  it('marks a peer-created session with the peer-created class', () => {
    const wrapper = mount(SessionCard, { props: baseProps({ createdByPeerId: 'desktop-b' }) });

    expect(wrapper.find('.session-card').classes()).toContain('peer-created');
  });

  it('does not mark a locally created session', () => {
    const wrapper = mount(SessionCard, { props: baseProps({}) });

    expect(wrapper.find('.session-card').classes()).not.toContain('peer-created');
  });

  it('names the originating peer in the card tooltip', () => {
    const wrapper = mount(SessionCard, { props: baseProps({ createdByPeerId: 'desktop-b' }) });

    expect(wrapper.find('.session-card').attributes('title')).toContain('desktop-b');
  });

  it('uses the peer activity state colour and offers attach without local controls', () => {
    const wrapper = mount(SessionCard, { props: { ...baseProps({}), activityLevel: 'active', readOnly: true, stateReadOnly: true } });
    const expectedColor = document.createElement('span');
    expectedColor.style.backgroundColor = getActivityColor('active');
    expect((wrapper.find('.session-activity-dot').element as HTMLElement).style.backgroundColor)
      .toBe(expectedColor.style.backgroundColor);
    expect(wrapper.find('.session-attach-btn').exists()).toBe(true);
    expect(wrapper.find('.session-state-dropdown').exists()).toBe(false);
    expect(wrapper.find('.session-kebab').exists()).toBe(false);
    expect(wrapper.find('.session-close').exists()).toBe(false);
  });

  it('disables a stale peer row while preserving the displayed row', async () => {
    const wrapper = mount(SessionCard, { props: { ...baseProps({}), readOnly: true, interactionDisabled: true, stale: true } });
    await wrapper.find('.session-card').trigger('click');
    expect(wrapper.emitted('click')).toBeUndefined();
    expect((wrapper.find('.session-attach-btn').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find('.session-card').classes()).toContain('peer-stale');
  });
});
