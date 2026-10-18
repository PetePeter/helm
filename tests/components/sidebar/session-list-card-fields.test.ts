/**
 * SessionList hand-picks the fields each SessionCard receives. A field missing
 * from that pick silently reads as undefined on the card — the ❄ toggle then
 * always looked "off" and every click re-froze the session instead of thawing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';

describe('SessionList → SessionCard fields', () => {
  it('passes persisted session state through to the card', () => {
    const seen: Array<Record<string, unknown>> = [];
    const CardStub = {
      props: ['session'],
      setup(props: { session: Record<string, unknown> }) { seen.push(props.session); return {}; },
      template: '<div />',
    };
    mount(SessionList, {
      props: {
        hasSessions: true,
        groups: [{ dirPath: '/repo', displayName: '/repo', collapsed: false, sessions: [
          {
            id: 's1', name: 'a', cliType: 'claude-code', frozen: true, lastPromptAt: 42,
            eta: { at: 90_000, setAt: 30_000, note: 'review' },
          },
        ] }],
        directories: [],
        navIndexMap: new Map<string, number>(),
        activeFocus: 'sessions',
        focusedNavItem: null,
        focusColumn: 0 as 0,
        activeSessionId: null,
        editingSessionId: null,
        sessionStates: new Map<string, string>(),
        sessionActivityLevels: new Map<string, string>(),
        artifactCounts: new Map<string, number>(),
        workingPlanLabels: new Map<string, string>(),
        workingPlanTooltips: new Map<string, string>(),
        pendingSchedules: new Map<string, string>(),
        snappedOutSessions: new Set<string>(),
        llmNotifications: new Map(),
        getCliDisplayName: (c: string) => c,
        resolveGroupDisplayName: (p: string) => p,
        sessionElapsedText: () => '',
        sessionShortcutMap: new Map<string, number>(),
      },
      global: { stubs: { SessionGroup: { template: '<div><slot /></div>' }, SessionCard: CardStub } },
    });
    expect(seen[0]).toMatchObject({ frozen: true, lastPromptAt: 42, eta: { at: 90_000, setAt: 30_000, note: 'review' } });
  });
});
