/**
 * Regenerate the cross-language BLE framing conformance vectors.
 *
 *   npx tsx scripts/generate-ble-framing-vectors.ts
 *
 * Only run this for an INTENTIONAL wire change — the committed vectors are what
 * the Kotlin peripheral is verified against, so changing them silently breaks
 * the link on real hardware.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFramingVectors, FRAMING_VECTORS_RELATIVE_PATH } from '../src/mobile/ble/framing-vectors';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', FRAMING_VECTORS_RELATIVE_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildFramingVectors(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${target}`);
