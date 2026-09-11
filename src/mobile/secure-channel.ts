/**
 * secure-channel — an authenticated, encrypted, replay-resistant message
 * channel over ANY duplex byte pipe.
 *
 * BLE's own pairing is not trustworthy enough to carry terminal control (Just
 * Works offers no MITM protection), so confidentiality and authentication are
 * app-layer and completely transport-agnostic. This file has ZERO BLE/GATT
 * awareness by design: it is unit-testable over an in-memory pipe alone, and the
 * same channel would run unchanged over a socket or a USB link.
 *
 * The handshake reuses `src/mcp/peer/pairing-crypto.ts` VERBATIM — X25519,
 * commit-then-reveal, the canonical length-prefixed transcript, SAS and
 * confirm-MAC. If that file ever needs editing to serve this one, the carrier
 * has leaked into the crypto and the change is wrong.
 *
 * ```mermaid
 * sequenceDiagram
 *     participant I as Initiator
 *     participant R as Responder
 *     I->>R: HELLO  version, sessionId, machineId, commitment
 *     R->>I: RESPONSE  machineId, pubKey, nonce
 *     I->>R: REVEAL  pubKey, nonce
 *     Note over I,R: both derive shared secret, transcript, SAS, direction keys
 *     I->>R: CONFIRM  mac
 *     R->>I: CONFIRM  mac
 *     Note over I,R: user compares 6-digit SAS (first pairing only)
 *     I-->>R: DATA  AES-256-GCM frames
 * ```
 *
 * SECURITY INVARIANTS (do not weaken):
 *  - No plaintext fallback exists. Every failure path closes the channel.
 *  - Nonce reuse is structurally impossible: per-direction keys, implicit
 *    monotonic counters (see `aead.ts`).
 *  - Keys live only in memory. Only the pairing PSK is ever persisted, and that
 *    is the caller's job, following the fleet split of peers.yaml vs
 *    peer-secrets.yaml.
 *  - On a first pairing the user MUST compare the SAS; application data cannot
 *    be sent before `confirmSas(true)`.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  buildPairingTranscript,
  computeCommitment,
  computeConfirmMac,
  computeSharedSecret,
  deriveSas,
  derivePsk,
  generateEphemeralKeyPair,
  verifyCommitment,
  verifyConfirmMac,
  type EphemeralKeyPair,
} from '../mcp/peer/pairing-crypto';
import { AeadReceiver, AeadSender, bindPsk, deriveDirectionKeys } from './aead';

/** Wire protocol version — bumped only on a breaking framing change. */
export const SECURE_CHANNEL_VERSION = 1;

/** Upper bound on a single wire frame, so a hostile length cannot exhaust memory. */
export const MAX_FRAME_BYTES = 128 * 1024;

/** Nonce length used in the commit-then-reveal exchange. */
export const HANDSHAKE_NONCE_BYTES = 32;

/**
 * BLE has no TLS certificate to bind, so the transcript's certificate-fingerprint
 * fields carry this fixed carrier label instead of a per-peer value. Identity
 * binding comes from the machine ids, the commitment and the SAS comparison.
 */
export const CARRIER_FINGERPRINT = 'helm-mobile-ble-v1';

/** Minimal duplex byte pipe. A BLE GATT link, a socket and a test double all fit. */
export interface BytePipe {
  write(data: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type ChannelRole = 'initiator' | 'responder';

export interface SecureChannelOptions {
  pipe: BytePipe;
  role: ChannelRole;
  /** This end's stable machine identifier; bound into the transcript. */
  machineId: string;
  /** Required for the initiator, which names the session; the responder adopts it. */
  sessionId?: string;
  /** Pairing PSK from a previous SAS comparison. Present ⇒ no SAS prompt. */
  psk?: Buffer;
}

enum FrameType {
  Hello = 0x01,
  Response = 0x02,
  Reveal = 0x03,
  Confirm = 0x04,
  Data = 0x05,
}

export class SecureChannel extends EventEmitter {
  /**
   * Run the handshake and resolve with a live channel. Rejects — and closes the
   * pipe — on any authentication failure; it never resolves a degraded channel.
   */
  static open(options: SecureChannelOptions): Promise<SecureChannel> {
    const channel = new SecureChannel(options);
    return channel.runHandshake();
  }

  private readonly pipe: BytePipe;
  private readonly role: ChannelRole;
  private readonly machineId: string;
  private readonly psk?: Buffer;

  private inbound = Buffer.alloc(0);
  private isClosed = false;

  private readonly keyPair: EphemeralKeyPair = generateEphemeralKeyPair();
  private readonly nonce = randomBytes(HANDSHAKE_NONCE_BYTES);

  private sessionId: string;
  private peerMachineId = '';
  private peerPubDER: Buffer | null = null;
  private peerNonce: Buffer | null = null;
  /** Responder-side only: the initiator's commitment, checked at REVEAL. */
  private peerCommitment: Buffer | null = null;

  private transcript: Buffer | null = null;
  private sharedSecret: Buffer | null = null;
  /** Shared secret bound to the pairing PSK — the confirm-MAC keying material. */
  private confirmSecret: Buffer | null = null;
  private sender: AeadSender | null = null;
  private receiver: AeadReceiver | null = null;

  private sasDigits = '';
  private derivedPsk: Buffer | null = null;
  private sasConfirmed = false;
  private confirmSent = false;
  private peerConfirmed = false;
  private handshakeSettled = false;

  /** Messages decrypted before the local user finished comparing the SAS. */
  private readonly pendingMessages: Buffer[] = [];

  private resolveHandshake: ((channel: SecureChannel) => void) | null = null;
  private rejectHandshake: ((error: Error) => void) | null = null;

  private constructor(options: SecureChannelOptions) {
    super();
    this.pipe = options.pipe;
    this.role = options.role;
    this.machineId = options.machineId;
    this.psk = options.psk;
    this.sessionId = options.sessionId ?? '';
    if (this.role === 'initiator' && !this.sessionId) {
      throw new Error('An initiator must supply a sessionId');
    }
  }

  /** The 6-digit code the user compares on both screens. */
  get sas(): string {
    return this.sasDigits;
  }

  /** True until the user has confirmed the SAS on a first pairing. */
  get sasConfirmationRequired(): boolean {
    return !this.psk && !this.sasConfirmed;
  }

  /**
   * The PSK to persist so future connections skip the SAS comparison. Derived,
   * never transmitted.
   */
  get pairingPsk(): Buffer {
    if (!this.derivedPsk) throw new Error('Handshake has not completed');
    return this.derivedPsk;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Record the user's verdict on the SAS. `false` — or any mismatch — closes the
   * channel; there is no "continue anyway".
   */
  confirmSas(matches: boolean): void {
    if (this.isClosed) return;
    if (!matches) {
      this.close('SAS rejected by the user');
      return;
    }
    this.sasConfirmed = true;
    this.flushPending();
  }

  /** Encrypt and send one application message. */
  send(message: Buffer): void {
    if (this.isClosed) throw new Error('SecureChannel is closed');
    if (!this.sender) throw new Error('Handshake has not completed');
    if (this.sasConfirmationRequired) {
      throw new Error('SAS must be confirmed before sending application data');
    }
    this.writeFrame(FrameType.Data, this.sender.seal(message));
  }

  /** Close the channel and drop all key material. Idempotent. */
  close(reason = 'closed'): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.sender = null;
    this.receiver = null;
    this.sharedSecret = null;
    this.pendingMessages.length = 0;
    try {
      this.pipe.close();
    } catch {
      // A pipe that is already gone is not an error worth propagating.
    }
    this.settleHandshake(new Error(reason));
    this.emit('close', reason);
  }

  // ---------------------------------------------------------------- handshake

  private runHandshake(): Promise<SecureChannel> {
    const promise = new Promise<SecureChannel>((resolve, reject) => {
      this.resolveHandshake = resolve;
      this.rejectHandshake = reject;
    });

    this.pipe.onData((chunk) => this.onPipeData(chunk));
    this.pipe.onClose(() => this.close('pipe closed'));

    if (this.role === 'initiator') {
      this.writeFrame(FrameType.Hello, encodeFields([
        uint32(SECURE_CHANNEL_VERSION),
        Buffer.from(this.sessionId, 'utf8'),
        Buffer.from(this.machineId, 'utf8'),
        computeCommitment(this.keyPair.publicKeyDER, this.nonce),
      ]));
    }

    return promise;
  }

  private onPipeData(chunk: Buffer): void {
    if (this.isClosed) return;
    this.inbound = Buffer.concat([this.inbound, chunk]);

    while (!this.isClosed && this.inbound.length >= 4) {
      const length = this.inbound.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.close('frame length out of range');
        return;
      }
      if (this.inbound.length < 4 + length) return;
      const payload = this.inbound.subarray(4, 4 + length);
      this.inbound = this.inbound.subarray(4 + length);
      try {
        this.handleFrame(payload[0] as FrameType, Buffer.from(payload.subarray(1)));
      } catch (error) {
        this.close((error as Error).message);
        return;
      }
    }
  }

  private handleFrame(type: FrameType, body: Buffer): void {
    switch (type) {
      case FrameType.Hello:
        return this.handleHello(body);
      case FrameType.Response:
        return this.handleResponse(body);
      case FrameType.Reveal:
        return this.handleReveal(body);
      case FrameType.Confirm:
        return this.handleConfirm(body);
      case FrameType.Data:
        return this.handleData(body);
      default:
        throw new Error(`Unknown frame type ${type}`);
    }
  }

  private handleHello(body: Buffer): void {
    if (this.role !== 'responder') throw new Error('HELLO received by the initiator');
    const [version, sessionId, machineId, commitment] = decodeFields(body, 4);
    if (version.readUInt32BE(0) !== SECURE_CHANNEL_VERSION) {
      throw new Error('Unsupported secure channel version');
    }
    this.sessionId = sessionId.toString('utf8');
    this.peerMachineId = machineId.toString('utf8');
    this.peerCommitment = commitment;

    this.writeFrame(FrameType.Response, encodeFields([
      Buffer.from(this.machineId, 'utf8'),
      this.keyPair.publicKeyDER,
      this.nonce,
    ]));
  }

  private handleResponse(body: Buffer): void {
    if (this.role !== 'initiator') throw new Error('RESPONSE received by the responder');
    const [machineId, pubDER, nonce] = decodeFields(body, 3);
    this.peerMachineId = machineId.toString('utf8');
    this.peerPubDER = pubDER;
    this.peerNonce = nonce;

    this.writeFrame(FrameType.Reveal, encodeFields([this.keyPair.publicKeyDER, this.nonce]));
    this.deriveSession();
  }

  private handleReveal(body: Buffer): void {
    if (this.role !== 'responder') throw new Error('REVEAL received by the initiator');
    const [pubDER, nonce] = decodeFields(body, 2);
    if (!this.peerCommitment || !verifyCommitment(this.peerCommitment, pubDER, nonce)) {
      throw new Error('Commitment does not match the revealed key');
    }
    this.peerPubDER = pubDER;
    this.peerNonce = nonce;
    this.deriveSession();
  }

  private handleConfirm(body: Buffer): void {
    const [mac] = decodeFields(body, 1);
    if (!this.confirmSecret || !this.transcript) {
      throw new Error('CONFIRM received before the key exchange completed');
    }
    if (!verifyConfirmMac(this.confirmSecret, this.transcript, mac)) {
      throw new Error('Peer confirmation MAC failed');
    }
    this.peerConfirmed = true;
    this.maybeComplete();
  }

  private handleData(body: Buffer): void {
    if (!this.receiver) throw new Error('Data frame received before the handshake completed');
    let plaintext: Buffer;
    try {
      plaintext = this.receiver.open(body);
    } catch {
      throw new Error('Frame authentication failed — closing channel');
    }
    if (this.sasConfirmationRequired) {
      this.pendingMessages.push(plaintext);
      return;
    }
    this.emit('message', plaintext);
  }

  /**
   * Build the byte-identical transcript both peers see, derive the shared
   * secret, the SAS, the PSK and the two directional AEAD keys, then send our
   * confirmation MAC.
   */
  private deriveSession(): void {
    if (!this.peerPubDER || !this.peerNonce) throw new Error('Peer key material missing');

    const initiatorFirst = this.role === 'initiator';
    this.sharedSecret = computeSharedSecret(this.keyPair.privateKey, this.peerPubDER);
    this.transcript = buildPairingTranscript({
      version: SECURE_CHANNEL_VERSION,
      sessionId: this.sessionId,
      initiatorMachineId: initiatorFirst ? this.machineId : this.peerMachineId,
      responderMachineId: initiatorFirst ? this.peerMachineId : this.machineId,
      initiatorCertFp: CARRIER_FINGERPRINT,
      responderCertFp: CARRIER_FINGERPRINT,
      initiatorPubDER: initiatorFirst ? this.keyPair.publicKeyDER : this.peerPubDER,
      responderPubDER: initiatorFirst ? this.peerPubDER : this.keyPair.publicKeyDER,
      initiatorNonce: initiatorFirst ? this.nonce : this.peerNonce,
      responderNonce: initiatorFirst ? this.peerNonce : this.nonce,
    });

    this.confirmSecret = bindPsk(this.sharedSecret, this.psk);
    this.sasDigits = deriveSas(this.sharedSecret, this.transcript);
    this.derivedPsk = derivePsk(this.sharedSecret, this.transcript);

    const keys = deriveDirectionKeys(this.sharedSecret, this.transcript, this.psk);
    const sendKey = initiatorFirst ? keys.initiatorToResponder : keys.responderToInitiator;
    const receiveKey = initiatorFirst ? keys.responderToInitiator : keys.initiatorToResponder;
    this.sender = new AeadSender(sendKey);
    this.receiver = new AeadReceiver(receiveKey);

    this.writeFrame(
      FrameType.Confirm,
      encodeFields([computeConfirmMac(this.confirmSecret, this.transcript)]),
    );
    this.confirmSent = true;
    this.maybeComplete();
  }

  private maybeComplete(): void {
    if (!this.confirmSent || !this.peerConfirmed) return;
    this.settleHandshake(null);
  }

  private settleHandshake(error: Error | null): void {
    if (this.handshakeSettled) return;
    const resolve = this.resolveHandshake;
    const reject = this.rejectHandshake;
    if (!resolve || !reject) return;
    this.handshakeSettled = true;
    this.resolveHandshake = null;
    this.rejectHandshake = null;
    if (error) reject(error);
    else resolve(this);
  }

  private flushPending(): void {
    while (this.pendingMessages.length > 0 && !this.isClosed) {
      this.emit('message', this.pendingMessages.shift() as Buffer);
    }
  }

  private writeFrame(type: FrameType, body: Buffer): void {
    if (this.isClosed) return;
    const payload = Buffer.concat([Buffer.from([type]), body]);
    if (payload.length > MAX_FRAME_BYTES) throw new Error('Frame exceeds the maximum size');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    this.pipe.write(Buffer.concat([header, payload]));
  }
}

// ------------------------------------------------------------------ internals

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** 4-byte big-endian length prefix per field — injective, matching the transcript. */
function encodeFields(fields: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(uint32(field.length), field);
  }
  return Buffer.concat(chunks);
}

/** Decode exactly `expected` length-prefixed fields; anything else is hostile. */
function decodeFields(body: Buffer, expected: number): Buffer[] {
  const fields: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = body.readUInt32BE(offset);
    offset += 4;
    if (length > body.length - offset) throw new Error('Malformed handshake frame');
    fields.push(Buffer.from(body.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset !== body.length || fields.length !== expected) {
    throw new Error('Malformed handshake frame');
  }
  return fields;
}
