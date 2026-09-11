/**
 * mobile-ble-link-client — BleLinkClient driven against a fake noble central.
 *
 * The point of these tests is the contract the rest of Helm depends on: a
 * discovered phone becomes a BytePipe that SecureChannel can consume unchanged,
 * BLE failures surface as events rather than throws, and a lost link is
 * retried with backoff instead of a tight scan loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BleLinkClient, type BleLink } from '../src/mobile/ble/ble-link-client';
import { BleChunker, BleReassembler, MIN_CHUNK_BYTES } from '../src/mobile/ble/ble-framing';
import { HELM_SERVICE_UUID_SHORT } from '../src/mobile/ble/characteristics';
import { SecureChannel } from '../src/mobile/secure-channel';
import { FakeNoble, FakePeripheral } from './helpers/fake-noble';

/** Build a client wired to a fake adapter, with logging captured. */
function build() {
  const noble = new FakeNoble();
  const logs: string[] = [];
  const client = new BleLinkClient({
    noble,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 8000,
    logger: (message) => logs.push(message),
  });
  return { noble, client, logs };
}

/** Resolve with the next link the client opens. */
function nextLink(client: BleLinkClient): Promise<BleLink> {
  return new Promise((resolve) => client.once('link', resolve));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BleLinkClient discovery', () => {
  it('scans for the Helm service only once the adapter is powered on', async () => {
    const { noble, client } = build();
    await client.start();

    expect(noble.scanning).toBe(false);

    noble.powerOn();
    await vi.advanceTimersByTimeAsync(0);

    expect(noble.scanning).toBe(true);
    expect(noble.lastScanFilter).toEqual([HELM_SERVICE_UUID_SHORT]);
  });

  it('connects, subscribes and exposes a link carrying the device identity', async () => {
    const { noble, client } = build();
    await client.start();
    noble.powerOn();
    await vi.advanceTimersByTimeAsync(0);

    const pending = nextLink(client);
    const phone = new FakePeripheral('11:22:33:44:55:66');
    noble.discover(phone);
    const link = await pending;

    expect(phone.connected).toBe(true);
    expect(phone.tx.subscribed).toBe(true);
    expect(link.deviceId).toBe('11:22:33:44:55:66');
    expect(link.deviceName).toBe('helm-phone');
    expect(noble.scanning).toBe(false);
  });

  it('keeps scanning when a connection attempt fails, and never throws', async () => {
    const { noble, client, logs } = build();
    const errors: Error[] = [];
    client.on('error', (error: Error) => errors.push(error));
    await client.start();
    noble.powerOn();
    await vi.advanceTimersByTimeAsync(0);

    const phone = new FakePeripheral();
    phone.failConnect = new Error('connect refused');
    noble.discover(phone);
    await vi.advanceTimersByTimeAsync(2000);

    expect(errors[0].message).toContain('connect refused');
    expect(logs.join(' ')).toContain('connect');
    expect(noble.scanning).toBe(true);
  });
});

describe('BleLinkClient pipe', () => {
  async function connected() {
    const { noble, client, logs } = build();
    await client.start();
    noble.powerOn();
    await vi.advanceTimersByTimeAsync(0);
    const pending = nextLink(client);
    const phone = new FakePeripheral();
    noble.discover(phone);
    return { noble, client, logs, phone, link: await pending };
  }

  it('chunks a write that exceeds the MTU and the phone reassembles it', async () => {
    const { phone, link } = await connected();
    const payload = Buffer.alloc(600, 0x5e);

    link.pipe.write(payload);
    await vi.advanceTimersByTimeAsync(0);

    expect(phone.rx.writes.length).toBeGreaterThan(1);
    const reassembler = new BleReassembler();
    const received: Buffer[] = [];
    reassembler.on('message', (m: Buffer) => received.push(m));
    phone.rx.writes.forEach((chunk) => reassembler.push(chunk));
    expect(received).toHaveLength(1);
    expect(received[0].equals(payload)).toBe(true);
  });

  it('delivers a notified message to the pipe consumer as whole bytes', async () => {
    const { phone, link } = await connected();
    const received: Buffer[] = [];
    link.pipe.onData((chunk) => received.push(chunk));

    const message = Buffer.alloc(400, 0x21);
    for (const chunk of new BleChunker().chunk(message, MIN_CHUNK_BYTES)) {
      phone.tx.notify(chunk);
    }

    expect(received).toHaveLength(1);
    expect(received[0].equals(message)).toBe(true);
  });

  it('logs and continues when a GATT write fails, rather than throwing at the caller', async () => {
    const { phone, link, logs } = await connected();
    phone.rx.failNextWrite = new Error('gatt busy');

    expect(() => link.pipe.write(Buffer.from('first'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    link.pipe.write(Buffer.from('second'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.join(' ')).toContain('gatt busy');
    expect(phone.rx.writes.at(-1)?.subarray(6).toString()).toBe('second');
  });

  it('surfaces a dropped notification as a framing drop, not as corrupt data', async () => {
    const { phone, link } = await connected();
    const received: Buffer[] = [];
    const drops: string[] = [];
    link.pipe.onData((chunk) => received.push(chunk));
    link.onFramingDrop((reason) => drops.push(reason));

    const chunks = new BleChunker().chunk(Buffer.alloc(300, 0x9c), MIN_CHUNK_BYTES);
    chunks.filter((_, index) => index !== 1).forEach((chunk) => phone.tx.notify(chunk));

    expect(received).toEqual([]);
    expect(drops.length).toBeGreaterThan(0);
  });
});

describe('BleLinkClient lifecycle', () => {
  async function connected() {
    const { noble, client, logs } = build();
    await client.start();
    noble.powerOn();
    await vi.advanceTimersByTimeAsync(0);
    const pending = nextLink(client);
    const phone = new FakePeripheral();
    noble.discover(phone);
    return { noble, client, logs, phone, link: await pending };
  }

  it('reports a disconnect as an event and closes the pipe', async () => {
    const { client, phone, link } = await connected();
    let closed = false;
    let disconnectedId = '';
    link.pipe.onClose(() => { closed = true; });
    client.on('disconnected', (id: string) => { disconnectedId = id; });

    phone.dropLink();
    await vi.advanceTimersByTimeAsync(0);

    expect(closed).toBe(true);
    expect(disconnectedId).toBe(phone.id);
  });

  it('rescans with exponential backoff rather than in a tight loop', async () => {
    const { noble, client, phone } = await connected();
    client.on('error', () => {});
    const scansAtConnect = noble.scanStarts;

    phone.dropLink();
    await vi.advanceTimersByTimeAsync(0);
    expect(noble.scanStarts).toBe(scansAtConnect);

    await vi.advanceTimersByTimeAsync(1000);
    expect(noble.scanStarts).toBe(scansAtConnect + 1);

    // A failed connect while scanning must widen the delay, not retry instantly.
    phone.failConnect = new Error('still gone');
    noble.discover(phone);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(noble.scanStarts).toBe(scansAtConnect + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(noble.scanStarts).toBe(scansAtConnect + 2);
  });

  it('caps the backoff delay', async () => {
    const { noble, client, phone } = await connected();
    client.on('error', () => {});
    phone.failConnect = new Error('gone');
    phone.dropLink();
    await vi.advanceTimersByTimeAsync(8000);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      noble.discover(phone);
      await vi.advanceTimersByTimeAsync(8000);
    }
    const before = noble.scanStarts;
    noble.discover(phone);
    await vi.advanceTimersByTimeAsync(8000);

    expect(noble.scanStarts).toBe(before + 1);
  });

  it('stops cleanly: no rescan is scheduled after stop', async () => {
    const { noble, client, phone } = await connected();

    await client.stop();
    phone.dropLink();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(noble.scanning).toBe(false);
    expect(phone.connected).toBe(false);
  });
});

describe('BleLinkClient with SecureChannel', () => {
  it('carries a full handshake over two BLE pipes with zero SecureChannel changes', async () => {
    // Two clients, each connected to a fake peripheral, wired phone-to-phone:
    // whatever Helm writes on one link is notified into the other. This proves
    // the pipe is genuinely duplex and ordered under real chunking.
    const nobleA = new FakeNoble();
    const nobleB = new FakeNoble();
    const clientA = new BleLinkClient({ noble: nobleA, logger: () => {} });
    const clientB = new BleLinkClient({ noble: nobleB, logger: () => {} });
    await clientA.start();
    await clientB.start();
    nobleA.powerOn();
    nobleB.powerOn();
    await vi.advanceTimersByTimeAsync(0);

    const pendingA = nextLink(clientA);
    const pendingB = nextLink(clientB);
    const phoneA = new FakePeripheral('a');
    const phoneB = new FakePeripheral('b');
    nobleA.discover(phoneA);
    nobleB.discover(phoneB);
    const [linkA, linkB] = await Promise.all([pendingA, pendingB]);

    // Cross-wire: a chunk written on A's RX becomes a notification on B's TX.
    phoneA.rx.on('write', (data: Buffer) => phoneB.tx.notify(data));
    phoneB.rx.on('write', (data: Buffer) => phoneA.tx.notify(data));

    const [initiator, responder] = await Promise.all([
      SecureChannel.open({
        pipe: linkA.pipe, role: 'initiator', machineId: 'desktop', sessionId: 'ble-1',
      }),
      SecureChannel.open({ pipe: linkB.pipe, role: 'responder', machineId: 'phone' }),
    ]);
    initiator.confirmSas(true);
    responder.confirmSas(true);

    const arrived = new Promise<Buffer>((resolve) => responder.once('message', resolve));
    initiator.send(Buffer.from('spawn claude'));
    expect((await arrived).toString()).toBe('spawn claude');
    expect(initiator.sas).toBe(responder.sas);
  });
});
