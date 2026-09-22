/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TeamView from '../../../renderer/components/panels/TeamView.vue';
import { useLlmNotificationsStore } from '../../../renderer/stores/llmNotifications.js';
import { useRecycleBin } from '../../../renderer/composables/useRecycleBin.js';
import type { TeamViewNotification, TeamViewProjection } from '../../../renderer/team-view/team-view-projection.js';
import type { SessionMessageFlight } from '../../../src/session/message-flight.js';

const projection: TeamViewProjection = {
  deskCount: 2,
  visibleDeskCount: 2,
  departments: [{
    id: 'alpha', name: 'Alpha', collapsed: false, visibleDeskCount: 2, hiddenDeskCount: 0,
    desks: [{
      sessionId: 's1', name: 'Ada', cliType: 'codex', state: 'waiting', waitingReason: 'human',
      terminalTail: ['Need approval'], hidden: false, focusIndex: 0, focusLabel: '^1',
      locked: false, artifactCount: 2, activityLevel: 'active', notifications: [],
    }, {
      sessionId: 's2', name: 'Bob', cliType: 'codex', state: 'idle',
      terminalTail: [], hidden: false, focusIndex: 1, focusLabel: '^2',
      locked: false, artifactCount: 0, activityLevel: 'idle', notifications: [],
    }],
  }],
};

type FlightCallback = (event: SessionMessageFlight) => void;
let flightCallback: FlightCallback | undefined;
const ackedFlightIds: string[] = [];
// Shared singleton — the same instance the component button drives.
const recycleBin = useRecycleBin();

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
    // The persistent operator bar leads the document; desks follow in slot order.
    // Bar: Open terminal, Copy reference, Lock, Hide, Artifacts (2), Close, Save.
    expect(labels[0]).toBe('Open terminal');
    expect(labels[6]).toBe('Save');
    expect(labels.slice(7, 9)).toEqual(['▾Alpha 2', '^1Adawaiting · humanNeed approval']);
    expect(labels[9]).toContain('^2Bob');
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

  it('always renders the operator bar above the departments, with actions only when a desk is selected', () => {
    const idle = mount(TeamView, { props: { projection, activeSessionId: null } });
    const idleBar = idle.find('.team-actions');
    expect(idleBar.exists()).toBe(true);
    expect(idleBar.text()).toMatch(/select/i);
    // No selected desk means no desk-scoped actions to press.
    expect(idleBar.find('.team-actions__controls button').exists()).toBe(false);
    // The bar leads the document, ahead of every department section.
    const barEl = idleBar.element;
    const departmentEl = idle.find('.team-department').element;
    expect(barEl.compareDocumentPosition(departmentEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    idle.unmount();

    const active = mount(TeamView, { props: { projection, activeSessionId: 's1' } });
    const buttons = active.findAll('.team-actions__controls button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(button => button.attributes('disabled') === undefined)).toBe(true);
    active.unmount();
  });

  it('renders one quiet hidden-desks row per department and unhides all from it', async () => {
    const hiddenProjection: TeamViewProjection = {
      deskCount: 3,
      visibleDeskCount: 1,
      departments: [{
        id: 'alpha', name: 'Alpha', collapsed: false, visibleDeskCount: 1, hiddenDeskCount: 2,
        desks: [projection.departments[0].desks[0], {
          ...projection.departments[0].desks[1], hidden: true,
        }, {
          ...projection.departments[0].desks[1], sessionId: 's3', name: 'Cy', hidden: true,
        }],
      }],
    };

    const wrapper = mount(TeamView, { props: { projection: hiddenProjection, activeSessionId: null } });
    const rows = wrapper.findAll('.team-hidden-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toMatch(/2 hidden/i);
    await rows[0].get('button').trigger('click');
    expect(wrapper.emitted('unhide-all')).toEqual([['alpha']]);
    wrapper.unmount();
  });

  it('focuses the rename input on Ctrl+Shift+R when a desk is selected', async () => {
    const wrapper = mount(TeamView, {
      props: { projection, activeSessionId: 's1' },
      attachTo: document.body,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'R', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    await wrapper.vm.$nextTick();
    const input = wrapper.get('.team-actions__rename input').element;
    expect(document.activeElement).toBe(input);
    wrapper.unmount();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
});

describe('TeamView desk notifications', () => {
  const NOTIFICATIONS: Record<string, TeamViewNotification[]> = {
    s1: [
      { id: 'n1', title: 'Attention', content: 'Please review', createdAt: 1 },
      { id: 'n2', title: 'Second', content: 'Also review', createdAt: 2 },
    ],
    s2: [
      { id: 'n3', title: 'Done waiting', content: 'Bob needs input', createdAt: 3 },
    ],
  };

  /** Clone the shared fixture, attaching notifications to the named desks. */
  function withNotifications(sessionIds: string[]): TeamViewProjection {
    return {
      ...projection,
      departments: [{
        ...projection.departments[0],
        desks: projection.departments[0].desks.map(desk => ({
          ...desk,
          notifications: sessionIds.includes(desk.sessionId)
            ? NOTIFICATIONS[desk.sessionId]
            : [],
        })),
      }],
    };
  }

  function badgeFor(wrapper: ReturnType<typeof mount>, sessionId: string) {
    return wrapper.get(`[data-desk-id="${sessionId}"] .team-desk__notification-badge`);
  }

  /** Seed the real store so popover dismissals land in shared Session List state. */
  function seedStoreNotifications(): void {
    const store = useLlmNotificationsStore();
    store.notifications = [
      { id: 'n1', sessionId: 's1', title: 'Attention', content: 'Please review', createdAt: 1 },
      { id: 'n2', sessionId: 's1', title: 'Second', content: 'Also review', createdAt: 2 },
      { id: 'n3', sessionId: 's2', title: 'Done waiting', content: 'Bob needs input', createdAt: 3 },
    ];
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders the badge only for desks with notifications and opens the popover without selecting', async () => {
    const wrapper = mount(TeamView, { props: { projection: withNotifications(['s1']), activeSessionId: null } });
    // Only s1 carries notifications; s2 renders no badge.
    expect(wrapper.findAll('.team-desk__notification-badge')).toHaveLength(1);
    expect(wrapper.find('[data-desk-id="s2"] .team-desk__notification-badge').exists()).toBe(false);
    // The badge count reads notifications.length.
    expect(badgeFor(wrapper, 's1').text()).toContain('2');
    expect(wrapper.find('.team-desk__notifications').exists()).toBe(false);

    await badgeFor(wrapper, 's1').trigger('click');
    expect(wrapper.find('.team-desk__notifications').exists()).toBe(true);
    // Opening the popover is a desk-local read — it must not select the desk.
    expect(wrapper.emitted('select')).toBeUndefined();
    wrapper.unmount();
  });

  it('reuses the NotificationCarousel in the popover and dismisses through the real store', async () => {
    seedStoreNotifications();
    const store = useLlmNotificationsStore();
    const wrapper = mount(TeamView, { props: { projection: withNotifications(['s1']), activeSessionId: null } });
    await badgeFor(wrapper, 's1').trigger('click');

    const popover = wrapper.get('.team-desk__notifications');
    expect(popover.find('.notification-carousel').exists()).toBe(true);
    expect(popover.text()).toContain('Attention');
    expect(popover.text()).toContain('Please review');

    await popover.get('.dismiss-btn').trigger('click');
    expect(store.notifications.map(notification => notification.id)).toEqual(['n2', 'n3']);
    wrapper.unmount();

    // Clear-all empties that session's entries through dismissSession.
    const again = mount(TeamView, { props: { projection: withNotifications(['s1', 's2']), activeSessionId: null } });
    await badgeFor(again, 's1').trigger('click');
    await again.get('.team-desk__notifications .carousel-clear').trigger('click');
    expect(store.notifications.map(notification => notification.sessionId)).toEqual(['s2']);
    again.unmount();
  });

  it('closes the popover on Escape and keeps only one popover open at a time', async () => {
    const wrapper = mount(TeamView, { props: { projection: withNotifications(['s1', 's2']), activeSessionId: null } });
    await badgeFor(wrapper, 's1').trigger('click');
    expect(wrapper.find('.team-desk__notifications').exists()).toBe(true);

    // Opening the second desk's badge replaces the first popover.
    await badgeFor(wrapper, 's2').trigger('click');
    const popovers = wrapper.findAll('.team-desk__notifications');
    expect(popovers).toHaveLength(1);
    expect(popovers[0].text()).toContain('Done waiting');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.team-desk__notifications').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens the shared recycle-bin modal from a button at the very bottom', async () => {
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: null } });
    const bin = wrapper.get('.team-recycle-bin');
    // The bin entry trails every department section.
    const departmentEl = wrapper.find('.team-department').element;
    expect(bin.element.compareDocumentPosition(departmentEl) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await bin.trigger('click');
    expect(recycleBin.modalVisible.value).toBe(true);
    recycleBin.modalVisible.value = false; // reset the shared singleton
    wrapper.unmount();
  });

  it('shows the waving-arm pose on a desk that carries notifications regardless of state', () => {
    // s2 is idle, but a notification puts its member in the alert (input/wave) pose.
    const wrapper = mount(TeamView, { props: { projection: withNotifications(['s2']), activeSessionId: null } });
    expect(wrapper.get('[data-desk-id="s2"] .team-member').classes()).toContain('team-member--input');
    // Without the notification the same idle desk keeps its state-driven pose.
    // (s1 is 'waiting', whose state-driven pose is legitimately the wave too —
    //  see team-member.test.ts — so it cannot serve as the no-alert contrast.)
    const quiet = mount(TeamView, { props: { projection: withNotifications(['s1']), activeSessionId: null } });
    expect(quiet.get('[data-desk-id="s2"] .team-member').classes()).not.toContain('team-member--input');
    wrapper.unmount();
    quiet.unmount();
  });
});
