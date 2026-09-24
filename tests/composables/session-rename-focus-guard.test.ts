/**
 * @vitest-environment jsdom
 *
 * Regression: a Session List rename left active while the user moved to Team
 * View stayed "stuck". The global Ctrl+Shift+R handler kept routing to the
 * (still editing) session-list rename whenever the dock did not believe Team
 * View was focused, and the gamepad path treats an active rename as owning
 * every button. The rename now ends as soon as dock focus leaves Sessions.
 *
 * Real dock workspace, real key router + terminal handlers, real TeamView.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TeamView from '../../renderer/components/panels/TeamView.vue';
import { useDockWorkspace } from '../../renderer/composables/useDockWorkspace';
import { useSessionRenameFocusGuard } from '../../renderer/composables/useSessionRenameFocusGuard';
import { sessionsState } from '../../renderer/screens/sessions-state';
import { startRename } from '../../renderer/sidebar/session-services';
import { createTerminalKeyHandlers } from '../../renderer/keyboard/handlers/terminal-keys';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../../renderer/keyboard/router';
import { PANE_OVERVIEW, PANE_SESSIONS, PANE_TERMINAL } from '../../renderer/dock-types';
import type { TeamViewProjection } from '../../renderer/team-view/team-view-projection';

const projection: TeamViewProjection = {
  deskCount: 1,
  visibleDeskCount: 1,
  departments: [{
    id: 'alpha', name: 'Alpha', collapsed: false, visibleDeskCount: 1, hiddenDeskCount: 0,
    desks: [{
      sessionId: 's1', name: 'Ada', cliType: 'codex', state: 'idle',
      terminalTail: [], hidden: false, focusIndex: 0, focusLabel: '^1',
      locked: false, artifactCount: 0, activityLevel: 'idle', notifications: [],
    }],
  }],
};

let uninstallRouter: (() => void) | null = null;

beforeEach(() => {
  (window as any).helm = { sessions: { onSessionMessageFlight: () => () => {}, ackSessionMessageFlight: async () => {} } };
});

afterEach(() => {
  uninstallRouter?.();
  uninstallRouter = null;
  resetKeyHandlers();
  sessionsState.editingSessionId = null;
  delete (window as any).helm;
});

describe('useSessionRenameFocusGuard', () => {
  it('ends a session-list rename when dock focus leaves Sessions, so Ctrl+Shift+R reaches Team View', async () => {
    const dock = useDockWorkspace();
    useSessionRenameFocusGuard(dock.focusedPaneId);
    uninstallRouter = installKeyRouter({
      getActiveSessionId: () => 's1',
      getFocusedPane: () => dock.focusedPaneId.value,
      isPaneVisible: () => true,
      isModalOpen: () => false,
    });
    createTerminalKeyHandlers({
      writePty: () => {},
      deliverText: async () => {},
      readClipboardText: async () => '',
      openPromptEditor: () => {},
      isEscProtectionArmed: () => false,
      openEscProtection: () => {},
      renameSession: startRename,
    }).forEach(registerKeyHandler);
    const wrapper = mount(TeamView, { props: { projection, activeSessionId: 's1' }, attachTo: document.body });

    dock.focusPane(PANE_SESSIONS);
    startRename('s1');
    await nextTick();
    expect(sessionsState.editingSessionId).toBe('s1');

    dock.focusPane(PANE_OVERVIEW);
    await nextTick();
    expect(sessionsState.editingSessionId).toBeNull();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('.team-actions__rename input').element);
    expect(sessionsState.editingSessionId).toBeNull();

    wrapper.unmount();
  });

  it('keeps a rename that moves focus INTO Sessions (started from the terminal)', async () => {
    const dock = useDockWorkspace();
    useSessionRenameFocusGuard(dock.focusedPaneId);
    expect(dock.focusedPaneId.value).toBe(PANE_TERMINAL);

    startRename('s1');
    dock.focusPane(PANE_SESSIONS);
    await nextTick();

    expect(sessionsState.editingSessionId).toBe('s1');
  });
});
