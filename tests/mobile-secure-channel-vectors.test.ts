/**
 * mobile-secure-channel-vectors — the cross-language contract guard.
 *
 * The committed fixture is what the Kotlin client is verified against. If this
 * test fails, the wire format moved: either revert the change, or regenerate
 * the vectors AND bump SECURE_CHANNEL_VERSION, knowing every already-paired
 * phone stops working.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSecureChannelVectors,
  VECTORS_RELATIVE_PATH,
} from '../src/mobile/test-vectors';

const committed = JSON.parse(
  readFileSync(resolve(__dirname, '..', VECTORS_RELATIVE_PATH), 'utf8'),
);

describe('secure channel conformance vectors', () => {
  it('reproduces every committed vector byte for byte', () => {
    expect(buildSecureChannelVectors()).toEqual(committed);
  });

  it('is deterministic across runs', () => {
    expect(buildSecureChannelVectors()).toEqual(buildSecureChannelVectors());
  });
});
