/**
 * mobile-secure-channel — two real SecureChannels talking over an in-memory
 * duplex pipe. Real X25519, real AES-256-GCM, no mocks and no BLE: the whole
 * point of the design is that the channel is provable without hardware.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecureChannel } from '../src/mobile/secure-channel';
import { PROTOCOL_MAX, PROTOCOL_MIN } from '../src/mobile/protocol-version';
import { createMemoryPipePair, type MemoryPipeEnd } from './helpers/memory-pipe';

const SESSION_ID = 'ble-session-1';

interface PairedChannels {
  initiator: SecureChannel;
  responder: SecureChannel;
  a: MemoryPipeEnd;
  b: MemoryPipeEnd;
}

async function pair(psk?: Buffer): Promise<PairedChannels> {
  const { a, b } = createMemoryPipePair();
  const [initiator, responder] = await Promise.all([
    SecureChannel.open({ pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID, psk }),
    SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone', psk }),
  ]);
  initiator.confirmSas(true);
  responder.confirmSas(true);
  return { initiator, responder, a, b };
}

/** Wait for the next decrypted message on a channel. */
function nextMessage(channel: SecureChannel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    channel.once('message', resolve);
    channel.once('close', (reason: string) => reject(new Error(`closed: ${reason}`)));
  });
}

function nextClose(channel: SecureChannel): Promise<string> {
  return new Promise((resolve) => channel.once('close', resolve));
}

describe('SecureChannel handshake', () => {
  it('completes over a duplex pair and exchanges messages both ways', async () => {
    const { initiator, responder } = await pair();

    const toPhone = nextMessage(responder);
    initiator.send(Buffer.from('spawn claude'));
    expect((await toPhone).toString()).toBe('spawn claude');

    const toDesktop = nextMessage(initiator);
    responder.send(Buffer.from('ok'));
    expect((await toDesktop).toString()).toBe('ok');
  });

  it('derives identical SAS digits and identical PSKs on both ends', async () => {
    const { initiator, responder } = await pair();
    expect(initiator.sas).toMatch(/^\d{6}$/);
    expect(initiator.sas).toBe(responder.sas);
    expect(initiator.pairingPsk.equals(responder.pairingPsk)).toBe(true);
  });

  it('requires SAS confirmation before any application data may be sent', async () => {
    const { a, b } = createMemoryPipePair();
    const [initiator, responder] = await Promise.all([
      SecureChannel.open({ pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone' }),
    ]);

    expect(initiator.sasConfirmationRequired).toBe(true);
    expect(() => initiator.send(Buffer.from('too early'))).toThrow(/confirm/i);

    initiator.confirmSas(true);
    responder.confirmSas(true);
    const received = nextMessage(responder);
    initiator.send(Buffer.from('now fine'));
    expect((await received).toString()).toBe('now fine');
  });

  it('closes the channel when the user rejects the SAS', async () => {
    const { a, b } = createMemoryPipePair();
    const [initiator] = await Promise.all([
      SecureChannel.open({ pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone' }),
    ]);

    const closed = nextClose(initiator);
    initiator.confirmSas(false);
    expect(await closed).toMatch(/sas/i);
    expect(initiator.closed).toBe(true);
    expect(() => initiator.send(Buffer.from('nope'))).toThrow();
  });

  it('skips SAS comparison when both ends already share a pairing PSK', async () => {
    const psk = randomBytes(32);
    const { a, b } = createMemoryPipePair();
    const [initiator, responder] = await Promise.all([
      SecureChannel.open({ pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID, psk }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone', psk }),
    ]);

    expect(initiator.sasConfirmationRequired).toBe(false);
    const received = nextMessage(responder);
    initiator.send(Buffer.from('resumed'));
    expect((await received).toString()).toBe('resumed');
  });

  it('fails the handshake when the two ends present different PSKs', async () => {
    const { a, b } = createMemoryPipePair();
    const results = await Promise.allSettled([
      SecureChannel.open({
        pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID, psk: randomBytes(32),
      }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone', psk: randomBytes(32) }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('fails loudly when the handshake transcript is tampered with in flight', async () => {
    const { a, b } = createMemoryPipePair();
    // Hostile relay flips a byte deep inside the responder's first frame, which
    // changes the transcript but not the ECDH keys — only the MAC can catch it.
    let tampered = false;
    b.transform = (chunk) => {
      if (!tampered) {
        tampered = true;
        const copy = Buffer.from(chunk);
        copy[copy.length - 1] ^= 0x01;
        return copy;
      }
      return chunk;
    };

    const results = await Promise.allSettled([
      SecureChannel.open({ pipe: a, role: 'initiator', machineId: 'desktop', sessionId: SESSION_ID }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'phone' }),
    ]);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(results.every((r) => r.status !== 'fulfilled' || (r.value as SecureChannel).closed)).toBe(true);
  });
});

describe('SecureChannel protocol negotiation', () => {
  /** Raw wire frame, so a test can play a hostile or ancient peer. */
  function frame(type: number, fields: Buffer[]): Buffer {
    const body = Buffer.concat(fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length, 0);
      return [length, field];
    }));
    const payload = Buffer.concat([Buffer.from([type]), body]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  function u32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  }

  it('agrees on the highest common version and records it on both ends', async () => {
    const { initiator, responder } = await pair();
    expect(initiator.negotiatedVersion).toBe(PROTOCOL_MAX);
    expect(responder.negotiatedVersion).toBe(PROTOCOL_MAX);
  });

  it('refuses a peer whose range does not overlap, with an actionable message', async () => {
    const { a, b } = createMemoryPipePair();
    const results = await Promise.allSettled([
      SecureChannel.open({
        pipe: a,
        role: 'initiator',
        machineId: 'phone',
        sessionId: SESSION_ID,
        protocolRange: { min: PROTOCOL_MAX + 5, max: PROTOCOL_MAX + 6 },
      }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'desktop-secret-id' }),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const initiatorError = (results[0] as PromiseRejectedResult).reason as Error & { code?: string };
    // Each end reads the code relative to itself: the phone's peer is the old
    // one, the desktop's peer is the new one, from a single refusal frame.
    expect(initiatorError.code).toBe('peer-too-old');
    expect(initiatorError.message).toMatch(/\d/);
    const responderError = (results[1] as PromiseRejectedResult).reason as Error & { code?: string };
    expect(responderError.code).toBe('peer-too-new');

    // Negotiation precedes any capability disclosure: the responder answered with
    // a refusal and nothing else — no machine id, no public key, no nonce.
    const disclosed = Buffer.concat(b.sent);
    expect(b.sent).toHaveLength(1);
    expect(disclosed.includes('desktop-secret-id')).toBe(false);
  });

  it('refuses a HELLO whose version fields are garbage rather than defaulting them', async () => {
    const { a, b } = createMemoryPipePair();
    const responder = SecureChannel.open({ pipe: b, role: 'responder', machineId: 'desktop' });
    a.write(frame(0x01, [
      Buffer.from('not-a-number'),
      u32(PROTOCOL_MAX),
      Buffer.from(SESSION_ID),
      Buffer.from('phone'),
      randomBytes(32),
      Buffer.from('1.0.0'),
      Buffer.from('1.0.0'),
    ]));
    await expect(responder).rejects.toThrow();
  });

  it('refuses a negotiated version the initiator never offered', async () => {
    const { a, b } = createMemoryPipePair();
    const initiator = SecureChannel.open({
      pipe: a, role: 'initiator', machineId: 'phone', sessionId: SESSION_ID,
    });
    // A buggy or hostile responder claims a version outside the offered range.
    b.write(frame(0x02, [
      u32(PROTOCOL_MAX + 1), Buffer.from('desktop'), randomBytes(44), randomBytes(32),
    ]));
    await expect(initiator).rejects.toThrow(/version/i);
  });

  it('carries product versions for messaging only — they never gate compatibility', async () => {
    const { a, b } = createMemoryPipePair();
    const [initiator, responder] = await Promise.all([
      SecureChannel.open({
        pipe: a,
        role: 'initiator',
        machineId: 'phone',
        sessionId: SESSION_ID,
        productVersion: '0.0.1-ancient',
        minPeerVersion: '99.0.0',
      }),
      SecureChannel.open({ pipe: b, role: 'responder', machineId: 'desktop' }),
    ]);

    expect(responder.peerProductVersion).toBe('0.0.1-ancient');
    expect(responder.peerMinVersion).toBe('99.0.0');
    expect(initiator.negotiatedVersion).toBeGreaterThanOrEqual(PROTOCOL_MIN);
    expect(responder.closed).toBe(false);
  });
});

describe('SecureChannel data plane', () => {
  it('closes instead of delivering plaintext when a data frame is tampered with', async () => {
    const { initiator, responder, a } = await pair();
    const closed = nextClose(responder);

    a.transform = (chunk) => {
      const copy = Buffer.from(chunk);
      copy[copy.length - 1] ^= 0x01;
      return copy;
    };
    let delivered = false;
    responder.on('message', () => { delivered = true; });
    initiator.send(Buffer.from('tamper me'));

    await closed;
    expect(delivered).toBe(false);
    expect(responder.closed).toBe(true);
  });

  it('rejects a replayed data frame', async () => {
    const { initiator, responder, a, b } = await pair();
    const first = nextMessage(responder);
    initiator.send(Buffer.from('replay me'));
    await first;

    const replayed = a.sent[a.sent.length - 1];
    const closed = nextClose(responder);
    b.deliver(replayed);
    expect(await closed).toMatch(/decrypt|auth/i);
  });

  it('rejects a frame replayed back at its own sender (per-direction keys)', async () => {
    const { initiator, responder, a } = await pair();
    const received = nextMessage(responder);
    initiator.send(Buffer.from('mirror me'));
    await received;

    const ownFrame = a.sent[a.sent.length - 1];
    const closed = nextClose(initiator);
    a.deliver(ownFrame);
    expect(await closed).toMatch(/decrypt|auth/i);
  });

  it('reassembles messages split across pipe chunk boundaries', async () => {
    const { initiator, responder, a, b } = await pair();
    const payload = randomBytes(3000);

    // Hold the frame back, then hand it over one byte at a time — BLE delivers
    // in ~20-byte notifications, so the framer must tolerate any split.
    const held: Buffer[] = [];
    a.transform = (chunk) => { held.push(chunk); return null; };
    initiator.send(payload);
    const frame = Buffer.concat(held);
    expect(frame.length).toBeGreaterThan(0);

    const received = nextMessage(responder);
    for (const byte of frame) b.deliver(Buffer.from([byte]));
    expect((await received).equals(payload)).toBe(true);
  });

  it('refuses to send or receive after the pipe closes', async () => {
    const { initiator, responder, a } = await pair();
    const closed = nextClose(initiator);
    a.close();
    await closed;
    expect(initiator.closed).toBe(true);
    expect(() => initiator.send(Buffer.from('gone'))).toThrow();
    expect(responder.closed).toBe(true);
  });
});
