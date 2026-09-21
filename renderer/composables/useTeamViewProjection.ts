import { computed, onScopeDispose, ref, type ComputedRef } from 'vue';
import { state } from '../state.js';
import { useSessionsScreenStore } from '../stores/sessions-screen.js';
import { getTerminalManager } from '../runtime/terminal-provider.js';
import {
  buildTeamViewProjection,
  type TeamViewProjection,
  type TeamViewProjectionInput,
} from '../team-view/team-view-projection.js';

/**
 * Vue seam for the future Team View renderer. It reads the same session store
 * and renderer PTY buffer as existing surfaces, without taking terminal focus
 * or creating a second output store.
 */
export function useTeamViewProjection(
  options: Omit<TeamViewProjectionInput, 'sessions' | 'projects' | 'stateForSession' | 'terminalTailForSession'> = {},
): ComputedRef<TeamViewProjection> {
  const outputVersion = ref(0);
  const sessionsScreen = useSessionsScreenStore();
  const outputBuffer = getTerminalManager()?.getOutputBuffer();
  const invalidate = () => { outputVersion.value++; };
  outputBuffer?.onUpdate?.(invalidate);
  onScopeDispose(() => outputBuffer?.offUpdate?.(invalidate));

  return computed(() => {
    // Reading the version makes output-buffer updates a Vue dependency without
    // copying PTY data into another store.
    outputVersion.value;
    return buildTeamViewProjection({
      ...options,
      sessions: state.sessions,
      projects: state.projects,
      stateForSession: session => state.sessionStates.get(session.id) ?? session.aiagentState ?? session.state,
      artifactCountForSession: sessionId => state.artifactCounts.get(sessionId),
      hiddenSessionIds: sessionsScreen.hiddenSessionIds.value,
      terminalTailForSession: sessionId => outputBuffer?.getLastLines(sessionId, options.tailLineLimit ?? 4) ?? [],
    });
  });
}
