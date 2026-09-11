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
import { MAX_ENVELOPE_BYTES, MOBILE_ENVELOPE_VERSION, decodeRecord } from '../src/mobile/mobile-envelope';
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
      recordTypes: ['call', 'result', 'error', 'chat'],
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

  it('refuses every committed reject case', () => {
    expect(committed.rejects.length).toBeGreaterThan(0);
    for (const rejectCase of committed.rejects) {
      expect(decodeRecord(Buffer.from(rejectCase.bytesHex, 'hex')), rejectCase.name).toBeNull();
    }
  });
});
