/**
 * Session List PTY previews and message flights, which replaced Team View.
 *
 * Real SessionList, real useSessionPreviews over a real PtyOutputBuffer, and
 * real useMessageFlights. Only the flight IPC bridge is faked.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';
import { PtyOutputBuffer } from '../../../renderer/terminal/pty-output-buffer.js';
import { setTerminalManager } from '../../../renderer/runtime/terminal-provider.js';
import { FLIGHT_LANDING_FLASH_MS } from '../../../renderer/composables/useMessageFlights.js';
import type { SessionMessageFlight } from '../../../src/session/message-flight.js';

const CardStub = {
  props: ['session', 'previewSource', 'messageLanded'],
  template: `<div class="card" :data-session-id="session.id" :class="{ landed: messageLanded }">
    <span v-if="previewSource" class="preview">{{ previewSource(session.id).join('|') }}</span>
  </div>`,
};
const GroupStub = {
  props: ['group'],
  template: '<div class="group-header" :data-dir-path="group.dirPath"></div>',
};

type FlightCallback = (flight: SessionMessageFlight) => void;
let flightCallback: FlightCallback | undefined;
let unsubscribed = 0;
let acked: string[] = [];
let buffer: PtyOutputBuffer;
let wrapper: VueWrapper | null = null;

// A mobile proxy id: the kind of id that would need CSS escaping in a selector.
const MOBILE_ID = 'mobile:dev/1"x';

function mountList(overrides: Record<string, unknown> = {}) {
  wrapper = mount(SessionList, {
    props: {
      hasSessions: true,
      groups: [
        { dirPath: 'X:\\repo', displayName: 'repo', collapsed: false, sessions: [
          { id: 'sA', name: 'A', cliType: 'claude' },
          { id: MOBILE_ID, name: 'B', cliType: 'claude' },
        ] },
        { dirPath: 'X:\\other "dir"', displayName: 'other', collapsed: true, sessions: [
          { id: 'sC', name: 'C', cliType: 'codex' },
        ] },
      ],
      directories: [],
      navIndexMap: new Map<string, number>(),
      activeFocus: 'sessions',
      focusedNavItem: null,
      focusColumn: 0,
      activeSessionId: 'sA',
      editingSessionId: null,
      sessionStates: new Map(),
      sessionActivityLevels: new Map(),
      draftCounts: new Map(),
      artifactCounts: new Map(),
      workingPlanLabels: new Map(),
      workingPlanTooltips: new Map(),
      pendingSchedules: new Map(),
      snappedOutSessions: new Set(),
      llmNotifications: new Map(),
      getCliDisplayName: (t: string) => t,
      resolveGroupDisplayName: (p: string) => p,
      isSessionHiddenFromOverview: () => false,
      sessionElapsedText: () => '',
      sessionShortcutMap: new Map(),
      ...overrides,
    },
    global: { stubs: { SessionCard: CardStub, SessionGroup: GroupStub } },
    attachTo: document.body,
  });
  return wrapper;
}

function fly(flight: Partial<SessionMessageFlight>): void {
  flightCallback!({
    flightId: 'f1', senderSessionId: 'sA', senderSessionName: 'A',
    recipientSessionId: MOBILE_ID, recipientName: 'B', expectsResponse: false, isReply: false,
    ...flight,
  });
}

beforeEach(() => {
  flightCallback = undefined;
  unsubscribed = 0;
  acked = [];
  (window as any).helm = {
    sessions: {
      onSessionMessageFlight: (callback: FlightCallback) => {
        flightCallback = callback;
        return () => { flightCallback = undefined; unsubscribed++; };
      },
      ackSessionMessageFlight: async (flightId: string) => { acked.push(flightId); },
    },
  };
  buffer = new PtyOutputBuffer();
  setTerminalManager({ getOutputBuffer: () => buffer } as any);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  setTerminalManager(null);
  vi.useRealTimers();
  delete (window as any).helm;
});

describe('Session List PTY previews', () => {
  it('shows the last five non-blank lines of each session', () => {
    buffer.append('sA', 'l1\nl2\n\n   \nl3\nl4\nl5\nl6\n');
    const list = mountList();
    const preview = list.get('[data-session-id="sA"] .preview');
    expect(preview.text()).toBe('l2|l3|l4|l5|l6');
  });

  it('refreshes after new output, throttled rather than per chunk', async () => {
    vi.useFakeTimers();
    const list = mountList();
    buffer.append('sA', 'first\n');
    buffer.append('sA', 'second\n');
    await nextTick();
    expect(list.get('[data-session-id="sA"] .preview').text()).toBe('');

    vi.advanceTimersByTime(250);
    await nextTick();
    expect(list.get('[data-session-id="sA"] .preview').text()).toBe('first|second');
  });

  it('attaches to a terminal manager created after the list mounted', async () => {
    setTerminalManager(null);
    const list = mountList();
    const late = new PtyOutputBuffer();
    late.append('sA', 'late\n');
    setTerminalManager({ getOutputBuffer: () => late } as any);
    await nextTick();
    expect(list.get('[data-session-id="sA"] .preview').text()).toBe('late');
  });

  it("renders no preview in 'off' mode", () => {
    buffer.append('sA', 'x\n');
    const list = mountList({ previewMode: 'off' });
    expect(list.find('.preview').exists()).toBe(false);
  });

  it("renders only the selected row's preview in 'selected-only' mode", () => {
    const list = mountList({ previewMode: 'selected-only' });
    expect(list.findAll('.preview')).toHaveLength(1);
    expect(list.find('[data-session-id="sA"] .preview').exists()).toBe(true);
  });
});

describe('Session List message flights', () => {
  it('flies to the recipient row and acks only when the envelope lands', async () => {
    const list = mountList();
    fly({});
    await nextTick();

    const flight = list.get('.message-flight');
    expect(acked).toEqual([]);
    await flight.trigger('animationend');

    expect(list.find('.message-flight').exists()).toBe(false);
    expect(acked).toEqual(['f1']);
  });

  it('flashes the recipient row after landing, then clears the flash', async () => {
    vi.useFakeTimers();
    const list = mountList();
    fly({});
    await nextTick();
    await list.get('.message-flight').trigger('animationend');

    const recipient = list.findAll('.card').find(c => c.attributes('data-session-id') === MOBILE_ID)!;
    expect(recipient.classes()).toContain('landed');
    vi.advanceTimersByTime(FLIGHT_LANDING_FLASH_MS);
    await nextTick();
    expect(recipient.classes()).not.toContain('landed');
  });

  it('colours replies differently from first sends', async () => {
    const list = mountList();
    fly({ flightId: 'send' });
    fly({ flightId: 'reply', isReply: true });
    await nextTick();
    const styles = list.findAll('.message-flight').map(f => f.attributes('style'));
    expect(styles[0]).toContain('#4488ff');
    expect(styles[1]).toContain('#ff9f1a');
  });

  it('lands on the collapsed group header when the recipient row is hidden', async () => {
    const list = mountList();
    fly({ recipientSessionId: 'sC' });
    await nextTick();
    // Animated (not released at once) because the collapsed header is a target.
    expect(list.find('.message-flight').exists()).toBe(true);
    expect(acked).toEqual([]);
  });

  it('releases at once when the list is hidden (inactive dock tab), rows still mounted', async () => {
    const list = mountList();
    (list.get('.sessions-list').element as HTMLElement).checkVisibility = () => false;
    fly({});
    await nextTick();
    expect(list.find('.message-flight').exists()).toBe(false);
    expect(acked).toEqual(['f1']);
  });

  it('releases at once when the recipient is not in the list', async () => {
    const list = mountList();
    fly({ recipientSessionId: 'closed-session' });
    await nextTick();
    expect(list.find('.message-flight').exists()).toBe(false);
    expect(acked).toEqual(['f1']);
  });

  it('flies in from the top-right corner for a sender with no row', async () => {
    const list = mountList();
    fly({ senderSessionId: 'mobile:phone', recipientSessionId: 'sA' });
    await nextTick();
    expect(list.find('.message-flight').exists()).toBe(true);
  });

  it('on unmount unsubscribes and releases flights still in the air', async () => {
    const list = mountList();
    fly({});
    await nextTick();

    list.unmount();
    wrapper = null;

    expect(unsubscribed).toBe(1);
    expect(acked).toEqual(['f1']);
  });
});
