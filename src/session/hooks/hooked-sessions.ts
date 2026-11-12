import type { SessionManager } from '../manager.js';
import type { StateDetector } from '../state-detector.js';
import type { SessionInfo } from '../../types/session.js';
import type { HooksInstalledFn } from './hook-capability.js';

/**
 * Keeps SessionInfo.hooked (and the StateDetector's copy) in step with each
 * session's CLI type: resolved from the on-disk hook install when the session
 * appears and again when its CLI type changes (a CLI switch).
 *
 * Resolution only ever upgrades: a hook event (HookTracker) is proof on its
 * own, so a disk read that says "not installed" never undoes it. Only a CLI
 * switch resets a session to unhooked before resolving the new type.
 */
export function trackHookedSessions(
  sessionManager: SessionManager,
  stateDetector: StateDetector,
  hooksInstalled: HooksInstalledFn,
): void {
  const resolvedType = new Map<string, string>();

  const resolve = (sessionId: string, cliType: string): void => {
    resolvedType.set(sessionId, cliType);
    void hooksInstalled(cliType).then((installed) => {
      const session = sessionManager.getSession(sessionId);
      if (!installed || !session || session.cliType !== cliType) return;
      stateDetector.setHooked(sessionId, true);
      if (!session.hooked) sessionManager.updateSession(sessionId, { hooked: true });
    });
  };

  const onSession = (session: SessionInfo): void => {
    const previous = resolvedType.get(session.id);
    if (previous === session.cliType) return;
    if (previous !== undefined && session.hooked) {
      stateDetector.setHooked(session.id, false);
      // Keep-warm needs hooks; left on, it would only exempt the session from freezing.
      sessionManager.updateSession(session.id, { hooked: false, keepWarm: undefined });
    }
    resolve(session.id, session.cliType);
  };

  for (const session of sessionManager.getAllSessions()) onSession(session);
  sessionManager.on('session:added', onSession);
  sessionManager.on('session:updated', onSession);
  sessionManager.on('session:removed', ({ session }: { session: SessionInfo }) => resolvedType.delete(session.id));
}
