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
 * A regeneration is a WIRE BREAK — bump SECURE_CHANNEL_VERSION with it.
 */

import {
  buildPairingTranscript,
  computeCommitment,
  computeConfirmMac,
  deriveSas,
  derivePsk,
} from '../mcp/peer/pairing-crypto';
import { AeadSender, aeadNonce, bindPsk, deriveDirectionKeys } from './aead';
import { SECURE_CHANNEL_VERSION, CARRIER_FINGERPRINT } from './secure-channel';

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
  aeadFrames: Array<{ counter: number; nonceHex: string; plaintextUtf8: string; frameHex: string }>;
}

/** Compute every vector from the fixed inputs. Pure — no I/O, no randomness. */
export function buildSecureChannelVectors(): SecureChannelVectors {
  const transcript = buildPairingTranscript({
    version: SECURE_CHANNEL_VERSION,
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

  // Three consecutive frames from one sender prove the counter advances and
  // that identical plaintext does not produce identical ciphertext.
  const sender = new AeadSender(keys.initiatorToResponder);
  const plaintexts = ['hello', 'hello', 'third frame'];
  const aeadFrames = plaintexts.map((text, index) => ({
    counter: index,
    nonceHex: aeadNonce(BigInt(index)).toString('hex'),
    plaintextUtf8: text,
    frameHex: sender.seal(Buffer.from(text, 'utf8')).toString('hex'),
  }));

  return {
    version: SECURE_CHANNEL_VERSION,
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
  };
}

/** Where both test suites read the committed vectors from. */
export const VECTORS_RELATIVE_PATH = 'tests/fixtures/secure-channel-vectors.json';
