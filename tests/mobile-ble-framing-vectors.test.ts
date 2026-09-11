/**
 * mobile-ble-framing-vectors — the guard on the cross-language wire contract.
 *
 * tests/fixtures/ble-framing-vectors.json is what the Kotlin peripheral
 * (P-0741) is verified against. If this file starts failing, the framing
 * changed: either that was intentional — regenerate the fixture and treat it as
 * a wire break — or a refactor just silently broke pairing on real hardware.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BleChunker,
  BleReassembler,
  CHUNK_HEADER_BYTES,
  CHUNK_OVERHEAD_FIRST,
  LENGTH_PREFIX_BYTES,
  MAX_MESSAGE_BYTES,
  MIN_CHUNK_BYTES,
} from '../src/mobile/ble/ble-framing';
import {
  buildFramingVectors,
  FRAMING_VECTORS_RELATIVE_PATH,
  type FramingVectors,
} from '../src/mobile/ble/framing-vectors';

const committed = JSON.parse(
  readFileSync(resolve(__dirname, '..', FRAMING_VECTORS_RELATIVE_PATH), 'utf8'),
) as FramingVectors;

describe('committed BLE framing vectors', () => {
  it('matches what the current code produces, byte for byte', () => {
    expect(buildFramingVectors()).toEqual(committed);
  });

  it('pins the format constants the Kotlin side hardcodes', () => {
    expect(committed.format).toEqual({
      chunkHeaderBytes: CHUNK_HEADER_BYTES,
      lengthPrefixBytes: LENGTH_PREFIX_BYTES,
      chunkOverheadFirst: CHUNK_OVERHEAD_FIRST,
      minChunkBytes: MIN_CHUNK_BYTES,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      flagFirst: 1,
      flagLast: 2,
      sequenceModulo: 256,
    });
  });

  it('chunks every committed case to exactly the committed bytes', () => {
    for (const testCase of committed.cases) {
      const message = Buffer.from(testCase.messageHex, 'hex');
      const chunks = new BleChunker(testCase.initialSeq).chunk(message, testCase.chunkSize);
      expect(chunks.map((chunk) => chunk.toString('hex')), testCase.name).toEqual(testCase.chunksHex);
      expect(chunks.every((chunk) => chunk.length <= testCase.chunkSize), testCase.name).toBe(true);
    }
  });

  it('reassembles every committed case back to the original message', () => {
    for (const testCase of committed.cases) {
      const reassembler = new BleReassembler();
      const messages: Buffer[] = [];
      reassembler.on('message', (message: Buffer) => messages.push(message));
      testCase.chunksHex.forEach((hex) => reassembler.push(Buffer.from(hex, 'hex')));

      expect(messages.length, testCase.name).toBe(1);
      expect(messages[0].toString('hex'), testCase.name).toBe(testCase.messageHex);
    }
  });

  it('refuses every committed reject case', () => {
    for (const rejectCase of committed.rejects) {
      const reassembler = new BleReassembler();
      const messages: Buffer[] = [];
      const drops: string[] = [];
      reassembler.on('message', (message: Buffer) => messages.push(message));
      reassembler.on('drop', (reason: string) => drops.push(reason));
      rejectCase.chunksHex.forEach((hex) => reassembler.push(Buffer.from(hex, 'hex')));

      expect(messages, rejectCase.name).toEqual([]);
      expect(drops.length, rejectCase.name).toBeGreaterThan(0);
      expect(reassembler.bufferedBytes, rejectCase.name).toBe(0);
    }
  });
});
