/**
 * test-vectors — cross-language conformance vectors for the mobile secure
 * channel.
 *
 * WHY THIS EXISTS: the Kotlin client and this TypeScript server are built
 * independently and never meet until real hardware. A byte-level disagreement
 * on transcript encoding, HKDF labels, nonce layout or frame framing does not
 * fail loudly — it fails as "pairing just never works", which is brutal to
 * debug over BLE. So the vectors are computed from FIXED inputs here, committed
 * to `tests/fixtures/secure-channel-vectors.json`, and both suites assert
 * against the same file.
 *
 * Inputs are fixed constants, never random: the output must be reproducible
 * byte for byte in any language.
 *
 * Regenerate after an intentional protocol change with:
 *   npx tsx scripts/generate-secure-channel-vectors.ts
 * A regeneration is a WIRE BREAK — bump PROTOCOL_MAX (see protocol-version.ts) with it.
 */

import {
  buildPairingTranscript,
  computeCommitment,
  computeConfirmMac,
  deriveSas,
  derivePsk,
} from '../mcp/peer/pairing-crypto';
import { AEAD_SEQ_BYTES, AEAD_TAG_BYTES, AeadSender, aeadNonce, bindPsk, deriveDirectionKeys } from './aead';
import { CARRIER_FINGERPRINT } from './secure-channel';

/**
 * Pinned literal, NOT `PROTOCOL_MAX`: the vectors describe one specific wire
 * version forever. Adding a new protocol version adds a new vector file rather
 * than silently rewriting this one. THIS FILE WAS REWRITTEN for version 2
 * (explicit AEAD wire sequence + PING/PONG) — the one sanctioned regeneration.
 */
const VECTOR_PROTOCOL_VERSION = 2;

/** Fixed, meaningless-by-design inputs. Never derive these from randomness. */
const SHARED_SECRET = Buffer.from(
  '4f2a1b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708', 'hex',
);
const PSK = Buffer.from(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex',
);
const INITIATOR_PUB = Buffer.from(
  '302a300506032b656e032100' +
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', 'hex',
);
const RESPONDER_PUB = Buffer.from(
  '302a300506032b656e032100' +
  '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa', 'hex',
);
const INITIATOR_NONCE = Buffer.from(
  '0101010101010101010101010101010101010101010101010101010101010101', 'hex',
);
const RESPONDER_NONCE = Buffer.from(
  '0202020202020202020202020202020202020202020202020202020202020202', 'hex',
);
const SESSION_ID = 'helm-mobile-vector-session';
const INITIATOR_MACHINE_ID = 'desktop-vector';
const RESPONDER_MACHINE_ID = 'phone-vector';

export interface SecureChannelVectors {
  version: number;
  carrierFingerprint: string;
  inputs: Record<string, string | number>;
  transcriptHex: string;
  commitmentHex: string;
  sas: string;
  pairingPskHex: string;
  confirmMacHex: string;
  confirmMacWithPskHex: string;
  directionKeys: { initiatorToResponderHex: string; responderToInitiatorHex: string };
  directionKeysWithPsk: { initiatorToResponderHex: string; responderToInitiatorHex: string };
  aeadFrames: Array<{ seq: number; nonceHex: string; plaintextUtf8: string; frameHex: string }>;
  /**
   * A frame lost in flight, then delivery resuming: the receiver must open
   * `delivered` in order, report the `lostSeqs` gap, and carry on.
   */
  gapResync: {
    lostSeqs: number[];
    /** The frame(s) that never arrived, so a port can prove WHY the gap is right. */
    lostFrameHex: string;
    delivered: Array<{ seq: number; plaintextUtf8: string; frameHex: string }>;
  };
  /** A PING and the PONG that answers it, sealed under their own direction key. */
  pingPong: {
    initiatorToResponder: { seq: number; frameHex: string };
    responderToInitiator: { seq: number; frameHex: string };
  };
  /** Frames every implementation must refuse — and burn on. */
  rejected: {
    /** Shorter than sequence + tag. */
    shortFrameHex: string;
    /** `aeadFrames[0]` with one bit of its tag flipped. */
    tamperedFrameHex: string;
  };
}

/** Compute every vector from the fixed inputs. Pure — no I/O, no randomness. */
export function buildSecureChannelVectors(): SecureChannelVectors {
  const transcript = buildPairingTranscript({
    version: VECTOR_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    initiatorMachineId: INITIATOR_MACHINE_ID,
    responderMachineId: RESPONDER_MACHINE_ID,
    initiatorCertFp: CARRIER_FINGERPRINT,
    responderCertFp: CARRIER_FINGERPRINT,
    initiatorPubDER: INITIATOR_PUB,
    responderPubDER: RESPONDER_PUB,
    initiatorNonce: INITIATOR_NONCE,
    responderNonce: RESPONDER_NONCE,
  });

  const keys = deriveDirectionKeys(SHARED_SECRET, transcript);
  const keysWithPsk = deriveDirectionKeys(SHARED_SECRET, transcript, PSK);

  // Three consecutive frames from one sender prove the sequence advances and
  // that identical plaintext does not produce identical ciphertext.
  const sender = new AeadSender(keys.initiatorToResponder);
  const plaintexts = ['hello', 'hello', 'third frame'];
  const aeadFrames = plaintexts.map((text, index) => ({
    seq: index,
    nonceHex: aeadNonce(BigInt(index)).toString('hex'),
    plaintextUtf8: text,
    frameHex: sender.seal(Buffer.from(text, 'utf8')).toString('hex'),
  }));

  // Continuing the SAME sender: sequence 3 never arrives, 4 and 5 do. A receiver
  // must open 4, report the gap 3..3, and open 5 normally.
  const lostFrame = sender.seal(Buffer.from('lost in transit'));
  const delivered = [
    { seq: 4, plaintextUtf8: 'first after the gap' },
    { seq: 5, plaintextUtf8: 'second after the gap' },
  ].map(({ seq, plaintextUtf8 }) => ({
    seq,
    plaintextUtf8,
    frameHex: sender.seal(Buffer.from(plaintextUtf8, 'utf8')).toString('hex'),
  }));

  // A PING sealed by the initiator and the PONG that answers it, sealed by the
  // responder under its own direction key. Bodies are empty: the content is
  // their authentication.
  const pingFrame = sender.seal(Buffer.alloc(0));
  const pongFrame = new AeadSender(keys.responderToInitiator).seal(Buffer.alloc(0));

  // Refusal cases every implementation must burn on.
  const shortFrame = Buffer.alloc(AEAD_SEQ_BYTES + AEAD_TAG_BYTES - 1, 0xab);
  const genuineFirst = Buffer.from(aeadFrames[0].frameHex, 'hex');
  const tamperedFrame = Buffer.from(genuineFirst);
  tamperedFrame[tamperedFrame.length - 1] ^= 0x01;

  return {
    version: VECTOR_PROTOCOL_VERSION,
    carrierFingerprint: CARRIER_FINGERPRINT,
    inputs: {
      sessionId: SESSION_ID,
      initiatorMachineId: INITIATOR_MACHINE_ID,
      responderMachineId: RESPONDER_MACHINE_ID,
      sharedSecretHex: SHARED_SECRET.toString('hex'),
      pskHex: PSK.toString('hex'),
      initiatorPubDERHex: INITIATOR_PUB.toString('hex'),
      responderPubDERHex: RESPONDER_PUB.toString('hex'),
      initiatorNonceHex: INITIATOR_NONCE.toString('hex'),
      responderNonceHex: RESPONDER_NONCE.toString('hex'),
    },
    transcriptHex: transcript.toString('hex'),
    commitmentHex: computeCommitment(INITIATOR_PUB, INITIATOR_NONCE).toString('hex'),
    sas: deriveSas(SHARED_SECRET, transcript),
    pairingPskHex: derivePsk(SHARED_SECRET, transcript).toString('hex'),
    confirmMacHex: computeConfirmMac(SHARED_SECRET, transcript).toString('hex'),
    confirmMacWithPskHex: computeConfirmMac(bindPsk(SHARED_SECRET, PSK), transcript).toString('hex'),
    directionKeys: {
      initiatorToResponderHex: keys.initiatorToResponder.toString('hex'),
      responderToInitiatorHex: keys.responderToInitiator.toString('hex'),
    },
    directionKeysWithPsk: {
      initiatorToResponderHex: keysWithPsk.initiatorToResponder.toString('hex'),
      responderToInitiatorHex: keysWithPsk.responderToInitiator.toString('hex'),
    },
    aeadFrames,
    gapResync: {
      lostSeqs: [3],
      lostFrameHex: lostFrame.toString('hex'),
      delivered,
    },
    pingPong: {
      initiatorToResponder: { seq: 6, frameHex: pingFrame.toString('hex') },
      responderToInitiator: { seq: 0, frameHex: pongFrame.toString('hex') },
    },
    rejected: {
      shortFrameHex: shortFrame.toString('hex'),
      tamperedFrameHex: tamperedFrame.toString('hex'),
    },
  };
}

/** Where both test suites read the committed vectors from. */
export const VECTORS_RELATIVE_PATH = 'tests/fixtures/secure-channel-vectors.json';
