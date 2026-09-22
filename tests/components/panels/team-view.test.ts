/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TeamView from '../../../renderer/components/panels/TeamView.vue';
import type { TeamViewProjection } from '../../../renderer/team-view/team-view-projection.js';
import type { SessionMessageFlight } from '../../../src/session/message-flight.js';

const projection: TeamViewProjection = {
  deskCount: 2,
  visibleDeskCount: 2,
  departments: [{
    id: 'alpha', name: 'Alpha', collapsed: false, visibleDeskCount: 2,
    desks: [{
      sessionId: 's1', name: 'Ada', cliType: 'codex', state: 'waiting', waitingReason: 'human',
      terminalTail: ['Need approval'], hidden: false, focusIndex: 0, focusLabel: '^1',
      locked: false, artifactCount: 2, activityLevel: 'active',
    }, {
      sessionId: 's2', name: 'Bob', cliType: 'codex', state: 'idle',
      terminalTail: [], hidden: false, focusIndex: 1, focusLabel: '^2',
      locked: false, artifactCount: 0, activityLevel: 'idle',
    }],
  }],
};

type FlightCallback = (event: SessionMessageFlight) => void;
let flightCallback: FlightCallback | undefined;
const ackedFlightIds: string[] = [];

beforeEach(() => {
  flightCallback = undefined;
  ackedFlightIds.length = 0;
  (window as any).helm = {
    sessions: {
      onSessionMessageFlight: (callback: FlightCallback) => {
        flightCallback = callback;
        return () => { flightCallback = undefined; };
      },
      ackSessionMessageFlight: async (flightId: string) => { ackedFlightIds.push(flightId); },
    },
  };
});

afterEach(() => {
  delete (window as any).helm;
});

describe('TeamView', () => {
  it('renders actual state, waiting cue, shortcut, and a passive clipped tail', () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    expect(wrapper.text()).toContain('waiting · human');
    expect(wrapper.text()).toContain('^1');
    expect(wrapper.find('.team-desk__monitor').text()).toContain('Need approval');
    expect(wrapper.find('textarea, input, [contenteditable="true"]').exists()).toBe(false);
  });

  it('persists department collapse through its owner and delegates selection to the shared session path', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: 's1' } });
    await wrapper.find('.team-department__header').trigger('click');
    expect(wrapper.emitted('toggleDepartment')).toEqual([['alpha']]);
    await wrapper.find('.team-desk').trigger('click');
    expect(wrapper.find('.team-actions').text()).toContain('Read-only desk');
    expect(wrapper.emitted('select')).toEqual([['s1']]);
    await wrapper.get('.team-actions__controls button:nth-child(1)').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['s1'], ['s1']]);
    await wrapper.get('.team-actions__controls button:nth-child(3)').trigger('click');
    await wrapper.get('.team-actions__controls button:nth-child(4)').trigger('click');
    await wrapper.get('.team-actions__controls button:nth-child(5)').trigger('click');
    await wrapper.get('.team-actions__controls button:nth-child(6)').trigger('click');
    expect(wrapper.emitted('toggleLock')).toEqual([['s1', true]]);
    expect(wrapper.emitted('toggleVisibility')).toEqual([['s1']]);
    expect(wrapper.emitted('showArtifacts')).toEqual([['s1']]);
    expect(wrapper.emitted('requestClose')).toEqual([['s1', 'Ada']]);
    await wrapper.get('.team-actions__rename input').setValue('Grace');
    await wrapper.get('.team-actions__rename').trigger('submit');
    expect(wrapper.emitted('rename')).toEqual([['s1', 'Grace']]);
  });

  it('keeps keyboard focus in document order and marks the shared active desk', () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: 's1' } });
    const labels = wrapper.findAll('button').map(button => button.text());
    expect(labels.slice(0, 2)).toEqual(['▾Alpha 2', '^1Adawaiting · humanNeed approval']);
    expect(labels[2]).toContain('^2Bob');
    expect(labels[3]).toBe('Open terminal');
    expect(wrapper.find('.team-desk').attributes('aria-current')).toBe('true');
  });

  it('renders the shared activity dot colour for each desk', () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    const dots = wrapper.findAll('.team-desk__activity-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0].attributes('style')).toContain('#44cc44'); // active → green
    expect(dots[1].attributes('style')).toContain('#555555'); // idle → grey
  });

  it('flies an envelope from sender to recipient and acks the flight on landing', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    expect(wrapper.find('.team-view__flight').exists()).toBe(false);

    flightCallback!({
      flightId: 'f1',
      senderSessionId: 's1',
      senderSessionName: 'Ada',
      recipientSessionId: 's2',
      recipientName: 'Bob',
      expectsResponse: false,
      isReply: false,
    });
    await wrapper.vm.$nextTick();

    const flight = wrapper.find('.team-view__flight');
    expect(flight.exists()).toBe(true);
    expect(ackedFlightIds).toEqual([]); // nothing pasted until the envelope lands

    await flight.trigger('animationend');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.team-view__flight').exists()).toBe(false);
    expect(ackedFlightIds).toEqual(['f1']);
  });

  it('colours reply flights differently from first sends', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });

    flightCallback!({
      flightId: 'f1', senderSessionId: 's1', senderSessionName: 'Ada',
      recipientSessionId: 's2', recipientName: 'Bob', expectsResponse: false, isReply: false,
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.team-view__flight').attributes('style')).toContain('#4488ff');
    await wrapper.get('.team-view__flight').trigger('animationend');

    flightCallback!({
      flightId: 'f2', senderSessionId: 's2', senderSessionName: 'Bob',
      recipientSessionId: 's1', recipientName: 'Ada', expectsResponse: true, isReply: true,
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.team-view__flight').attributes('style')).toContain('#ff9f1a');
    await wrapper.get('.team-view__flight').trigger('animationend');
  });

  it('still acks flights it cannot animate (missing desks) so delivery is never held', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    flightCallback!({
      flightId: 'f3',
      senderSessionId: 'mobile:phone',
      senderSessionName: 'mobile:phone',
      recipientSessionId: 'no-such-desk',
      recipientName: 'Ghost',
      expectsResponse: false,
      isReply: false,
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.team-view__flight').exists()).toBe(false);
    expect(ackedFlightIds).toEqual(['f3']);
  });
});
