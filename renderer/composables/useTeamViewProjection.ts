import { computed, type ComputedRef } from 'vue';
import { state } from '../state.js';
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
  return computed(() => {
    const outputBuffer = getTerminalManager()?.getOutputBuffer();
    return buildTeamViewProjection({
      ...options,
      sessions: state.sessions,
      projects: state.projects,
      stateForSession: session => state.sessionStates.get(session.id) ?? session.aiagentState ?? session.state,
      terminalTailForSession: sessionId => outputBuffer?.getLastLines(sessionId, options.tailLineLimit ?? 4) ?? [],
    });
  });
}
