/**
 * @vitest-environment jsdom
 *
 * Regression: a Session List rename left active after focus moved to another
 * pane stayed "stuck" — the gamepad path treats an active rename as owning
 * every button. The rename now ends as soon as dock focus leaves Sessions.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { useDockWorkspace } from '../../renderer/composables/useDockWorkspace';
import { useSessionRenameFocusGuard } from '../../renderer/composables/useSessionRenameFocusGuard';
import { sessionsState } from '../../renderer/screens/sessions-state';
import { startRename } from '../../renderer/sidebar/session-services';
import { PANE_MEMORIES, PANE_SESSIONS, PANE_TERMINAL } from '../../renderer/dock-types';

afterEach(() => {
  sessionsState.editingSessionId = null;
});

describe('useSessionRenameFocusGuard', () => {
  it('ends a session-list rename when dock focus leaves Sessions', async () => {
    const dock = useDockWorkspace();
    useSessionRenameFocusGuard(dock.focusedPaneId);

    dock.focusPane(PANE_SESSIONS);
    startRename('s1');
    await nextTick();
    expect(sessionsState.editingSessionId).toBe('s1');

    dock.focusPane(PANE_MEMORIES);
    await nextTick();
    expect(sessionsState.editingSessionId).toBeNull();
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
