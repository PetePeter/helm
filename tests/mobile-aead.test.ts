/**
 * mobile-aead — real AES-256-GCM, no mocks. These tests exist to prove the
 * three properties the whole mobile link rests on: a nonce is never reused, a
 * tampered or replayed frame never yields plaintext, and the two directions are
 * keyed independently.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AeadReceiver,
  AeadSender,
  MAX_AEAD_COUNTER,
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
    const receiver = new AeadReceiver(key, MAX_AEAD_COUNTER);
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
