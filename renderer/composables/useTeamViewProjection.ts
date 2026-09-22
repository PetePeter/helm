import { computed, onScopeDispose, ref, type ComputedRef } from 'vue';
import { state } from '../state.js';
import { useSessionsScreenStore } from '../stores/sessions-screen.js';
import { getTerminalManager, onTerminalManagerChanged } from '../runtime/terminal-provider.js';
import type { PtyOutputBuffer } from '../terminal/pty-output-buffer.js';
import {
  buildTeamViewProjection,
  type TeamViewProjection,
  type TeamViewProjectionInput,
} from '../team-view/team-view-projection.js';

/** PTY chunks arrive in bursts; recompute the projection at most this often. */
const OUTPUT_INVALIDATE_THROTTLE_MS = 250;

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

  // The manager is constructed by useAppBootstrap AFTER dock panes mount, so
  // the buffer is resolved reactively rather than captured once at setup —
  // a one-time read here is permanently null and the desk mirror stays empty.
  let outputBuffer = getTerminalManager()?.getOutputBuffer() ?? null;
  let detachBuffer: (() => void) | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = () => {
    // Trailing-edge throttle: bursts of pty:data collapse into one recompute.
    if (throttleTimer !== null) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      outputVersion.value++;
    }, OUTPUT_INVALIDATE_THROTTLE_MS);
  };
  const attachBuffer = (buffer: PtyOutputBuffer | null): void => {
    if (buffer === outputBuffer) return;
    detachBuffer?.();
    detachBuffer = null;
    outputBuffer = buffer;
    if (buffer) {
      buffer.onUpdate?.(invalidate);
      detachBuffer = () => buffer.offUpdate?.(invalidate);
      outputVersion.value++;
    }
  };
  attachBuffer(getTerminalManager()?.getOutputBuffer() ?? null);
  const stopManagerWatch = onTerminalManagerChanged(tm => attachBuffer(tm?.getOutputBuffer() ?? null));
  onScopeDispose(() => {
    stopManagerWatch();
    detachBuffer?.();
    if (throttleTimer !== null) clearTimeout(throttleTimer);
  });

  return computed(() => {
    // Reading the version makes output-buffer updates a Vue dependency without
    // copying PTY data into another store.
    outputVersion.value;
    // A setup store unwraps its computed refs on the store instance — read the
    // Map/Set directly; a `.value` here is silently undefined at runtime.
    const shortcutMap = sessionsScreen.sessionShortcutMap ?? null;
    return buildTeamViewProjection({
      ...options,
      sessions: state.sessions,
      projects: state.projects,
      stateForSession: session => state.sessionStates.get(session.id) ?? session.aiagentState ?? session.state,
      activityLevelForSession: sessionId => state.sessionActivityLevels.get(sessionId),
      artifactCountForSession: sessionId => state.artifactCounts.get(sessionId),
      hiddenSessionIds: sessionsScreen.hiddenSessionIds ?? new Set<string>(),
      collapsedDepartmentIds: new Set(sessionsScreen.sessionsState.groupPrefs.teamViewCollapsed ?? []),
      ...(shortcutMap ? { focusSlotForSession: (sessionId: string) => shortcutMap.get(sessionId) } : {}),
      terminalTailForSession: sessionId => outputBuffer?.getLastLines(sessionId, options.tailLineLimit ?? 4) ?? [],
    });
  });
}
