/**
 * mobile-envelope — the application records inside a mobile SecureChannel
 * message. Behaviour tests; the byte-level cross-language contract is pinned
 * separately in mobile-envelope-vectors.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_ENVELOPE_BYTES,
  MOBILE_ENVELOPE_VERSION,
  decodeRecord,
  encodeCall,
  encodeChat,
  encodeError,
  encodeResult,
} from '../src/mobile/mobile-envelope';

describe('mobile envelope round-trips', () => {
  it('round-trips a call with params', () => {
    const decoded = decodeRecord(encodeCall('c1', 'session_list', { limit: 5 }));
    expect(decoded).toEqual({ v: 1, t: 'call', id: 'c1', method: 'session_list', params: { limit: 5 } });
  });

  it('omits params entirely when the call has none', () => {
    expect(encodeCall('c1', 'session_list').toString('utf8')).not.toContain('params');
    expect(decodeRecord(encodeCall('c1', 'session_list'))).toEqual({
      v: 1, t: 'call', id: 'c1', method: 'session_list',
    });
  });

  it('round-trips a result, an error and a chat record', () => {
    expect(decodeRecord(encodeResult('c1', { sessions: [] }))).toEqual({
      v: 1, t: 'result', id: 'c1', result: { sessions: [] },
    });
    expect(decodeRecord(encodeError('c1', -32000, 'Tool not permitted'))).toEqual({
      v: 1, t: 'error', id: 'c1', error: { code: -32000, message: 'Tool not permitted' },
    });
    expect(decodeRecord(encodeChat({ sessionId: 's1', sessionName: 'work', text: 'done', at: 1700000000000 }))).toEqual({
      v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'done', at: 1700000000000,
    });
  });

  it('preserves non-ASCII text through UTF-8 encoding', () => {
    const record = decodeRecord(encodeChat({
      sessionId: 's1', sessionName: 'ñoño', text: 'build ✅ — 完了', at: 1,
    }));
    expect(record).toMatchObject({ sessionName: 'ñoño', text: 'build ✅ — 完了' });
  });

  it('appends an alert kind last, and omits it entirely from a plain message', () => {
    // Key order is part of this format: `kind` goes after the other optional
    // keys so a record with every field set stays byte-predictable, and a
    // message without one is indistinguishable from the committed vectors.
    const alert = encodeChat({
      sessionId: 's1', sessionName: 'work', text: 'Finished', at: 1, voice: true, kind: 'completion',
    }).toString('utf8');

    expect(alert).toBe('{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"Finished","at":1,"voice":true,"kind":"completion"}');
    expect(encodeChat({ sessionId: 's1', sessionName: 'work', text: 'done', at: 1 }).toString('utf8'))
      .not.toContain('kind');
  });

  it('decodes an alert kind through, so the phone can tell an event from a message', () => {
    expect(decodeRecord(encodeChat({
      sessionId: 's1', sessionName: 'work', text: 'Went quiet', at: 1, kind: 'idle',
    }))).toEqual({ v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'Went quiet', at: 1, kind: 'idle' });
  });

  it('encodes an undefined result as null rather than dropping the key', () => {
    // A dropped key would decode as "not a result record" on the Kotlin side.
    expect(decodeRecord(encodeResult('c1', undefined))).toEqual({ v: 1, t: 'result', id: 'c1', result: null });
  });
});

describe('mobile envelope rejects malformed input instead of throwing', () => {
  const bad: Array<[string, Buffer]> = [
    ['empty payload', Buffer.alloc(0)],
    ['not JSON', Buffer.from('not json at all', 'utf8')],
    ['a JSON array', Buffer.from('[1,2,3]', 'utf8')],
    ['an unknown record type', Buffer.from(JSON.stringify({ v: 1, t: 'exec', id: 'c1' }), 'utf8')],
    ['a future protocol version', Buffer.from(JSON.stringify({ v: 99, t: 'call', id: 'c1', method: 'x' }), 'utf8')],
    ['a call with no method', Buffer.from(JSON.stringify({ v: 1, t: 'call', id: 'c1' }), 'utf8')],
    ['a call with a numeric id', Buffer.from(JSON.stringify({ v: 1, t: 'call', id: 7, method: 'x' }), 'utf8')],
    ['an error with no code', Buffer.from(JSON.stringify({ v: 1, t: 'error', id: 'c1', error: { message: 'x' } }), 'utf8')],
    ['a chat record with no text', Buffer.from(JSON.stringify({ v: 1, t: 'chat', sessionId: 's', sessionName: 'n', at: 1 }), 'utf8')],
  ];

  it.each(bad)('drops %s', (_name, payload) => {
    expect(decodeRecord(payload)).toBeNull();
  });

  it('refuses a record past the size cap without parsing it', () => {
    const oversized = Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20);
    expect(decodeRecord(oversized)).toBeNull();
  });

  it('pins the protocol version so a bump is a deliberate act', () => {
    expect(MOBILE_ENVELOPE_VERSION).toBe(1);
  });
});
