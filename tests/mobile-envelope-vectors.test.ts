/**
 * mobile-envelope-vectors — the guard on the cross-language record contract.
 *
 * tests/fixtures/mobile-envelope-vectors.json is what the Kotlin app (P-0743) is
 * verified against. If this file starts failing, the records changed: either
 * that was intentional — regenerate the fixture and treat it as a wire break —
 * or a refactor just silently emptied the phone's chat surface.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_ENVELOPE_BYTES,
  MOBILE_ENVELOPE_VERSION,
  decodeBlobResult,
  decodeRecord,
} from '../src/mobile/mobile-envelope';
import {
  buildEnvelopeVectors,
  ENVELOPE_VECTORS_RELATIVE_PATH,
  type EnvelopeVectors,
} from '../src/mobile/mobile-envelope-vectors';

const committed = JSON.parse(
  readFileSync(resolve(__dirname, '..', ENVELOPE_VECTORS_RELATIVE_PATH), 'utf8'),
) as EnvelopeVectors;

describe('committed mobile envelope vectors', () => {
  it('matches what the current code produces, byte for byte', () => {
    expect(buildEnvelopeVectors()).toEqual(committed);
  });

  it('pins the format constants the Kotlin side hardcodes', () => {
    expect(committed.format).toEqual({
      version: MOBILE_ENVELOPE_VERSION,
      encoding: 'utf8-json',
      maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
      recordTypes: ['call', 'result', 'error', 'chat', 'lan', 'blob'],
    });
  });

  it('decodes every committed case, and its hex and json agree', () => {
    expect(committed.cases.length).toBeGreaterThan(0);
    for (const testCase of committed.cases) {
      const bytes = Buffer.from(testCase.bytesHex, 'hex');
      expect(bytes.toString('utf8'), testCase.name).toBe(testCase.json);
      expect(decodeRecord(bytes), testCase.name).not.toBeNull();
    }
  });

  it('covers both directions — a one-way fixture would leave half the app unverified', () => {
    const directions = new Set(committed.cases.map((testCase) => testCase.direction));
    expect([...directions].sort()).toEqual(['helm-to-phone', 'phone-to-helm']);
  });

  it('decodes every committed BLOB case back to its exact bytes', () => {
    // The mirror of MobileEnvelopeVectorsTest on the Kotlin side. Asserting the
    // decoded fields rather than the hex is what makes the vector a contract:
    // a byte comparison would pass on a decoder that never ran.
    expect(committed.blobs.length).toBeGreaterThan(0);
    for (const blobCase of committed.blobs) {
      const decoded = decodeBlobResult(Buffer.from(blobCase.bytesHex, 'hex'));
      expect(decoded, blobCase.name).not.toBeNull();
      expect(decoded!.id, blobCase.name).toBe(blobCase.id);
      expect(decoded!.filename, blobCase.name).toBe(blobCase.filename);
      expect(decoded!.mimeType, blobCase.name).toBe(blobCase.mimeType);
      expect(decoded!.bytes.toString('hex'), blobCase.name).toBe(blobCase.bodyHex);
      expect(decoded!.eof, blobCase.name).toBe(blobCase.eof);
    }
  });

  it('decodes every committed UPLOAD case through the same reader', () => {
    // Protocol 4 upload slices are byte-identical to download blobs by design,
    // so the PC decodes them with decodeBlobResult — this asserts that design
    // rather than a second decoder.
    expect(committed.uploads.length).toBeGreaterThan(0);
    for (const uploadCase of committed.uploads) {
      const decoded = decodeBlobResult(Buffer.from(uploadCase.bytesHex, 'hex'));
      expect(decoded, uploadCase.name).not.toBeNull();
      expect(decoded!.id, uploadCase.name).toBe(uploadCase.id);
      expect(decoded!.filename, uploadCase.name).toBe(uploadCase.filename);
      expect(decoded!.mimeType, uploadCase.name).toBe(uploadCase.mimeType);
      expect(decoded!.bytes.toString('hex'), uploadCase.name).toBe(uploadCase.bodyHex);
      expect(decoded!.offset, uploadCase.name).toBe(uploadCase.offset);
      expect(decoded!.total, uploadCase.name).toBe(uploadCase.total);
      expect(decoded!.eof, uploadCase.name).toBe(uploadCase.eof);
    }
  });

  it('refuses every committed reject case', () => {
    expect(committed.rejects.length).toBeGreaterThan(0);
    for (const rejectCase of committed.rejects) {
      expect(decodeRecord(Buffer.from(rejectCase.bytesHex, 'hex')), rejectCase.name).toBeNull();
    }
  });
});
