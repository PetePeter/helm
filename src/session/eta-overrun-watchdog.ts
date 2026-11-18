import type { SessionInfo, SessionEta } from '../types/session.js';
import type { SessionManager } from './manager.js';
import { logger } from '../utils/logger.js';

/**
 * ETA overrun watchdog — breaks death spirals. When a session runs past its own
 * estimate by its CLI type's threshold, Helm stops it (the CLI's stop action)
 * and tells it who to ask for help: its orchestrator, else the session that
 * created it, else the user. Once per estimate; a new estimate rearms it.
 */
export interface EtaOverrunDeps {
  sessions: Pick<SessionManager, 'getAllSessions' | 'getSession' | 'updateSession'>;
  /** Overrun threshold in percent for a CLI type; 0 = off. */
  percentFor: (cliType: string) => number;
  stop: (sessionId: string) => Promise<void>;
  /** True once the session has stopped working. */
  isIdle: (sessionId: string) => boolean;
  /** One-line system reminder; resolves whether delivery was confirmed submitted. */
  nudge: (sessionId: string, text: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A nudge typed into a CLI still cancelling its turn sits unsent (Codex ate the
 *  Enter), so stop until the session reads idle before nudging. */
const STOP_ATTEMPTS = 5;
const STOP_SETTLE_MS = 3_000;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function sweepEtaOverruns(deps: EtaOverrunDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  for (const session of deps.sessions.getAllSessions()) {
    const eta = session.eta;
    // Frozen sessions are parked, not spiralling: a nudge would only wake them.
    if (!eta || eta.overrunAt || session.remote || session.frozen) continue;
    const percent = deps.percentFor(session.cliType);
    if (!(percent > 0) || now < overrunDueAt(eta, percent)) continue;
    // Mark first: a failed stop must not retry every sweep.
    deps.sessions.updateSession(session.id, { eta: { ...eta, overrunAt: now } });
    try {
      if (!await stopUntilIdle(session.id, deps)) {
        logger.warn(`[EtaOverrun] ${session.id} still busy after ${STOP_ATTEMPTS} stops; not nudging`);
        continue;
      }
      if (!await deps.nudge(session.id, overrunNudge(session, eta, now, percent, deps.sessions))) {
        logger.warn(`[EtaOverrun] Nudge to ${session.id} was not confirmed submitted`);
      }
    } catch (err) {
      logger.warn(`[EtaOverrun] Could not stop ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function stopUntilIdle(sessionId: string, deps: EtaOverrunDeps): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
    await deps.stop(sessionId);
    await sleep(STOP_SETTLE_MS);
    if (deps.isIdle(sessionId)) return true;
  }
  return false;
}

function overrunDueAt(eta: SessionEta, percent: number): number {
  const start = eta.startedAt ?? eta.setAt;
  return start + (eta.at - start) * (1 + percent / 100);
}

function escalationTarget(session: SessionInfo, sessions: EtaOverrunDeps['sessions']): string {
  for (const id of [session.reportsTo, session.createdBySessionId]) {
    const target = id && id !== session.id ? sessions.getSession(id) : null;
    if (target) return `session "${target.name}" (${target.id}) with session_send_text`;
  }
  return 'the user';
}

function overrunNudge(session: SessionInfo, eta: SessionEta, now: number, percent: number, sessions: EtaOverrunDeps['sessions']): string {
  const start = eta.startedAt ?? eta.setAt;
  const est = Math.round((eta.at - start) / 60_000);
  const spent = Math.round((now - start) / 60_000);
  return `[HELM_OVERRUN] Helm stopped you: ${spent}m spent on a ${est}m estimate (over ${percent}%). `
    + `If you are stuck or going in circles, stop and ask ${escalationTarget(session, sessions)} for help. `
    + 'If you are done, call session_eta_clear. Otherwise set a new estimate with session_eta_set (rescope: "why") and carry on.';
}
