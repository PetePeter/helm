/**
 * mobile-aead — real AES-256-GCM, no mocks. These tests exist to prove the
 * three properties the whole mobile link rests on: a nonce is never reused, a
 * tampered or replayed frame never yields plaintext, and the two directions are
 * keyed independently.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AEAD_NONCE_BYTES,
  AEAD_SEQ_BYTES,
  AEAD_TAG_BYTES,
  AeadReceiver,
  AeadSender,
  MAX_AEAD_COUNTER,
  aeadNonce,
  deriveDirectionKeys,
} from '../src/mobile/aead';

const shared = randomBytes(32);
const transcript = randomBytes(96);

describe('deriveDirectionKeys', () => {
  it('derives distinct keys per direction from one shared secret', () => {
    const keys = deriveDirectionKeys(shared, transcript);
    expect(keys.initiatorToResponder).toHaveLength(32);
    expect(keys.responderToInitiator).toHaveLength(32);
    expect(keys.initiatorToResponder.equals(keys.responderToInitiator)).toBe(false);
  });

  it('is deterministic, so both peers derive the same key material', () => {
    const first = deriveDirectionKeys(shared, transcript);
    const second = deriveDirectionKeys(shared, transcript);
    expect(first.initiatorToResponder.equals(second.initiatorToResponder)).toBe(true);
    expect(first.responderToInitiator.equals(second.responderToInitiator)).toBe(true);
  });

  it('binds the transcript — a different transcript yields different keys', () => {
    const other = deriveDirectionKeys(shared, randomBytes(96));
    const base = deriveDirectionKeys(shared, transcript);
    expect(other.initiatorToResponder.equals(base.initiatorToResponder)).toBe(false);
  });

  it('binds the pairing PSK when one is supplied', () => {
    const withPsk = deriveDirectionKeys(shared, transcript, randomBytes(32));
    const withoutPsk = deriveDirectionKeys(shared, transcript);
    expect(withPsk.initiatorToResponder.equals(withoutPsk.initiatorToResponder)).toBe(false);
  });
});

describe('AeadSender / AeadReceiver', () => {
  const key = randomBytes(32);

  it('round-trips a sequence of messages in order', () => {
    const sender = new AeadSender(key);
    const receiver = new AeadReceiver(key);
    for (let i = 0; i < 50; i++) {
      const plaintext = Buffer.from(`message-${i}`);
      expect(receiver.open(sender.seal(plaintext)).equals(plaintext)).toBe(true);
    }
  });

  it('produces a different ciphertext for identical plaintext (counter advances)', () => {
    const sender = new AeadSender(key);
    const first = sender.seal(Buffer.from('same'));
    const second = sender.seal(Buffer.from('same'));
    expect(first.equals(second)).toBe(false);
  });

  it('rejects a tampered frame and stays permanently closed afterwards', () => {
    const sender = new AeadSender(key);
    const receiver = new AeadReceiver(key);
    const good = sender.seal(Buffer.from('hello'));
    const tampered = Buffer.from(good);
    tampered[0] ^= 0x01;

    expect(() => receiver.open(tampered)).toThrow();
    // No plaintext fallback: the receiver is burned, even for an authentic frame.
    expect(() => receiver.open(sender.seal(Buffer.from('next')))).toThrow();
  });

  it('rejects a replayed frame — the counter never rewinds', () => {
    const sender = new AeadSender(key);
    const receiver = new AeadReceiver(key);
    const first = sender.seal(Buffer.from('one'));
    const second = sender.seal(Buffer.from('two'));

    expect(receiver.open(first).toString()).toBe('one');
    expect(receiver.open(second).toString()).toBe('two');
    expect(() => receiver.open(first)).toThrow();
  });

  it('rejects a frame sealed under the other direction key', () => {
    const keys = deriveDirectionKeys(shared, transcript);
    const sender = new AeadSender(keys.initiatorToResponder);
    const wrongDirection = new AeadReceiver(keys.responderToInitiator);
    expect(() => wrongDirection.open(sender.seal(Buffer.from('hi')))).toThrow();
  });

  it('refuses to seal past counter exhaustion rather than reusing a nonce', () => {
    const sender = new AeadSender(key, MAX_AEAD_COUNTER);
    expect(() => sender.seal(Buffer.from('last'))).not.toThrow();
    expect(() => sender.seal(Buffer.from('too far'))).toThrow(/exhaust/i);
  });

  it('refuses to open past counter exhaustion', () => {
    const sender = new AeadSender(key, MAX_AEAD_COUNTER);
    const receiver = new AeadReceiver(key, undefined, MAX_AEAD_COUNTER);
    expect(receiver.open(sender.seal(Buffer.from('last'))).toString()).toBe('last');
    expect(() => receiver.open(Buffer.alloc(32))).toThrow(/exhaust/i);
  });

  it('rejects a frame too short to carry an authentication tag', () => {
    const receiver = new AeadReceiver(key);
    expect(() => receiver.open(Buffer.alloc(8))).toThrow();
  });

  it('rejects a key that is not 256 bits', () => {
    expect(() => new AeadSender(randomBytes(16))).toThrow();
    expect(() => new AeadReceiver(randomBytes(16))).toThrow();
  });
});

describe('AeadSender / AeadReceiver wire sequence', () => {
  const key = randomBytes(32);

  it('carries the sequence number on the wire as an authenticated prefix', () => {
    const sender = new AeadSender(key);
    const frame = sender.seal(Buffer.from('abc'));
    expect(frame.readBigUInt64BE(0)).toBe(0n);
    // 8-byte sequence + 3 bytes plaintext + 16-byte tag.
    expect(frame).toHaveLength(AEAD_SEQ_BYTES + 3 + AEAD_TAG_BYTES);
    const second = sender.seal(Buffer.from('abc'));
    expect(second.readBigUInt64BE(0)).toBe(1n);
  });

  it('resynchronises after a whole frame is lost in flight', () => {
    const sender = new AeadSender(key);
    const gaps: Array<[bigint, bigint]> = [];
    const receiver = new AeadReceiver(key, (from, to) => gaps.push([from, to]));

    expect(receiver.open(sender.seal(Buffer.from('one'))).toString()).toBe('one');
    sender.seal(Buffer.from('never delivered'));
    expect(receiver.open(sender.seal(Buffer.from('three'))).toString()).toBe('three');

    expect(gaps).toEqual([[1n, 1n]]);
    // The channel is still usable: the next in-sequence frame decrypts normally.
    expect(receiver.open(sender.seal(Buffer.from('four'))).toString()).toBe('four');
    expect(gaps).toEqual([[1n, 1n]]);
  });

  it('reports a multi-frame gap with the whole lost range', () => {
    const sender = new AeadSender(key);
    const gaps: Array<[bigint, bigint]> = [];
    const receiver = new AeadReceiver(key, (from, to) => gaps.push([from, to]));

    sender.seal(Buffer.from('a'));
    sender.seal(Buffer.from('b'));
    sender.seal(Buffer.from('c'));
    expect(receiver.open(sender.seal(Buffer.from('d'))).toString()).toBe('d');
    expect(gaps).toEqual([[0n, 2n]]);
  });

  it('binds the sequence into the tag — a spliced sequence fails authentication', () => {
    const sender = new AeadSender(key);
    const first = sender.seal(Buffer.from('one'));
    const second = sender.seal(Buffer.from('two'));

    // Take frame two's body+tag and pass it off under frame one's sequence.
    const spliced = Buffer.concat([first.subarray(0, AEAD_SEQ_BYTES), second.subarray(AEAD_SEQ_BYTES)]);
    const receiver = new AeadReceiver(key);
    expect(() => receiver.open(spliced)).toThrow();
  });

  it('treats a sequence regression as a fatal replay, not a resync', () => {
    const sender = new AeadSender(key);
    const gaps: Array<[bigint, bigint]> = [];
    const receiver = new AeadReceiver(key, (from, to) => gaps.push([from, to]));
    const first = sender.seal(Buffer.from('one'));
    receiver.open(first);
    receiver.open(sender.seal(Buffer.from('two')));

    expect(() => receiver.open(first)).toThrow(/replay/i);
    expect(gaps).toEqual([]);
    expect(() => receiver.open(sender.seal(Buffer.from('three')))).toThrow(/closed/);
  });

  it('keeps the nonce equal to the wire sequence so gaps cannot reuse one', () => {
    const sender = new AeadSender(key, 40n);
    const frame = sender.seal(Buffer.from('x'));
    // The nonce is four zero bytes followed by the sequence — the wire prefix
    // duplicates the nonce's counter field exactly.
    expect(aeadNonce(40n).subarray(AEAD_NONCE_BYTES - AEAD_SEQ_BYTES).equals(frame.subarray(0, AEAD_SEQ_BYTES))).toBe(true);
  });
});
