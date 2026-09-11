/**
 * MobileLinkManager — the owner of the BLE transport lifecycle.
 *
 * Driven against a fake transport but a REAL MobileDeviceStore, a REAL
 * SecretStore and a REAL MobilePairing, because what is under test is the trust
 * bookkeeping between them: identity is the machineId, never the BLE address;
 * Helm never holds a link to a phone it does not trust; and online state
 * reflects reality.
 *
 * One test drives a REAL SecureChannel on both ends to prove the reconnect path
 * uses the stored PSK and raises no SAS prompt.
 */

import { describe, it, expect } from 'vitest';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { MobilePairing } from '../src/mobile/mobile-pairing.js';
import {
  MobileLinkManager,
  type MobileChannel,
  type OpenMobileChannel,
} from '../src/mobile/mobile-link-manager.js';
import { SecureChannel, type BytePipe } from '../src/mobile/secure-channel.js';
import type { BleLink } from '../src/mobile/ble/ble-link-client.js';
import { FakeBleLink, FakeTransport } from './helpers/fake-mobile-link.js';
import { createMemoryPipePair } from './helpers/memory-pipe';

const PHONE = 'phone-machine-1';
const OTHER_PHONE = 'phone-machine-2';
/** The phone's advertised address, and the one Android rotates it to. */
const ADDR = 'aa:bb:cc:dd:ee:ff';
const ROTATED = '7f:3e:0d:11:22:33';

/** A SecureChannel stand-in: it only has to name its peer and close once. */
class FakeChannel implements MobileChannel {
  closed = false;
  closeReason = '';

  constructor(readonly peerMachine: string) {}

  close(reason = 'closed'): void {
    this.closed = true;
    this.closeReason = reason;
  }
}

interface Harness {
  manager: MobileLinkManager;
  transport: FakeTransport;
  devices: MobileDeviceStore;
  secrets: SecretStore;
  pairing: MobilePairing;
  /** Machine ids reported online / offline, in order. */
  online: string[];
  offline: string[];
  /** PSKs the manager presented to openChannel, per attempt. */
  attempts: Array<{ deviceId: string; psk: string }>;
  logs: string[];
}

/**
 * `phones` maps an advertised address to the machine actually behind it. The
 * fake handshake succeeds only when the offered PSK belongs to that machine —
 * which is what the real PSK binding guarantees, and what makes "connected to
 * the wrong advertiser" a genuine failure here rather than a silent pass.
 */
function makeHarness(phones: Record<string, string> = {}, openChannel?: OpenMobileChannel): Harness {
  const devices = new MobileDeviceStore(undefined, () => 1_700_000_000_000);
  const secrets = new SecretStore();
  const transport = new FakeTransport();
  const attempts: Array<{ deviceId: string; psk: string }> = [];
  const logs: string[] = [];

  const pairing = new MobilePairing({
    deviceStore: devices,
    secretStore: secrets,
    machineId: 'desktop',
  });

  const manager = new MobileLinkManager({
    createTransport: () => transport,
    deviceStore: devices,
    secretStore: secrets,
    pairing,
    machineId: 'desktop',
    logger: (message) => logs.push(message),
    openChannel: openChannel ?? (async (link, options) => {
      const psk = options.psk.toString('utf8');
      attempts.push({ deviceId: link.deviceId, psk });
      const owner = psk.replace(/^mobile-/, '');
      if (phones[link.deviceId] !== owner) throw new Error('confirm-MAC mismatch');
      return new FakeChannel(owner);
    }),
  });

  const online: string[] = [];
  const offline: string[] = [];
  manager.on('online', (machineId: string) => online.push(machineId));
  manager.on('offline', (machineId: string) => offline.push(machineId));

  return { manager, transport, devices, secrets, pairing, online, offline, attempts, logs };
}

/** Register a paired phone with a PSK whose bytes are its own pskRef. */
function pair(h: Harness, machineId: string, deviceId?: string) {
  const device = h.devices.add({
    machineId,
    name: machineId,
    pskRef: `mobile-${machineId}`,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
  h.secrets.set(device.pskRef, Buffer.from(device.pskRef, 'utf8'));
  return device;
}

/** Let every pending microtask in the identification chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Offer a link and let the manager's async identification settle. */
async function offer(h: Harness, link: BleLink): Promise<void> {
  h.transport.offer(link);
  await flush();
}

describe('MobileLinkManager identification', () => {
  it('keeps the link of a paired phone and reports it online', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeBleLink(ADDR, 'Pixel 8');
    await offer(h, link);

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.online).toEqual([PHONE]);
    expect(link.closed).toBe(false);
    expect(h.transport.rejected).toEqual([]);
  });

  it('drops a link whose peer machine is not a known device, creating no registry entry', async () => {
    // The PSK authenticates, but it names a machine the registry does not hold —
    // the one case where the address said "known phone" and the identity did not.
    const h = makeHarness({}, async () => new FakeChannel('an-impostor'));
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeBleLink(ADDR);
    await offer(h, link);

    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.manager.isOnline('an-impostor')).toBe(false);
    expect(h.devices.list()).toHaveLength(1);
    expect(h.devices.getByMachineId('an-impostor')).toBeUndefined();
    expect(link.closed).toBe(true);
    expect(h.transport.rejected).toHaveLength(1);
  });

  it('drops an advertiser that no stored PSK authenticates', async () => {
    const h = makeHarness({});
    pair(h, PHONE);
    await h.manager.start();

    const stranger = new FakeBleLink('99:99:99:99:99:99');
    await offer(h, stranger);

    expect(stranger.closed).toBe(true);
    expect(h.transport.rejected[0].deviceId).toBe('99:99:99:99:99:99');
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });

  it('keeps only the paired phone when two peripherals advertise the Helm service', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const neighbour = new FakeBleLink('11:11:11:11:11:11');
    await offer(h, neighbour);
    const mine = new FakeBleLink(ADDR);
    await offer(h, mine);

    expect(neighbour.closed).toBe(true);
    expect(mine.closed).toBe(false);
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });

  it('never links a disabled device', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    h.devices.update(device.id, { enabled: false });
    await h.manager.start();

    const link = new FakeBleLink(ADDR);
    await offer(h, link);

    expect(link.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    // Not even a handshake is attempted: a disabled phone gets no PSK offered.
    expect(h.attempts).toEqual([]);
  });

  it('tries each paired phone in turn across reconnects rather than only the first', async () => {
    const h = makeHarness({ '33:33:33:33:33:33': OTHER_PHONE });
    pair(h, PHONE);
    pair(h, OTHER_PHONE);
    await h.manager.start();

    const link = new FakeBleLink('33:33:33:33:33:33');
    await offer(h, link);
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(false);

    const retry = new FakeBleLink('33:33:33:33:33:33');
    await offer(h, retry);

    expect(h.attempts.map((a) => a.psk)).toEqual([`mobile-${PHONE}`, `mobile-${OTHER_PHONE}`]);
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(true);
  });
});

describe('MobileLinkManager identity is the machineId', () => {
  it('resolves a ROTATED BLE address to the same single registry entry', async () => {
    const h = makeHarness({ [ADDR]: PHONE, [ROTATED]: PHONE });
    const device = pair(h, PHONE, ADDR);
    await h.manager.start();

    await offer(h, new FakeBleLink(ADDR));
    h.manager.dropLink(PHONE);

    // Android rotated the advertised address; the machine identity did not move.
    await offer(h, new FakeBleLink(ROTATED));

    expect(h.devices.list()).toHaveLength(1);
    expect(h.devices.list()[0].id).toBe(device.id);
    expect(h.devices.list()[0].deviceId).toBe(ROTATED);
    expect(h.secrets.has(device.pskRef)).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });

  it('records lastSeenAt on the device it linked', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    await h.manager.start();

    await offer(h, new FakeBleLink(ADDR));

    expect(h.devices.get(device.id)?.lastSeenAt).toBeGreaterThan(0);
  });
});

describe('MobileLinkManager one link per device', () => {
  it('refuses a second link for a device that is already linked', async () => {
    const h = makeHarness({ [ADDR]: PHONE, [ROTATED]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const first = new FakeBleLink(ADDR);
    await offer(h, first);
    const second = new FakeBleLink(ROTATED);
    await offer(h, second);

    expect(first.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(h.online).toEqual([PHONE]);
  });

  it('flips offline when the radio loses the link, and can link again after', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeBleLink(ADDR);
    await offer(h, link);
    h.transport.drop(link);

    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);

    await offer(h, new FakeBleLink(ADDR));
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });
});

describe('MobileLinkManager revocation and disable', () => {
  it('drops a revoked device\'s live link and does not re-establish it', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    // The manager supplies the coordinator's dropLink, so revoke reaches the radio.
    await h.manager.start();
    const link = new FakeBleLink(ADDR);
    await offer(h, link);

    expect(h.pairing.revoke(device.id)).toBe(true);

    expect(link.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);

    // The phone is still advertising; with no record and no PSK it is a stranger.
    const again = new FakeBleLink(ADDR);
    await offer(h, again);
    expect(again.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });

  it('drops the link when a device is disabled, and refuses to link it again', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    await h.manager.start();
    const link = new FakeBleLink(ADDR);
    await offer(h, link);

    h.devices.update(device.id, { enabled: false });
    h.manager.dropLink(PHONE);

    expect(link.closed).toBe(true);
    await offer(h, new FakeBleLink(ADDR));
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });
});

describe('MobileLinkManager pairing mode', () => {
  it('hands a link to the pairing coordinator while pairing is armed', async () => {
    // The coordinator opens its own channel, so the manager must not attempt an
    // identification handshake of its own on the same link.
    const h = makeHarness({});
    const paired: Array<{ machineId: string }> = [];
    h.pairing.on('paired', (event: { machineId: string }) => paired.push(event));
    await h.manager.start();
    h.pairing.start();

    const { a, b } = createMemoryPipePair();
    const link: BleLink = {
      deviceId: ADDR,
      deviceName: 'Pixel 8',
      pipe: a as BytePipe,
      onFramingDrop: () => {},
    };
    const phone = SecureChannel.open({ pipe: b as BytePipe, role: 'responder', machineId: PHONE });
    h.transport.offer(link);
    const phoneChannel = await phone;
    await flush();

    expect(h.pairing.getState().status).toBe('awaiting-sas');
    h.pairing.confirm(true);
    phoneChannel.confirmSas(true);

    expect(paired).toHaveLength(1);
    // A freshly paired phone is online immediately — it is already connected.
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.attempts).toEqual([]);
    expect(h.transport.rejected).toEqual([]);
  });
});

describe('MobileLinkManager lifecycle', () => {
  it('only runs the radio when there is something to connect to', async () => {
    const h = makeHarness({});
    await h.manager.start();
    expect(h.transport.started).toBe(false);

    pair(h, PHONE);
    await Promise.resolve();
    expect(h.transport.started).toBe(true);

    await h.manager.stop();
    expect(h.transport.started).toBe(false);
  });

  it('runs the radio while pairing is armed even with no paired device', async () => {
    const h = makeHarness({});
    await h.manager.start();
    h.pairing.start();
    await Promise.resolve();

    expect(h.transport.started).toBe(true);
  });

  it('logs and stays alive when the radio cannot be loaded at all', async () => {
    const devices = new MobileDeviceStore();
    const secrets = new SecretStore();
    const pairing = new MobilePairing({ deviceStore: devices, secretStore: secrets, machineId: 'd' });
    const logs: string[] = [];
    const manager = new MobileLinkManager({
      createTransport: () => { throw new Error('noble is unavailable'); },
      deviceStore: devices,
      secretStore: secrets,
      pairing,
      machineId: 'desktop',
      logger: (message) => logs.push(message),
    });
    devices.add({ machineId: PHONE, name: 'p', pskRef: 'r' });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(logs.join(' ')).toContain('noble is unavailable');
    expect(manager.isOnline(PHONE)).toBe(false);
  });
});

describe('MobileLinkManager with a real SecureChannel', () => {
  it('reconnects with the stored PSK and raises no SAS prompt', async () => {
    const psk = Buffer.alloc(32, 0x4d);
    const devices = new MobileDeviceStore();
    const secrets = new SecretStore();
    const transport = new FakeTransport();
    const pairing = new MobilePairing({ deviceStore: devices, secretStore: secrets, machineId: 'desktop' });
    const device = devices.add({ machineId: PHONE, name: 'Pixel 8', pskRef: `mobile-${PHONE}` });
    secrets.set(device.pskRef, psk);

    const manager = new MobileLinkManager({
      createTransport: () => transport,
      deviceStore: devices,
      secretStore: secrets,
      pairing,
      machineId: 'desktop',
      logger: () => {},
    });
    await manager.start();

    const { a, b } = createMemoryPipePair();
    const link: BleLink = {
      deviceId: ADDR,
      deviceName: 'Pixel 8',
      pipe: a as BytePipe,
      onFramingDrop: () => {},
    };
    // The phone end knows the same PSK from the original pairing.
    const phone = SecureChannel.open({
      pipe: b as BytePipe, role: 'responder', machineId: PHONE, psk,
    });
    transport.offer(link);
    const phoneChannel = await phone;
    await flush();

    expect(phoneChannel.sasConfirmationRequired).toBe(false);
    expect(manager.isOnline(PHONE)).toBe(true);
    expect(transport.rejected).toEqual([]);

    // The channel is live application-side: the phone can send without a prompt.
    const arrived = new Promise<Buffer>((resolve) => {
      manager.once('message', (_machineId: string, message: Buffer) => resolve(message));
    });
    phoneChannel.send(Buffer.from('hello helm'));
    expect((await arrived).toString()).toBe('hello helm');

    // ...and in the other direction, through the manager, which holds the only
    // reference to the channel.
    const atPhone = new Promise<Buffer>((resolve) => phoneChannel.once('message', resolve));
    expect(manager.send(PHONE, Buffer.from('ping'))).toBe(true);
    expect((await atPhone).toString()).toBe('ping');
    expect(manager.send('never-paired', Buffer.from('ping'))).toBe(false);
  });
});
