/**
 * mobile-envelope-vectors — cross-language conformance vectors for the mobile
 * application records.
 *
 * WHY THIS EXISTS: P-0743 parses these records in Kotlin, built independently of
 * this encoder and never meeting it until real hardware. A disagreement about a
 * field name or key order does not fail loudly — it fails as "the app connects
 * and the chat is always empty". So the bytes are computed from FIXED inputs
 * here, committed to `tests/fixtures/mobile-envelope-vectors.json`, and both
 * suites assert against that one file.
 *
 * Inputs are deterministic, never random. Regenerate ONLY for an intentional
 * wire change:
 *   npx tsx scripts/generate-mobile-envelope-vectors.ts
 * Regenerating is a WIRE BREAK.
 */

import {
  MOBILE_ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  encodeCall,
  encodeChat,
  encodeError,
  encodeResult,
} from './mobile-envelope.js';

export const ENVELOPE_VECTORS_RELATIVE_PATH = 'tests/fixtures/mobile-envelope-vectors.json';

export interface EnvelopeVectorCase {
  name: string;
  /** Which side writes this record. */
  direction: 'phone-to-helm' | 'helm-to-phone';
  /** The exact UTF-8 bytes on the wire, hex encoded. */
  bytesHex: string;
  /** The same bytes as text, so a mismatch is readable in a diff. */
  json: string;
}

/** A payload a conformant decoder must REFUSE rather than accept. */
export interface EnvelopeRejectCase {
  name: string;
  bytesHex: string;
  reason: string;
}

export interface EnvelopeVectors {
  format: {
    version: number;
    encoding: 'utf8-json';
    maxEnvelopeBytes: number;
    recordTypes: string[];
  };
  cases: EnvelopeVectorCase[];
  rejects: EnvelopeRejectCase[];
}

function vector(
  name: string,
  direction: EnvelopeVectorCase['direction'],
  bytes: Buffer,
): EnvelopeVectorCase {
  return { name, direction, bytesHex: bytes.toString('hex'), json: bytes.toString('utf8') };
}

function reject(name: string, json: string, reason: string): EnvelopeRejectCase {
  return { name, bytesHex: Buffer.from(json, 'utf8').toString('hex'), reason };
}

/** Compute every vector from the fixed inputs. Pure — no I/O, no randomness. */
export function buildEnvelopeVectors(): EnvelopeVectors {
  const cases: EnvelopeVectorCase[] = [
    vector('call with no params', 'phone-to-helm', encodeCall('c1', 'session_list')),
    vector('call with params', 'phone-to-helm', encodeCall('c2', 'session_send_text', {
      sessionId: '11111111-2222-3333-4444-555555555555',
      text: 'carry on',
    })),
    vector('call with a non-ASCII argument', 'phone-to-helm', encodeCall('c3', 'session_rename', {
      sessionId: 's1',
      name: 'ñoño — 完了',
    })),
    vector('permitted-tools discovery call', 'phone-to-helm', encodeCall('c4', '__mobile_tools__')),
    vector('result carrying an object', 'helm-to-phone', encodeResult('c1', {
      sessions: [{ id: 's1', name: 'work' }],
    })),
    vector('result carrying null', 'helm-to-phone', encodeResult('c5', null)),
    vector('uniform denial error', 'helm-to-phone', encodeError('c2', -32000, 'Tool not permitted')),
    vector('rate limit error', 'helm-to-phone', encodeError('c3', -32000, 'Rate limit exceeded')),
    vector('plain chat message', 'helm-to-phone', encodeChat({
      sessionId: 's1',
      sessionName: 'work',
      text: 'the build is green',
      at: 1700000000000,
    })),
    vector('chat message with a non-ASCII body', 'helm-to-phone', encodeChat({
      sessionId: 's1',
      sessionName: 'ñoño',
      text: 'build ✅ — 完了',
      at: 1700000000001,
    })),
    vector('chat message with a voice attachment', 'helm-to-phone', encodeChat({
      sessionId: 's1',
      sessionName: 'work',
      text: '',
      at: 1700000000002,
      filePath: 'C:\\Users\\helm\\AppData\\Roaming\\Helm\\tmp\\note.ogg',
      voice: true,
    })),
  ];

  const rejects: EnvelopeRejectCase[] = [
    reject('not JSON', 'not json at all', 'payload does not parse'),
    reject('a JSON array', '[1,2,3]', 'a record must be an object'),
    reject('unknown record type', '{"v":1,"t":"exec","id":"c1"}', 'unrecognised record type'),
    reject('future protocol version', '{"v":99,"t":"call","id":"c1","method":"x"}', 'version is not understood'),
    reject('call with no method', '{"v":1,"t":"call","id":"c1"}', 'method is required on a call'),
    reject('call with a numeric id', '{"v":1,"t":"call","id":7,"method":"x"}', 'id must be a string'),
    reject('error with no code', '{"v":1,"t":"error","id":"c1","error":{"message":"x"}}', 'error.code is required'),
    reject('chat with no text', '{"v":1,"t":"chat","sessionId":"s","sessionName":"n","at":1}', 'text is required on a chat record'),
  ];

  return {
    format: {
      version: MOBILE_ENVELOPE_VERSION,
      encoding: 'utf8-json',
      maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
      recordTypes: ['call', 'result', 'error', 'chat'],
    },
    cases,
    rejects,
  };
}
