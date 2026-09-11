/**
 * framing-vectors — cross-language conformance vectors for BLE chunk framing.
 *
 * WHY THIS EXISTS: the Kotlin peripheral (P-0741) and this TypeScript central
 * are built independently and do not meet until real hardware. A disagreement
 * about the chunk header, the flag bits or the length prefix does not fail
 * loudly — it fails as "the phone connects and then nothing ever arrives".
 * So the chunk bytes are computed from FIXED inputs here, committed to
 * `tests/fixtures/ble-framing-vectors.json`, and both suites assert against
 * that one file.
 *
 * Inputs are deterministic, never random: the output must be reproducible byte
 * for byte in any language.
 *
 * Regenerate ONLY for an intentional wire change:
 *   npx tsx scripts/generate-ble-framing-vectors.ts
 * Regenerating is a WIRE BREAK.
 */

import {
  BleChunker,
  CHUNK_HEADER_BYTES,
  CHUNK_OVERHEAD_FIRST,
  LENGTH_PREFIX_BYTES,
  MAX_MESSAGE_BYTES,
  MIN_CHUNK_BYTES,
} from './ble-framing';

/** Deterministic filler: byte i is (i * 7 + 11) mod 256. No randomness, ever. */
function pattern(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) buffer.writeUInt8((index * 7 + 11) & 0xff, index);
  return buffer;
}

export interface FramingVectorCase {
  name: string;
  /** Sequence number the chunker starts from. */
  initialSeq: number;
  /** Writable bytes per GATT operation (MTU minus ATT overhead). */
  chunkSize: number;
  messageHex: string;
  chunksHex: string[];
}

/** A chunk stream a conformant reassembler must REFUSE rather than accept. */
export interface FramingRejectCase {
  name: string;
  chunksHex: string[];
  reason: string;
}

export interface FramingVectors {
  format: {
    chunkHeaderBytes: number;
    lengthPrefixBytes: number;
    chunkOverheadFirst: number;
    minChunkBytes: number;
    maxMessageBytes: number;
    flagFirst: number;
    flagLast: number;
    sequenceModulo: number;
  };
  cases: FramingVectorCase[];
  rejects: FramingRejectCase[];
}

/** Compute every vector from the fixed inputs. Pure — no I/O, no randomness. */
export function buildFramingVectors(): FramingVectors {
  const inputs: Array<{ name: string; initialSeq: number; chunkSize: number; message: Buffer }> = [
    { name: 'empty message', initialSeq: 0, chunkSize: 20, message: Buffer.alloc(0) },
    { name: 'single chunk', initialSeq: 0, chunkSize: 20, message: Buffer.from('helm', 'utf8') },
    { name: 'exactly fills one chunk', initialSeq: 0, chunkSize: 20, message: pattern(14) },
    { name: 'one byte past a chunk boundary', initialSeq: 0, chunkSize: 20, message: pattern(15) },
    { name: 'multi chunk at minimum MTU', initialSeq: 0, chunkSize: MIN_CHUNK_BYTES, message: pattern(64) },
    { name: 'multi chunk at 185-byte MTU', initialSeq: 0, chunkSize: 182, message: pattern(600) },
    { name: 'sequence wraps past 255', initialSeq: 0xfd, chunkSize: MIN_CHUNK_BYTES, message: pattern(100) },
  ];

  const cases = inputs.map(({ name, initialSeq, chunkSize, message }) => ({
    name,
    initialSeq,
    chunkSize,
    messageHex: message.toString('hex'),
    chunksHex: new BleChunker(initialSeq)
      .chunk(message, chunkSize)
      .map((chunk) => chunk.toString('hex')),
  }));

  return {
    format: {
      chunkHeaderBytes: CHUNK_HEADER_BYTES,
      lengthPrefixBytes: LENGTH_PREFIX_BYTES,
      chunkOverheadFirst: CHUNK_OVERHEAD_FIRST,
      minChunkBytes: MIN_CHUNK_BYTES,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      flagFirst: 0b01,
      flagLast: 0b10,
      sequenceModulo: 256,
    },
    cases,
    rejects: buildRejectCases(),
  };
}

/**
 * Hostile and lossy streams. A reassembler that accepts any of these will
 * corrupt the AEAD layer above it, so both languages must refuse them.
 */
function buildRejectCases(): FramingRejectCase[] {
  const firstChunk = (declaredLength: number, seq: number, last: boolean, payload: Buffer): Buffer => {
    const chunk = Buffer.allocUnsafe(CHUNK_OVERHEAD_FIRST + payload.length);
    chunk.writeUInt8(seq, 0);
    chunk.writeUInt8(0b01 | (last ? 0b10 : 0), 1);
    chunk.writeUInt32BE(declaredLength, CHUNK_HEADER_BYTES);
    payload.copy(chunk, CHUNK_OVERHEAD_FIRST);
    return chunk;
  };

  const lossy = new BleChunker().chunk(pattern(60), MIN_CHUNK_BYTES);

  return [
    {
      name: 'declared length above the cap',
      chunksHex: [firstChunk(0xffffffff, 0, true, Buffer.alloc(4)).toString('hex')],
      reason: 'a peer must not be able to drive unbounded reassembly memory',
    },
    {
      name: 'sequence gap from a lost chunk',
      chunksHex: lossy.filter((_, index) => index !== 1).map((chunk) => chunk.toString('hex')),
      reason: 'concatenating across a lost notification silently corrupts the message',
    },
    {
      name: 'truncated: LAST arrives short of the declared length',
      chunksHex: [firstChunk(32, 0, true, pattern(8)).toString('hex')],
      reason: 'a short message must be dropped, not delivered',
    },
    {
      name: 'continuation with no message in flight',
      chunksHex: [Buffer.from('0500deadbeef', 'hex').toString('hex')],
      reason: 'a stray continuation must not start a message',
    },
  ];
}

/** Where both suites read the committed vectors from. */
export const FRAMING_VECTORS_RELATIVE_PATH = 'tests/fixtures/ble-framing-vectors.json';
