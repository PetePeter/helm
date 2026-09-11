/**
 * aead — AES-256-GCM framing for the mobile link, with nonce reuse made
 * structurally impossible.
 *
 * SECURITY INVARIANTS (do not weaken):
 *  - Each direction has its OWN key, derived under a distinct HKDF `info` label.
 *    A frame replayed back at its own sender therefore fails authentication.
 *  - The nonce is a counter, never random and never transmitted. Sender and
 *    receiver each keep their own monotonic counter, so a replayed or reordered
 *    frame is decrypted under the wrong nonce and fails the tag check. There is
 *    no sequence number on the wire for an attacker to steer.
 *  - A single authentication failure burns the receiver permanently. There is no
 *    resynchronisation path and no plaintext fallback.
 *  - The counter is refused at exhaustion rather than wrapped; wrapping would
 *    reuse a (key, nonce) pair, which is catastrophic for GCM.
 */

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/** HKDF `info` labels — DISTINCT per direction so the two keys never coincide. */
const I2R_LABEL = 'helm-mobile-aead-i2r-v1';
const R2I_LABEL = 'helm-mobile-aead-r2i-v1';

export const AEAD_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;

/**
 * Last usable counter value. The counter occupies the low 8 bytes of the nonce,
 * but is capped well below 2^64 so the limit is reachable in a test and can
 * never silently wrap in production.
 */
export const MAX_AEAD_COUNTER = (1n << 48n) - 1n;

export interface DirectionKeys {
  /** Seals traffic flowing initiator → responder. */
  initiatorToResponder: Buffer;
  /** Seals traffic flowing responder → initiator. */
  responderToInitiator: Buffer;
}

/**
 * Mix a previously established pairing PSK into a secret. The single place this
 * binding is defined, so the confirm-MAC and the AEAD keys agree on what
 * "knowing the PSK" means: a peer without it derives different values and the
 * handshake fails rather than silently downgrading to an unpaired link.
 */
export function bindPsk(secret: Buffer, psk?: Buffer): Buffer {
  return psk ? Buffer.concat([secret, psk]) : secret;
}

/**
 * Derive the two directional keys from the ECDH shared secret, bound to the
 * pairing transcript and, when present, to the pairing PSK.
 */
export function deriveDirectionKeys(
  sharedSecret: Buffer,
  transcript: Buffer,
  psk?: Buffer,
): DirectionKeys {
  const ikm = bindPsk(sharedSecret, psk);
  return {
    initiatorToResponder: Buffer.from(hkdfSync('sha256', ikm, transcript, I2R_LABEL, AEAD_KEY_BYTES)),
    responderToInitiator: Buffer.from(hkdfSync('sha256', ikm, transcript, R2I_LABEL, AEAD_KEY_BYTES)),
  };
}

/**
 * Build the 12-byte GCM nonce for a counter value: four zero bytes followed by
 * the big-endian counter. Exported so a second-language implementation can be
 * checked against it byte for byte.
 */
export function aeadNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(AEAD_NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, AEAD_NONCE_BYTES - 8);
  return nonce;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== AEAD_KEY_BYTES) {
    throw new Error(`AEAD key must be ${AEAD_KEY_BYTES} bytes`);
  }
}

/** One-directional sealing side of the channel. */
export class AeadSender {
  private counter: bigint;

  /** `startCounter` exists for vector generation and future rekey resumption. */
  constructor(private readonly key: Buffer, startCounter: bigint = 0n) {
    assertKey(key);
    this.counter = startCounter;
  }

  /** Returns ciphertext || tag. The nonce is implicit in the counter. */
  seal(plaintext: Buffer): Buffer {
    if (this.counter > MAX_AEAD_COUNTER) {
      throw new Error('AEAD send counter exhausted — rekey or close the channel');
    }
    const cipher = createCipheriv('aes-256-gcm', this.key, aeadNonce(this.counter));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.counter += 1n;
    return Buffer.concat([body, cipher.getAuthTag()]);
  }
}

/** One-directional opening side of the channel. */
export class AeadReceiver {
  private counter: bigint;
  private burned = false;

  constructor(private readonly key: Buffer, startCounter: bigint = 0n) {
    assertKey(key);
    this.counter = startCounter;
  }

  /**
   * Authenticate and decrypt the next frame. Any failure — tamper, replay,
   * reorder, exhaustion — burns the receiver: there is no way back to plaintext.
   */
  open(frame: Buffer): Buffer {
    if (this.burned) throw new Error('AEAD receiver closed by a previous failure');
    if (this.counter > MAX_AEAD_COUNTER) {
      this.burned = true;
      throw new Error('AEAD receive counter exhausted — rekey or close the channel');
    }
    if (frame.length < AEAD_TAG_BYTES) {
      this.burned = true;
      throw new Error('AEAD frame shorter than its authentication tag');
    }

    const body = frame.subarray(0, frame.length - AEAD_TAG_BYTES);
    const tag = frame.subarray(frame.length - AEAD_TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, aeadNonce(this.counter));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      this.counter += 1n;
      return plaintext;
    } catch {
      this.burned = true;
      throw new Error('AEAD authentication failed');
    }
  }
}
