/**
 * mobile-ble-framing — real chunker and real reassembler over real buffers.
 *
 * GATT is not a stream: it is a sequence of bounded attribute writes. These
 * tests pin the only layer that turns those writes back into whole messages,
 * including what it does with hostile and lossy input, because the Kotlin
 * peripheral has to reproduce it byte for byte.
 */

import { describe, expect, it } from 'vitest';
import {
  BleChunker,
  BleReassembler,
  CHUNK_OVERHEAD_FIRST,
  MAX_MESSAGE_BYTES,
  MIN_CHUNK_BYTES,
} from '../src/mobile/ble/ble-framing';

const CHUNK_SIZE = 20;

/** Collect everything a reassembler emits so assertions can look at both streams. */
function collect(reassembler: BleReassembler) {
  const messages: Buffer[] = [];
  const drops: string[] = [];
  reassembler.on('message', (m: Buffer) => messages.push(m));
  reassembler.on('drop', (reason: string) => drops.push(reason));
  return { messages, drops };
}

function roundTrip(message: Buffer, chunkSize = CHUNK_SIZE) {
  const chunks = new BleChunker().chunk(message, chunkSize);
  const reassembler = new BleReassembler();
  const seen = collect(reassembler);
  for (const chunk of chunks) reassembler.push(chunk);
  return { chunks, ...seen };
}

describe('BLE framing round trip', () => {
  it('round-trips a payload larger than one chunk', () => {
    const message = Buffer.alloc(500, 0xab);
    const { chunks, messages, drops } = roundTrip(message);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= CHUNK_SIZE)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].equals(message)).toBe(true);
    expect(drops).toEqual([]);
  });

  it('round-trips a payload that fits in a single chunk', () => {
    const message = Buffer.from('hello phone');
    const { chunks, messages } = roundTrip(message, 64);

    expect(chunks).toHaveLength(1);
    expect(messages[0].equals(message)).toBe(true);
  });

  it('round-trips an empty payload as a real message, not as silence', () => {
    const { chunks, messages } = roundTrip(Buffer.alloc(0), 64);

    expect(chunks).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveLength(0);
  });

  it('keeps two back-to-back messages separate', () => {
    const chunker = new BleChunker();
    const first = Buffer.alloc(120, 0x01);
    const second = Buffer.alloc(90, 0x02);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    for (const chunk of chunker.chunk(first, CHUNK_SIZE)) reassembler.push(chunk);
    for (const chunk of chunker.chunk(second, CHUNK_SIZE)) reassembler.push(chunk);

    expect(drops).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[0].equals(first)).toBe(true);
    expect(messages[1].equals(second)).toBe(true);
  });

  it('reassembles correctly when the chunk size changes mid-connection', () => {
    const chunker = new BleChunker();
    const small = Buffer.alloc(200, 0x11);
    const large = Buffer.alloc(200, 0x22);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    for (const chunk of chunker.chunk(small, MIN_CHUNK_BYTES)) reassembler.push(chunk);
    for (const chunk of chunker.chunk(large, 244)) reassembler.push(chunk);

    expect(drops).toEqual([]);
    expect(messages[0].equals(small)).toBe(true);
    expect(messages[1].equals(large)).toBe(true);
  });

  it('carries a message across a sequence-number wrap', () => {
    // Seeded near the wrap so the 8-bit counter rolls over mid-message.
    const chunker = new BleChunker(0xfd);
    const message = Buffer.alloc(200, 0x33);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    for (const chunk of chunker.chunk(message, MIN_CHUNK_BYTES)) reassembler.push(chunk);

    expect(drops).toEqual([]);
    expect(messages[0].equals(message)).toBe(true);
  });
});

describe('BLE framing under loss and hostile input', () => {
  it('detects a dropped middle chunk instead of silently concatenating', () => {
    const message = Buffer.alloc(300, 0x7f);
    const chunks = new BleChunker().chunk(message, CHUNK_SIZE);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    chunks.filter((_, index) => index !== 2).forEach((chunk) => reassembler.push(chunk));

    expect(messages).toEqual([]);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0]).toContain('sequence');
  });

  it('recovers on the next whole message after a drop', () => {
    const chunker = new BleChunker();
    const lossy = chunker.chunk(Buffer.alloc(300, 0x7f), CHUNK_SIZE);
    const clean = chunker.chunk(Buffer.from('after the gap'), CHUNK_SIZE);
    const reassembler = new BleReassembler();
    const { messages } = collect(reassembler);

    lossy.filter((_, index) => index !== 2).forEach((chunk) => reassembler.push(chunk));
    clean.forEach((chunk) => reassembler.push(chunk));

    expect(messages).toHaveLength(1);
    expect(messages[0].toString()).toBe('after the gap');
  });

  it('rejects a declared length above the cap without allocating for it', () => {
    const hostile = Buffer.alloc(CHUNK_OVERHEAD_FIRST + 4);
    hostile.writeUInt8(0, 0);
    hostile.writeUInt8(0b11, 1); // FIRST | LAST
    hostile.writeUInt32BE(0xffffffff, 2);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    reassembler.push(hostile);

    expect(messages).toEqual([]);
    expect(drops[0]).toContain('cap');
    expect(reassembler.bufferedBytes).toBe(0);
  });

  it('never buffers more than the cap across a lying multi-chunk message', () => {
    const reassembler = new BleReassembler();
    const { drops } = collect(reassembler);
    const head = Buffer.alloc(CHUNK_OVERHEAD_FIRST);
    head.writeUInt8(0, 0);
    head.writeUInt8(0b01, 1); // FIRST, no LAST
    head.writeUInt32BE(64, 2);
    reassembler.push(head);

    // Claims 64 bytes then keeps pushing continuation chunks forever.
    for (let index = 1; index <= 20; index += 1) {
      const cont = Buffer.alloc(2 + 32);
      cont.writeUInt8(index, 0);
      cont.writeUInt8(0, 1);
      reassembler.push(cont);
    }

    expect(reassembler.bufferedBytes).toBeLessThanOrEqual(64);
    expect(drops.some((reason) => reason.includes('overrun'))).toBe(true);
  });

  it('drops a truncated message when a new one starts mid-flight', () => {
    const abandoned = new BleChunker().chunk(Buffer.alloc(300, 0x5a), CHUNK_SIZE);
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    reassembler.push(abandoned[0]);
    // Seeded to continue the sequence, so the restart is the ONLY anomaly —
    // otherwise a sequence gap would mask it.
    const resumed = new BleChunker(abandoned[0].readUInt8(0) + 1);
    for (const chunk of resumed.chunk(Buffer.from('restarted'), CHUNK_SIZE)) {
      reassembler.push(chunk);
    }

    expect(drops.some((reason) => reason.includes('restart'))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].toString()).toBe('restarted');
  });

  it('ignores a runt chunk that cannot hold a header', () => {
    const reassembler = new BleReassembler();
    const { messages, drops } = collect(reassembler);

    reassembler.push(Buffer.alloc(1));

    expect(messages).toEqual([]);
    expect(drops[0]).toContain('short');
  });

  it('drops a continuation chunk that arrives with no message in flight', () => {
    const reassembler = new BleReassembler();
    const { drops } = collect(reassembler);

    const orphan = Buffer.alloc(6);
    orphan.writeUInt8(9, 0);
    reassembler.push(orphan);

    expect(drops[0]).toContain('continuation');
  });
});

describe('BLE framing limits', () => {
  it('refuses to chunk a message larger than the cap', () => {
    const chunker = new BleChunker();
    expect(() => chunker.chunk(Buffer.alloc(MAX_MESSAGE_BYTES + 1), CHUNK_SIZE)).toThrow(/cap/i);
  });

  it('refuses a chunk size too small to carry a first-chunk header', () => {
    const chunker = new BleChunker();
    expect(() => chunker.chunk(Buffer.from('x'), CHUNK_OVERHEAD_FIRST)).toThrow(/chunk size/i);
  });
});
