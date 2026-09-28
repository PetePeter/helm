/**
 * PeerPairing — the SAS (Short Authentication String) numeric-comparison pairing
 * state machine for a SINGLE pairing attempt between an initiator (I) and a
 * responder (R).
 *
 * PROTOCOL (commit-then-reveal; codex-reviewed — implement exactly):
 *  1. COMMIT   each side generates a fresh ephemeral X25519 keypair + 32-byte
 *              nonce and sends SHA256(lp(pubDER, nonce)). I commits first, then R.
 *              Neither reveals until BOTH commitments are exchanged.
 *  2. REVEAL   I sends {pubDER, nonce}; R checks it against I's commitment BEFORE
 *              proceeding, then R reveals; I checks R's. Any mismatch → ABORT.
 *              This blocks an active MITM from grinding a second exchange to match
 *              the SAS.
 *  3. DERIVE   each side imports the peer key (must be x25519), computes the ECDH
 *              shared secret, and builds the canonical role-ordered transcript.
 *  4. SAS      6-digit code = HKDF(shared, transcript, 'sas', 4)→uint32→mod 1e6.
 *              Emitted for the USER to compare on both screens. Same iff no MITM.
 *  5. ACCEPT   accept() is a LOCAL user action on BOTH machines. On accept we send
 *              a confirm-MAC keyed from the ECDH secret (NOT the SAS).
 *  6. FINALIZE only after BOTH local accept() AND a verified peer confirm-MAC: we
 *              ATOMICALLY persist pin + secret + bidirectional PeerConfig. Any
 *              persist error ROLLS BACK all three (all-or-nothing) — no usable
 *              PeerConfig remains. Then emit 'paired'.
 *  7. ABORT    wrong SAS (reject), commitment mismatch, DH failure, bad confirm,
 *              cancel → destroy all ephemeral state, persist NOTHING.
 *
 * SECURITY: the 6-digit code is a KDF OUTPUT, never an input to any MAC/KDF. No
 * secret/psk material is ever logged or placed in an error/event.
 *
 * CHANNEL-AGNOSTIC: transport is injected as `channel.send`; inbound frames are
 * fed via `handleMessage`. Tests use an in-memory duplex pair; the real socket is
 * wired by a later plan.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { PinnedCertStore } from './pinned-cert-store.js';
import type { SecretStore } from './secret-store.js';
import type { PeerConfigManager } from '../../session/peer-config-manager.js';
import {
  generateEphemeralKeyPair,
  computeCommitment,
  verifyCommitment,
  computeSharedSecret,
  buildPairingTranscript,
  deriveSas,
  computeConfirmMac,
  verifyConfirmMac,
  derivePsk,
  type EphemeralKeyPair,
} from './pairing-crypto.js';

const PAIRING_VERSION = 1;

/** A control frame exchanged over the injected channel. */
export interface PairingMessage {
  t: 'pair';
  step: 'commit' | 'reveal' | 'confirm';
  sessionId: string;
  /** commit */
  commitment?: string; // base64
  /** reveal */
  pubkeyDER?: string;  // base64
  nonce?: string;      // base64
  /** confirm */
  mac?: string;        // base64
}

/** The transport this pairing writes to. Inbound frames arrive via handleMessage. */
export interface PairingChannel {
  send(msg: PairingMessage): void;
}

export interface PairingIdentity {
  machineId: string;
  certFp: string;
}

export interface PairingPeerInfo {
  machineId: string;
  certFp: string;
  alias: string;
  address: string;
}

export interface PeerPairingOptions {
  role: 'initiator' | 'responder';
  sessionId: string;
  channel: PairingChannel;
  now?: () => number;
  pinnedCertStore: PinnedCertStore;
  secretStore: SecretStore;
  peerConfigManager: PeerConfigManager;
  self: PairingIdentity;
  peer: PairingPeerInfo;
}

type Phase = 'idle' | 'committed' | 'revealed' | 'sas-ready' | 'finalized' | 'failed';

export class PeerPairing extends EventEmitter {
  private readonly opts: PeerPairingOptions;
  private readonly now: () => number;

  private phase: Phase = 'idle';
  private decided = false;            // one accept/reject per session
  private localAccepted = false;
  private peerConfirmVerified = false;

  private ownKeys: EphemeralKeyPair | null = null;
  private ownNonce: Buffer | null = null;
  private peerCommitment: Buffer | null = null;
  private peerPubDER: Buffer | null = null;
  private peerNonce: Buffer | null = null;
  private commitmentsExchanged = false;

  private shared: Buffer | null = null;
  private transcript: Buffer | null = null;
  private sas: string | null = null;

  constructor(opts: PeerPairingOptions) {
    super();
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Kick off the flow (initiator only). Generates fresh keys + sends commit. */
  begin(): void {
    if (this.phase !== 'idle') return;
    if (this.opts.role !== 'initiator') return;
    this.generateAndCommit();
  }

  /** Feed an inbound control frame. Never throws — malformed frames abort. */
  handleMessage(msg: PairingMessage): void {
    if (this.phase === 'failed' || this.phase === 'finalized') return;
    if (!msg || msg.t !== 'pair' || msg.sessionId !== this.opts.sessionId) return;
    try {
      switch (msg.step) {
        case 'commit': return this.onCommit(msg);
        case 'reveal': return this.onReveal(msg);
        case 'confirm': return this.onConfirm(msg);
      }
    } catch (err) {
      this.abort(`protocol-error: ${(err as Error)?.message?.slice(0, 80)}`);
    }
  }

  /** LOCAL user confirmation that the two SAS codes match. Idempotent. */
  accept(): void {
    if (this.decided) return;
    if (this.phase !== 'sas-ready') return;
    this.decided = true;
    this.localAccepted = true;
    this.sendConfirm();
    this.tryFinalize();
  }

  /** LOCAL user rejection (codes differ / user cancels). Idempotent. */
  reject(): void {
    if (this.decided) return;
    this.decided = true;
    this.abort('user-rejected');
  }

  /** Cancel from outside (expiry/coordinator). Persists nothing. */
  cancel(reason = 'cancelled'): void {
    if (this.phase === 'finalized') return;
    this.abort(reason);
  }

  /** Current SAS (once derived) — for a coordinator to surface. */
  getSas(): string | null {
    return this.sas;
  }

  /**
   * TEST/AUDIT ONLY: whether the raw ECDH shared secret is still held in memory.
   * Must be false after both a successful pairing (terminal 'finalized') and any
   * abort, so no DH secret lingers past the handshake.
   */
  hasSharedSecretInMemory(): boolean {
    return this.shared !== null;
  }

  // -------------------------------------------------------------- commit/reveal

  private generateAndCommit(): void {
    this.ownKeys = generateEphemeralKeyPair();
    this.ownNonce = randomNonce();
    const commitment = computeCommitment(this.ownKeys.publicKeyDER, this.ownNonce);
    this.phase = 'committed';
    this.send({ step: 'commit', commitment: commitment.toString('base64') });
  }

  private onCommit(msg: PairingMessage): void {
    if (!msg.commitment) return this.abort('bad-commit');
    this.peerCommitment = Buffer.from(msg.commitment, 'base64');

    if (this.opts.role === 'responder' && this.phase === 'idle') {
      // Responder commits AFTER seeing the initiator's commit.
      this.generateAndCommit();
    }

    // Once both commitments are known, the initiator reveals first.
    if (!this.commitmentsExchanged && this.ownKeys && this.peerCommitment) {
      this.commitmentsExchanged = true;
      if (this.opts.role === 'initiator') this.sendReveal();
    }
  }

  private onReveal(msg: PairingMessage): void {
    if (!this.commitmentsExchanged) return this.abort('reveal-before-commit');
    if (!msg.pubkeyDER || !msg.nonce || !this.peerCommitment) return this.abort('bad-reveal');

    const peerPubDER = Buffer.from(msg.pubkeyDER, 'base64');
    const peerNonce = Buffer.from(msg.nonce, 'base64');

    // Verify the reveal matches the peer's earlier commitment BEFORE proceeding.
    if (!verifyCommitment(this.peerCommitment, peerPubDER, peerNonce)) {
      return this.abort('commitment-mismatch');
    }
    this.peerPubDER = peerPubDER;
    this.peerNonce = peerNonce;

    // Responder reveals only after it has verified the initiator's reveal.
    if (this.opts.role === 'responder' && this.phase === 'committed') {
      this.sendReveal();
    }

    this.deriveAndEmitSas();
  }

  private sendReveal(): void {
    if (!this.ownKeys || !this.ownNonce) return this.abort('reveal-without-keys');
    this.phase = 'revealed';
    this.send({
      step: 'reveal',
      pubkeyDER: this.ownKeys.publicKeyDER.toString('base64'),
      nonce: this.ownNonce.toString('base64'),
    });
  }

  // --------------------------------------------------------------- derive / sas

  private deriveAndEmitSas(): void {
    if (this.sas) return; // already derived
    if (!this.ownKeys || !this.ownNonce || !this.peerPubDER || !this.peerNonce) return;

    // Import peer key (must be x25519) + compute the ECDH shared secret.
    this.shared = computeSharedSecret(this.ownKeys.privateKey, this.peerPubDER);
    this.transcript = this.buildTranscript();
    this.sas = deriveSas(this.shared, this.transcript);
    this.phase = 'sas-ready';
    this.emit('sas', this.sas);
  }

  /** Role-ordered canonical transcript (identical bytes on both peers). */
  private buildTranscript(): Buffer {
    const self = this.opts.self;
    const peer = this.opts.peer;
    const iAmInitiator = this.opts.role === 'initiator';

    const initiatorMachineId = iAmInitiator ? self.machineId : peer.machineId;
    const responderMachineId = iAmInitiator ? peer.machineId : self.machineId;
    const initiatorCertFp = iAmInitiator ? self.certFp : peer.certFp;
    const responderCertFp = iAmInitiator ? peer.certFp : self.certFp;
    const initiatorPubDER = iAmInitiator ? this.ownKeys!.publicKeyDER : this.peerPubDER!;
    const responderPubDER = iAmInitiator ? this.peerPubDER! : this.ownKeys!.publicKeyDER;
    const initiatorNonce = iAmInitiator ? this.ownNonce! : this.peerNonce!;
    const responderNonce = iAmInitiator ? this.peerNonce! : this.ownNonce!;

    return buildPairingTranscript({
      version: PAIRING_VERSION,
      sessionId: this.opts.sessionId,
      initiatorMachineId,
      responderMachineId,
      initiatorCertFp,
      responderCertFp,
      initiatorPubDER,
      responderPubDER,
      initiatorNonce,
      responderNonce,
    });
  }

  // ---------------------------------------------------------------- confirm

  private sendConfirm(): void {
    if (!this.shared || !this.transcript) return;
    const mac = computeConfirmMac(this.shared, this.transcript);
    this.send({ step: 'confirm', mac: mac.toString('base64') });
  }

  private onConfirm(msg: PairingMessage): void {
    if (!msg.mac) return this.abort('bad-confirm');
    // A confirm arriving BEFORE the SAS is derived is a protocol violation: on an
    // honest channel confirm always follows reveal. Treating it as an error (not a
    // silent drop) denies an attacker a free forged-confirm probe and aborts with
    // zero persistence rather than losing a legit-but-reordered frame silently.
    if (!this.shared || !this.transcript) return this.abort('out-of-order-confirm');
    const providedMac = Buffer.from(msg.mac, 'base64');
    if (!verifyConfirmMac(this.shared, this.transcript, providedMac)) {
      return this.abort('bad-confirm-mac');
    }
    this.peerConfirmVerified = true;
    this.tryFinalize();
  }

  // ---------------------------------------------------------------- finalize

  /** Finalize only when BOTH local accept AND a verified peer confirm are in. */
  private tryFinalize(): void {
    if (this.phase === 'finalized' || this.phase === 'failed') return;
    if (!this.localAccepted || !this.peerConfirmVerified) return;
    if (!this.shared || !this.transcript) return;

    const psk = derivePsk(this.shared, this.transcript);
    const pskRef = `peer-${this.opts.peer.machineId}`;

    // Track exactly what we wrote so a mid-way failure rolls back cleanly.
    let existing = this.opts.peerConfigManager.getByMachineId(this.opts.peer.machineId);
    let wrotePin = false;
    let wroteSecret = false;
    let peerId: string | null = null;

    try {
      // Resolve a stable peerId to pin against (existing on re-pair, else new upsert).
      const peer = this.opts.peerConfigManager.upsertByMachineId({
        machineId: this.opts.peer.machineId,
        alias: this.opts.peer.alias,
        address: this.opts.peer.address,
        pskRef,
        inbound: existing?.inbound ?? false, // deny-by-default for a fresh peer; preserve on re-pair
        direction: 'bidirectional',
      });
      peerId = peer.id;

      const pinOutcome = this.opts.pinnedCertStore.recordIfAbsent(peerId, this.opts.peer.certFp);
      if (pinOutcome === 'exists-mismatch') {
        throw new Error('cert-pin-mismatch'); // a different cert is pinned — hard stop
      }
      wrotePin = pinOutcome === 'recorded';

      this.opts.secretStore.set(pskRef, psk);
      wroteSecret = true;

      this.phase = 'finalized';
      this.emit('paired', { peerId, machineId: this.opts.peer.machineId });
      logger.info(`[PeerPairing] Paired with ${this.opts.peer.machineId} (peer ${peerId})`);
      // 'finalized' is terminal — zero the raw DH secret + transcript now so they
      // do not linger in the heap. The PSK is safely in the SecretStore already.
      this.zeroEphemeral();
    } catch (err) {
      // ROLLBACK — undo everything THIS pairing wrote so no usable config remains.
      try { if (wroteSecret) this.opts.secretStore.remove(pskRef); } catch { /* ignore */ }
      try { if (wrotePin && peerId) this.opts.pinnedCertStore.removePin(peerId); } catch { /* ignore */ }
      try {
        if (peerId && !existing) {
          // Fresh peer — remove it entirely.
          this.opts.peerConfigManager.remove(peerId);
        } else if (peerId && existing) {
          // Re-pair — restore the pre-existing peer's fields (upsert mutated them
          // in place, and the new pskRef's secret was just rolled back).
          this.opts.peerConfigManager.update(peerId, {
            alias: existing.alias,
            address: existing.address,
            pskRef: existing.pskRef,
            inbound: existing.inbound,
            direction: existing.direction,
          });
        }
      } catch { /* ignore */ }
      psk.fill(0);
      this.abort(`persist-failed: ${(err as Error)?.message?.slice(0, 60)}`);
      return;
    } finally {
      // Zero the working psk copy regardless (the SecretStore holds its own).
      psk.fill(0);
    }
  }

  // ---------------------------------------------------------------- helpers

  private send(partial: Omit<PairingMessage, 't' | 'sessionId'>): void {
    this.opts.channel.send({ t: 'pair', sessionId: this.opts.sessionId, ...partial });
  }

  private abort(reason: string): void {
    if (this.phase === 'finalized' || this.phase === 'failed') return;
    this.phase = 'failed';
    this.zeroEphemeral();
    logger.warn(`[PeerPairing] Aborted (${reason})`);
    this.emit('failed', { reason });
  }

  private zeroEphemeral(): void {
    try { this.shared?.fill(0); } catch { /* ignore */ }
    try { this.ownNonce?.fill(0); } catch { /* ignore */ }
    this.shared = null;
    this.transcript = null;
    this.sas = null;
    this.ownKeys = null;
    this.ownNonce = null;
    this.peerPubDER = null;
    this.peerNonce = null;
    this.peerCommitment = null;
  }
}

/** 32 cryptographically-random nonce bytes. */
function randomNonce(): Buffer {
  return randomBytes(32);
}
