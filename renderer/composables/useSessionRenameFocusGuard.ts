import { watch, type Ref } from 'vue';
import { PANE_SESSIONS, type PaneId } from '../dock-types.js';
import { sessionsState } from '../screens/sessions-state.js';
import { cancelRename } from '../sidebar/session-services.js';

/**
 * A Session List rename belongs to the Sessions pane. Left active after focus
 * moves elsewhere it goes stale but keeps owning input: the gamepad path hands
 * every button to an active rename, and Ctrl+Shift+R keeps re-targeting it
 * instead of the pane the user is actually in. End it
 * the moment dock focus leaves Sessions — an abandoned rename is a cancel.
 */
export function useSessionRenameFocusGuard(focusedPaneId: Ref<PaneId | null>): void {
  watch(focusedPaneId, (pane) => {
    if (pane !== PANE_SESSIONS && sessionsState.editingSessionId) cancelRename();
  });
}
