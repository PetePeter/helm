/**
 * CLI type labels in the sidebar.
 *
 * CLI types are keyed by an opaque UUID everywhere in config and in session
 * records. A uuid means nothing to a human, so no sidebar surface may ever
 * render one — the display name from the CLI type record is the only label.
 * These tests wire the real `getCliDisplayName` helper into the
 * real components, so a regression in either half fails here.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionList from '../../../renderer/components/sidebar/SessionList.vue';
import SpawnGrid from '../../../renderer/components/sidebar/SpawnGrid.vue';
import { getCliDisplayName } from '../../../renderer/utils.js';
import { state } from '../../../renderer/state.js';

const CLAUDE_ID = '5e1f5c1e-6c2f-4d54-9a3f-1c7d9b2a4e10';
const CODEX_ID = '11111111-2222-4333-8444-555566667777';

beforeEach(() => {
  state.cliToolsCache = {
    [CLAUDE_ID]: { id: CLAUDE_ID, displayName: 'Claude', name: 'Claude', legacyKey: 'claude-code' },
    [CODEX_ID]: { id: CODEX_ID, displayName: 'Codex', name: 'Codex', legacyKey: 'codex' },
  };
});

describe('SpawnGrid labels', () => {
  it('renders the record display name, never the uuid', () => {
    // Built exactly as MainWindowApp builds `spawnItems`.
    const items = [CLAUDE_ID, CODEX_ID].map(ct => ({
      cliType: ct,
      displayName: getCliDisplayName(ct),
    }));

    const w = mount(SpawnGrid, { props: { items, focusIndex: 0, isActive: true } });

    expect(w.text()).toContain('Claude');
    expect(w.text()).toContain('Codex');
    expect(w.text()).not.toContain(CLAUDE_ID);
    expect(w.text()).not.toContain(CODEX_ID);
  });

  it('still spawns by the uuid identity behind the label', async () => {
    const items = [{ cliType: CLAUDE_ID, displayName: getCliDisplayName(CLAUDE_ID) }];
    const w = mount(SpawnGrid, { props: { items, focusIndex: 0, isActive: true } });

    await w.get('button').trigger('click');

    expect(w.emitted('spawn')?.[0]).toEqual([CLAUDE_ID]);
  });
});

describe('SessionList labels', () => {
  const CardStub = {
    props: ['displayName', 'session'],
    template: '<div class="card" :data-id="session.id">{{ displayName }}</div>',
  };

  function mountList(session: { id: string; name: string; cliType: string }) {
    return mount(SessionList, {
      props: {
        hasSessions: true,
        groups: [{ dirPath: '/repo', displayName: '/repo', collapsed: false, sessions: [session] }],
        directories: [],
        navIndexMap: new Map<string, number>(),
        activeFocus: 'sessions',
        focusedNavItem: null,
        focusColumn: 0 as 0,
        activeSessionId: null,
        editingSessionId: null,
        sessionStates: new Map<string, string>(),
        sessionActivityLevels: new Map<string, string>(),
        draftCounts: new Map<string, number>(),
        artifactCounts: new Map<string, number>(),
        workingPlanLabels: new Map<string, string>(),
        workingPlanTooltips: new Map<string, string>(),
        pendingSchedules: new Map<string, string>(),
        snappedOutSessions: new Set<string>(),
        llmNotifications: new Map(),
        getCliDisplayName,
        resolveGroupDisplayName: (p: string) => p,
        isSessionHiddenFromOverview: () => false,
        sessionElapsedText: () => '',
        sessionShortcutMap: new Map<string, number>(),
      },
      global: { stubs: { SessionGroup: { template: '<div><slot /></div>' }, SessionCard: CardStub } },
    });
  }

  it('falls back to the CLI display name, not the uuid, for an unnamed session', () => {
    const w = mountList({ id: 's1', name: CLAUDE_ID, cliType: CLAUDE_ID });

    expect(w.get('[data-id="s1"]').text()).toBe('Claude');
  });

  it('keeps a user-given session name', () => {
    const w = mountList({ id: 's1', name: 'refactor loader', cliType: CLAUDE_ID });

    expect(w.get('[data-id="s1"]').text()).toBe('refactor loader');
  });
});
