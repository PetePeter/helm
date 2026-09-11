/**
 * ble-framing — the only layer that knows a GATT attribute write is not a
 * stream.
 *
 * WHY: everything above this file (SecureChannel, JSON-RPC) wants an ordered
 * bidirectional pipe, but GATT delivers bounded, independent writes and
 * notifications. This turns messages into chunks that fit the negotiated MTU
 * and turns chunks back into whole messages — and nothing else in the codebase
 * needs to think about it.
 *
 * Wire format, which the Kotlin peripheral must reproduce exactly:
 *
 *   chunk := seq:u8 | flags:u8 | [ totalLength:u32be if FIRST ] | payload
 *   flags := bit0 FIRST | bit1 LAST
 *
 * `seq` is a per-link chunk counter that wraps at 256. It exists only to detect
 * loss: BLE notifications can be dropped, and silently concatenating the two
 * halves of a lost message would corrupt the AEAD frame above with no error.
 * The total length rides in the FIRST chunk so the cap can be enforced before a
 * single byte is buffered.
 *
 * Conformance vectors: tests/fixtures/ble-framing-vectors.json.
 */

import { EventEmitter } from 'node:events';

/** Bytes of chunk header present on every chunk: seq + flags. */
export const CHUNK_HEADER_BYTES = 2;

/** The u32be total-message length that rides on the FIRST chunk only. */
export const LENGTH_PREFIX_BYTES = 4;

/** Overhead of a FIRST chunk: header + length prefix. */
export const CHUNK_OVERHEAD_FIRST = CHUNK_HEADER_BYTES + LENGTH_PREFIX_BYTES;

/**
 * Smallest chunk size a link may negotiate: the BLE 4.0 default ATT MTU of 23
 * minus the 3-byte ATT notification header. Anything below this is not a real
 * BLE link.
 */
export const MIN_CHUNK_BYTES = 20;

/**
 * Hard ceiling on a single reassembled message. A peer that lies about its
 * length gets refused at the FIRST chunk, so reassembly memory is bounded by
 * this value no matter what arrives.
 */
export const MAX_MESSAGE_BYTES = 256 * 1024;

const FLAG_FIRST = 0b01;
const FLAG_LAST = 0b10;

/** Splits whole messages into MTU-sized chunks, carrying the sequence counter. */
export class BleChunker {
  private seq: number;

  constructor(initialSeq = 0) {
    this.seq = initialSeq & 0xff;
  }

  /**
   * Chunk `message` for a link whose current writable payload is `chunkSize`
   * bytes. The size is passed per call, not stored, because the MTU can change
   * mid-connection.
   */
  chunk(message: Buffer, chunkSize: number): Buffer[] {
    if (chunkSize <= CHUNK_OVERHEAD_FIRST) {
      throw new Error(`chunk size ${chunkSize} is too small to carry a first-chunk header`);
    }
    if (message.length > MAX_MESSAGE_BYTES) {
      throw new Error(`message of ${message.length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte cap`);
    }

    const chunks: Buffer[] = [];
    let offset = 0;
    let first = true;

    do {
      const overhead = first ? CHUNK_OVERHEAD_FIRST : CHUNK_HEADER_BYTES;
      const take = Math.min(chunkSize - overhead, message.length - offset);
      const last = offset + take >= message.length;
      const chunk = Buffer.allocUnsafe(overhead + take);

      chunk.writeUInt8(this.nextSeq(), 0);
      chunk.writeUInt8((first ? FLAG_FIRST : 0) | (last ? FLAG_LAST : 0), 1);
      if (first) chunk.writeUInt32BE(message.length, CHUNK_HEADER_BYTES);
      message.copy(chunk, overhead, offset, offset + take);

      chunks.push(chunk);
      offset += take;
      first = false;
    } while (offset < message.length);

    return chunks;
  }

  private nextSeq(): number {
    const value = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return value;
  }
}

/**
 * Reassembles chunks into whole messages.
 *
 * Emits `message` (Buffer) and `drop` (string reason). A drop is never fatal:
 * the reassembler resynchronises on the next FIRST chunk, so one lost
 * notification costs one message rather than the link.
 */
export class BleReassembler extends EventEmitter {
  private parts: Buffer[] = [];
  private assembled = 0;
  private expectedLength = 0;
  private inFlight = false;
  private expectedSeq: number | null = null;

  /** Bytes currently held for an in-flight message. Bounded by MAX_MESSAGE_BYTES. */
  get bufferedBytes(): number {
    return this.assembled;
  }

  push(chunk: Buffer): void {
    if (chunk.length < CHUNK_HEADER_BYTES) {
      this.drop('chunk too short to hold a header');
      return;
    }

    const seq = chunk.readUInt8(0);
    const flags = chunk.readUInt8(1);
    const isFirst = (flags & FLAG_FIRST) !== 0;

    if (this.expectedSeq !== null && seq !== this.expectedSeq) {
      // A gap means at least one notification was lost. Whatever is in flight is
      // unrecoverable; resynchronise rather than concatenate across the hole.
      this.reset();
      this.drop(`sequence gap: expected ${this.expectedSeq}, got ${seq}`);
      if (!isFirst) {
        this.expectedSeq = (seq + 1) & 0xff;
        return;
      }
    }
    this.expectedSeq = (seq + 1) & 0xff;

    if (isFirst) {
      if (this.inFlight) {
        this.reset();
        this.drop('restart: a new message began before the previous one finished');
      }
      if (chunk.length < CHUNK_OVERHEAD_FIRST) {
        this.drop('first chunk too short to hold a length prefix');
        return;
      }
      const declared = chunk.readUInt32BE(CHUNK_HEADER_BYTES);
      if (declared > MAX_MESSAGE_BYTES) {
        this.reset();
        this.drop(`declared length ${declared} exceeds the ${MAX_MESSAGE_BYTES}-byte cap`);
        return;
      }
      this.inFlight = true;
      this.expectedLength = declared;
      this.append(chunk.subarray(CHUNK_OVERHEAD_FIRST), flags);
      return;
    }

    if (!this.inFlight) {
      this.drop('continuation chunk with no message in flight');
      return;
    }
    this.append(chunk.subarray(CHUNK_HEADER_BYTES), flags);
  }

  private append(payload: Buffer, flags: number): void {
    if (this.assembled + payload.length > this.expectedLength) {
      this.reset();
      this.drop('overrun: payload exceeds the declared message length');
      return;
    }

    this.parts.push(payload);
    this.assembled += payload.length;

    if ((flags & FLAG_LAST) === 0) return;

    if (this.assembled !== this.expectedLength) {
      const short = this.expectedLength - this.assembled;
      this.reset();
      this.drop(`truncated: ${short} bytes short of the declared length`);
      return;
    }

    const message = Buffer.concat(this.parts, this.assembled);
    this.reset();
    this.emit('message', message);
  }

  private reset(): void {
    this.parts = [];
    this.assembled = 0;
    this.expectedLength = 0;
    this.inFlight = false;
  }

  private drop(reason: string): void {
    this.emit('drop', reason);
  }
}
