/**
 * PairingCoordinator — the global UX/safety gatekeeper around PeerPairing.
 *
 * INVARIANTS:
 *  - EXACTLY ONE active pairing session globally. Starting another while one is
 *    live is rejected (unless the prior expired/was cancelled/succeeded).
 *  - 180-second session expiry, enforced by a timer so a session nobody touches
 *    still ends on time and frees the slot.
 *  - EXACTLY ONE accept/reject decision per session (idempotent; the coordinator
 *    consumes the session on the first decision path).
 *  - Every attempt is a FRESH PeerPairing (fresh keys/nonce/sessionId/SAS) — this
 *    coordinator never reuses one.
 *
 * There is deliberately NO rate limiting: a failure cooldown locked the user out
 * of their own machines after a few cancelled attempts, and one-at-a-time plus the
 * SAS comparison already bound what a hostile LAN peer can do.
 *
 * The PeerPairing factory is injected so this logic is unit-testable with a fake.
 * A successful pairing consumes the active session immediately.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { PairingPeerInfo } from './peer-pairing.js';

/** 180-second pairing-session time-to-live. */
export const PAIRING_SESSION_TTL_MS = 180_000;

/** The minimal PeerPairing surface the coordinator drives. */
export interface CoordinatedPairing {
  begin(): void;
  accept(): void;
  reject(): void;
  cancel(reason?: string): void;
  getSas(): string | null;
  on(event: 'sas' | 'paired' | 'failed', listener: (arg: any) => void): unknown;
}

export interface PairingCoordinatorOptions {
  /** Injected factory — one FRESH pairing per start (real one wired in prod). */
  createPairing: (sessionId: string, peer: PairingPeerInfo) => CoordinatedPairing;
}

export interface StartResult {
  ok: boolean;
  sessionId?: string;
  reason?: string;
}

export interface ActiveSessionInfo {
  sessionId: string;
  peerMachineId: string;
  startedAt: number;
  sas: string | null;
}

interface ActiveSession {
  sessionId: string;
  peer: PairingPeerInfo;
  pairing: CoordinatedPairing;
  startedAt: number;
  decided: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

const ALREADY_ACTIVE: StartResult = { ok: false, reason: 'a pairing session is already active' };

export class PairingCoordinator {
  private readonly createPairing: PairingCoordinatorOptions['createPairing'];

  private active: ActiveSession | null = null;

  constructor(opts: PairingCoordinatorOptions) {
    this.createPairing = opts.createPairing;
  }

  /** Attempt to start a pairing session with `peer`. */
  start(peer: PairingPeerInfo): StartResult {
    if (this.active) return ALREADY_ACTIVE;

    const sessionId = randomUUID();
    const pairing = this.createPairing(sessionId, peer);
    this.adopt(sessionId, peer, pairing);

    pairing.begin();
    logger.info(`[PairingCoordinator] Started pairing ${sessionId} with ${peer.machineId}`);
    return { ok: true, sessionId };
  }

  /**
   * Adopt an INBOUND pairing a peer initiated, under the same one-at-a-time rule
   * as start().
   *
   * The sessionId comes FROM THE WIRE (PeerPairing filters frames on it, so both
   * ends must agree). It is untrusted: it is only ever used as a correlation key,
   * never as key material — the SAS transcript binds it, so a forged one changes
   * the code the users compare.
   */
  startInbound(peer: PairingPeerInfo, sessionId: string, pairing: CoordinatedPairing): StartResult {
    if (this.active) return ALREADY_ACTIVE;

    this.adopt(sessionId, peer, pairing);

    // No begin() — the responder answers the initiator's commit, it never leads.
    logger.info(`[PairingCoordinator] Adopted inbound pairing ${sessionId} from ${peer.machineId}`);
    return { ok: true, sessionId };
  }

  /**
   * Apply the user's ONE accept/reject decision for `sessionId`. A second decision
   * (or an unknown session) is ignored.
   */
  confirm(sessionId: string, accepted: boolean): void {
    const session = this.active;
    if (!session || session.sessionId !== sessionId || session.decided) return;
    session.decided = true;
    if (accepted) session.pairing.accept();
    else session.pairing.reject();
  }

  /** Cancel the active session (user abort / shutdown). */
  cancel(): void {
    this.end(this.active, 'cancelled');
  }

  /** Snapshot of the active session (empty when idle). */
  listActive(): ActiveSessionInfo[] {
    if (!this.active) return [];
    return [{
      sessionId: this.active.sessionId,
      peerMachineId: this.active.peer.machineId,
      startedAt: this.active.startedAt,
      sas: this.active.pairing.getSas(),
    }];
  }

  // ---------------------------------------------------------------- internals

  private adopt(sessionId: string, peer: PairingPeerInfo, pairing: CoordinatedPairing): void {
    const session: ActiveSession = {
      sessionId,
      peer,
      pairing,
      startedAt: Date.now(),
      decided: false,
      expiry: setTimeout(() => {
        logger.info(`[PairingCoordinator] Session ${sessionId} expired`);
        this.end(session, 'expired');
      }, PAIRING_SESSION_TTL_MS),
    };
    // A pending expiry must never hold the app open at quit.
    session.expiry.unref?.();
    this.active = session;

    pairing.on('paired', () => this.release(session));
    pairing.on('failed', () => this.release(session));
  }

  /** Abort `session` and free the slot, even if the pairing never reports back. */
  private end(session: ActiveSession | null, reason: string): void {
    if (!session || this.active !== session) return;
    session.pairing.cancel(reason);
    this.release(session);
  }

  private release(session: ActiveSession): void {
    clearTimeout(session.expiry);
    if (this.active === session) this.active = null;
  }
}
