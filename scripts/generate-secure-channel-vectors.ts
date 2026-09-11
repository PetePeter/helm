/**
 * Regenerate the cross-language secure-channel conformance vectors.
 *
 *   npx tsx scripts/generate-secure-channel-vectors.ts
 *
 * Only run this for an INTENTIONAL protocol change — the committed vectors are
 * what the Kotlin client is verified against, so changing them silently breaks
 * pairing on real hardware. Bump SECURE_CHANNEL_VERSION alongside any change.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSecureChannelVectors, VECTORS_RELATIVE_PATH } from '../src/mobile/test-vectors';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', VECTORS_RELATIVE_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildSecureChannelVectors(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${target}`);
