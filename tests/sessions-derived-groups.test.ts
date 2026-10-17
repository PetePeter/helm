/**
 * Sidebar groups are a derivation, not a snapshot.
 *
 * `sessionsState.groups` / `.navList` used to be plain fields rebuilt by hand
 * from three separate call sites. Any session mutation that did not go through
 * a full refresh (a lock toggle, a snap-out, an MCP/peer spawn) left the cards
 * rendering a stale copy of the session — the lock button could set `locked`
 * but never clear it, because it read the pre-toggle value forever.
 *
 * These tests pin the derivation: mutate the inputs, read the outputs, never
 * call a rebuild.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';

import { state } from '../renderer/state.js';
import type { Session } from '../renderer/state.js';
import {
  sessionsState,
  useSessionsScreenStore,
  setSessionCwdResolver,
} from '../renderer/stores/sessions-screen.js';
import { useRuntimeGroups } from '../renderer/composables/useRuntimeGroups.js';
import type { RuntimeGroup } from '../src/types/runtime-group.js';

const DIR_A = 'x:/work/alpha';
const DIR_B = 'x:/work/beta';

function makeSession(id: string, workingDir: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    cliType: 'claude',
    processId: 0,
    workingDir,
    ...extra,
  };
}

/** Every session the sidebar would render, flattened out of the groups. */
function renderedSessions(): Session[] {
  return sessionsState.groups.flatMap(group => group.sessions);
}

function findRendered(id: string): Session | undefined {
  return renderedSessions().find(session => session.id === id);
}

function setRuntimeGroups(groups: RuntimeGroup[]): void {
  useRuntimeGroups().groups.value = groups;
}

beforeEach(() => {
  state.sessions = [];
  state.activeSessionId = null;
  state.snappedOutSessions.clear();
  sessionsState.groupPrefs = { order: [], collapsed: [], bookmarked: [] };
  sessionsState.sessionsFocusIndex = 0;
  setRuntimeGroups([]);
  setSessionCwdResolver(id => state.sessions.find(s => s.id === id)?.workingDir ?? '');
});

describe('derived sidebar groups', () => {
  it('reflects a locked flip without any rebuild call', () => {
    state.sessions = [makeSession('s1', DIR_A, { locked: false })];
    expect(findRendered('s1')?.locked).toBe(false);

    // The session:updated handler replaces the array element rather than
    // mutating it — the old snapshot kept the stale object and never saw this.
    state.sessions[0] = { ...state.sessions[0], locked: true };
    expect(findRendered('s1')?.locked).toBe(true);

    state.sessions[0] = { ...state.sessions[0], locked: false };
    expect(findRendered('s1')?.locked).toBe(false);
  });

  it('reflects an in-place field mutation too', () => {
    state.sessions = [makeSession('s1', DIR_A, { locked: false })];
    Object.assign(state.sessions[0], { locked: true });
    expect(findRendered('s1')?.locked).toBe(true);
  });

  it('adds and removes sessions without a refresh', () => {
    state.sessions = [makeSession('s1', DIR_A)];
    expect(renderedSessions().map(s => s.id)).toEqual(['s1']);

    state.sessions = [...state.sessions, makeSession('s2', DIR_B)];
    expect(renderedSessions().map(s => s.id).sort()).toEqual(['s1', 's2']);

    state.sessions = state.sessions.filter(s => s.id !== 's1');
    expect(renderedSessions().map(s => s.id)).toEqual(['s2']);
  });

  it('rebuilds when group prefs change (collapse and order)', () => {
    state.sessions = [makeSession('s1', DIR_A), makeSession('s2', DIR_B)];

    sessionsState.groupPrefs = { ...sessionsState.groupPrefs, order: [DIR_B, DIR_A] };
    expect(sessionsState.groups.map(g => g.dirPath)).toEqual([DIR_B, DIR_A]);

    expect(sessionsState.groups[0].collapsed).toBe(false);
    sessionsState.groupPrefs = { ...sessionsState.groupPrefs, collapsed: [DIR_B] };
    expect(sessionsState.groups[0].collapsed).toBe(true);
  });

  it('rebuilds when runtime groups change and keeps membership exclusive', () => {
    state.sessions = [makeSession('s1', DIR_A), makeSession('s2', DIR_A)];
    expect(sessionsState.groups.map(g => g.kind)).toEqual(['directory']);

    setRuntimeGroups([
      { id: 'rg1', name: 'Sprint', sessionIds: ['s1'], collapsed: false } as RuntimeGroup,
    ]);

    const [runtime, directory] = sessionsState.groups;
    expect(runtime.kind).toBe('runtime');
    expect(runtime.sessions.map(s => s.id)).toEqual(['s1']);
    // Exclusive: a runtime member must not also appear under its directory.
    expect(directory.sessions.map(s => s.id)).toEqual(['s2']);
  });

  it('keeps navList in sync with groups', () => {
    state.sessions = [makeSession('s1', DIR_A), makeSession('s2', DIR_B)];

    expect(sessionsState.navList.map(item => item.type)).toEqual([
      'group-header', 'session-card', 'group-header', 'session-card',
    ]);

    // Collapsing a group drops its cards from navigation.
    sessionsState.groupPrefs = { ...sessionsState.groupPrefs, collapsed: [DIR_A] };
    expect(sessionsState.navList.filter(item => item.type === 'session-card').map(i => i.id))
      .toEqual(['s2']);
  });

  it('preserves runtime groups when the session sort order changes', () => {
    state.sessions = [makeSession('s1', DIR_A), makeSession('s2', DIR_A)];
    setRuntimeGroups([
      { id: 'rg1', name: 'Sprint', sessionIds: ['s1'], collapsed: false } as RuntimeGroup,
    ]);

    // Re-sorting reassigns state.sessions; the runtime group must survive it.
    state.sessions = [...state.sessions].reverse();

    expect(sessionsState.groups.some(g => g.kind === 'runtime')).toBe(true);
    expect(sessionsState.groups.find(g => g.kind === 'runtime')?.sessions.map(s => s.id))
      .toEqual(['s1']);
  });

  it('keeps the Ctrl+N shortcut map correct as sessions come and go', () => {
    const store = useSessionsScreenStore();
    state.sessions = [makeSession('s1', DIR_A), makeSession('s2', DIR_A)];
    expect([...store.sessionShortcutMap.keys()]).toEqual(['s1', 's2']);

    state.sessions = [...state.sessions, makeSession('s3', DIR_A)];
    expect(store.sessionShortcutMap.get('s3')).toBe(3);

    // A snapped-out session gives up its slot.
    state.snappedOutSessions.add('s1');
    expect(store.sessionShortcutMap.has('s1')).toBe(false);
    expect(store.sessionShortcutMap.get('s2')).toBe(1);
  });

  it('renders a peer-created session in its directory group', () => {
    state.sessions = [makeSession('s1', DIR_A, { createdByPeerId: 'peer-1' })];
    const rendered = findRendered('s1');
    expect(rendered?.createdByPeerId).toBe('peer-1');
    expect(sessionsState.groups[0].dirPath).toBe(DIR_A);
  });

  it('resolves directories through the injected cwd resolver', () => {
    setSessionCwdResolver(() => DIR_B);
    state.sessions = [makeSession('s1', DIR_A)];
    expect(sessionsState.groups[0].dirPath).toBe(DIR_B);
  });
});

describe('nav list focus restore', () => {
  it('runs once per navList change, not per unrelated session field change', async () => {
    const { watchNavListRebuild } = await import('../renderer/composables/useAppBootstrap.js');
    const onRebuilt = vi.fn();
    const stop = watchNavListRebuild(onRebuilt);

    state.sessions = [makeSession('s1', DIR_A)];
    await nextTick();
    expect(onRebuilt).toHaveBeenCalledTimes(1);

    // A field the nav list does not depend on must not trigger focus restore.
    state.sessions[0] = { ...state.sessions[0], locked: true };
    await nextTick();
    expect(onRebuilt).toHaveBeenCalledTimes(1);

    state.sessions = [...state.sessions, makeSession('s2', DIR_B)];
    await nextTick();
    expect(onRebuilt).toHaveBeenCalledTimes(2);

    stop();
  });
});
