/**
 * Regenerate the cross-language mobile envelope conformance vectors.
 *
 *   npx tsx scripts/generate-mobile-envelope-vectors.ts
 *
 * Only run this for an INTENTIONAL wire change — the committed vectors are what
 * the Kotlin app is verified against, so changing them silently breaks the chat
 * surface on real hardware.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvelopeVectors, ENVELOPE_VECTORS_RELATIVE_PATH } from '../src/mobile/mobile-envelope-vectors';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', ENVELOPE_VECTORS_RELATIVE_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildEnvelopeVectors(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${target}`);
