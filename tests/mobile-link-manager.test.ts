/**
 * MobileLinkManager — the owner of the phone transports’ lifecycle.
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

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { MobilePairing, PAIRING_TTL_MS } from '../src/mobile/mobile-pairing.js';
import {
  MobileLinkManager,
  RANK_BLE,
  RANK_LAN,
  type MobileChannel,
  type OpenMobileChannel,
} from '../src/mobile/mobile-link-manager.js';
import { SecureChannel, type BytePipe } from '../src/mobile/secure-channel.js';
import type { MobileLink } from '../src/mobile/mobile-link.js';
import { FakeLink, FakeTransport } from './helpers/fake-mobile-link.js';
import { createMemoryPipePair } from './helpers/memory-pipe';

const PHONE = 'phone-machine-1';
const OTHER_PHONE = 'phone-machine-2';
/** The phone's advertised address, and the one Android rotates it to. */
const ADDR = 'aa:bb:cc:dd:ee:ff';
const ROTATED = '7f:3e:0d:11:22:33';

/** A SecureChannel stand-in: it only has to name its peer and close once. */
class FakeChannel extends EventEmitter implements MobileChannel {
  closed = false;
  closeReason = '';
  /** PINGs the manager sent, answered or not. */
  pings = 0;
  /** A healthy phone answers every probe; a vanished one answers nothing. */
  answerPings = true;
  /** Application messages the manager routed to this channel, in order. */
  readonly sent: Buffer[] = [];

  constructor(readonly peerMachine: string) {
    super();
  }

  close(reason = 'closed'): void {
    this.closed = true;
    this.closeReason = reason;
  }

  send(message: Buffer): void {
    this.sent.push(Buffer.from(message));
  }

  sendPing(): void {
    this.pings += 1;
    if (this.answerPings) this.emit('pong');
  }
}

interface Harness {
  manager: MobileLinkManager;
  /** The BLE-rank transport. Shorthand for `transports[0]`. */
  transport: FakeTransport;
  /** Every transport the manager owns, in the order it was given them. */
  transports: FakeTransport[];
  devices: MobileDeviceStore;
  secrets: SecretStore;
  pairing: MobilePairing;
  /** Machine ids reported online / offline, in order. */
  online: string[];
  offline: string[];
  /** PSKs the manager presented to openChannel, per attempt. */
  attempts: Array<{ deviceId: string; psk: string }>;
  /** Channels the default openChannel produced, in order. */
  channels: FakeChannel[];
  logs: string[];
}

/**
 * `phones` maps an advertised address to the machine actually behind it. The
 * fake handshake succeeds only when the offered PSK belongs to that machine —
 * which is what the real PSK binding guarantees, and what makes "connected to
 * the wrong advertiser" a genuine failure here rather than a silent pass.
 */
function makeHarness(
  phones: Record<string, string> = {},
  openChannel?: OpenMobileChannel,
  options: {
    handshakeTimeoutMs?: number;
    keepaliveIntervalMs?: number;
    keepaliveMissLimit?: number;
    retireGraceMs?: number;
    /** Ranks to build transports at. Default: one BLE-rank transport. */
    ranks?: number[];
  } = {},
): Harness {
  const devices = new MobileDeviceStore(undefined, () => 1_700_000_000_000);
  const secrets = new SecretStore();
  const transports = (options.ranks ?? [RANK_BLE]).map((rank) => new FakeTransport(rank));
  const transport = transports[0];
  const attempts: Array<{ deviceId: string; psk: string }> = [];
  const channels: FakeChannel[] = [];
  const logs: string[] = [];

  const pairing = new MobilePairing({
    deviceStore: devices,
    secretStore: secrets,
    machineId: 'desktop',
  });

  const manager = new MobileLinkManager({
    createTransports: () => transports,
    deviceStore: devices,
    secretStore: secrets,
    pairing,
    machineId: 'desktop',
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    keepaliveIntervalMs: options.keepaliveIntervalMs,
    keepaliveMissLimit: options.keepaliveMissLimit,
    retireGraceMs: options.retireGraceMs,
    logger: (message) => logs.push(message),
    openChannel: openChannel ?? (async (link, options) => {
      const psk = options.psk.toString('utf8');
      attempts.push({ deviceId: link.deviceId, psk });
      const owner = psk.replace(/^mobile-/, '');
      if (phones[link.deviceId] !== owner) throw new Error('confirm-MAC mismatch');
      const channel = new FakeChannel(owner);
      channels.push(channel);
      return channel;
    }),
  });

  const online: string[] = [];
  const offline: string[] = [];
  manager.on('online', (machineId: string) => online.push(machineId));
  manager.on('offline', (machineId: string) => offline.push(machineId));

  return {
    manager, transport, transports, devices, secrets, pairing,
    online, offline, attempts, channels, logs,
  };
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
async function offer(h: Harness, link: MobileLink): Promise<void> {
  h.transport.offer(link);
  await flush();
}

/** Offer a link on a specific transport — the only way to choose its rank. */
async function offerOn(transport: FakeTransport, link: MobileLink): Promise<void> {
  transport.offer(link);
  await flush();
}

describe('MobileLinkManager identification', () => {
  it('keeps the link of a paired phone and reports it online', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeLink(ADDR, 'Pixel 8');
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

    const link = new FakeLink(ADDR);
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

    const stranger = new FakeLink('99:99:99:99:99:99');
    await offer(h, stranger);

    expect(stranger.closed).toBe(true);
    expect(h.transport.rejected[0].deviceId).toBe('99:99:99:99:99:99');
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });

  it('keeps only the paired phone when two peripherals advertise the Helm service', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const neighbour = new FakeLink('11:11:11:11:11:11');
    await offer(h, neighbour);
    const mine = new FakeLink(ADDR);
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

    const link = new FakeLink(ADDR);
    await offer(h, link);

    expect(link.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    // Not even a handshake is attempted: a disabled phone gets no PSK offered.
    expect(h.attempts).toEqual([]);
  });

  it('still walks the candidates when the advertiser ROTATES its address', async () => {
    // Found on real hardware. The walk used to be keyed on the advertised
    // address, and Android rotates that on every single connection — so the key
    // was new each time, the index was always 0, and the first candidate was
    // tried forever. With two phones paired, whichever sorted second could NEVER
    // be identified: an endless six-second loop of confirm-MAC failures.
    const ROTATION_A = 'a1:a1:a1:a1:a1:a1';
    const ROTATION_B = 'b2:b2:b2:b2:b2:b2';
    const h = makeHarness({ [ROTATION_A]: OTHER_PHONE, [ROTATION_B]: OTHER_PHONE });
    pair(h, PHONE);
    pair(h, OTHER_PHONE);
    await h.manager.start();

    // Every reconnect looks like a brand new advertiser, which is the norm.
    await offer(h, new FakeLink(ROTATION_A));
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(false);
    await offer(h, new FakeLink(ROTATION_B));

    expect(h.attempts.map((a) => a.psk)).toEqual([`mobile-${PHONE}`, `mobile-${OTHER_PHONE}`]);
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(true);
  });

  it('tries each paired phone in turn across reconnects rather than only the first', async () => {
    const h = makeHarness({ '33:33:33:33:33:33': OTHER_PHONE });
    pair(h, PHONE);
    pair(h, OTHER_PHONE);
    await h.manager.start();

    const link = new FakeLink('33:33:33:33:33:33');
    await offer(h, link);
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(false);

    const retry = new FakeLink('33:33:33:33:33:33');
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

    await offer(h, new FakeLink(ADDR));
    h.manager.dropLink(PHONE);

    // Android rotated the advertised address; the machine identity did not move.
    await offer(h, new FakeLink(ROTATED));

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

    await offer(h, new FakeLink(ADDR));

    expect(h.devices.get(device.id)?.lastSeenAt).toBeGreaterThan(0);
  });
});

describe('MobileLinkManager one link per device', () => {
  it('refuses a second link for a device that is already linked', async () => {
    const h = makeHarness({ [ADDR]: PHONE, [ROTATED]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const first = new FakeLink(ADDR);
    await offer(h, first);
    const second = new FakeLink(ROTATED);
    await offer(h, second);

    expect(first.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(h.online).toEqual([PHONE]);
  });

  it('flips offline when the radio loses the link, and can link again after', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeLink(ADDR);
    await offer(h, link);
    h.transport.drop(link);

    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);

    await offer(h, new FakeLink(ADDR));
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });
});

/**
 * LAN always wins (P-0752, ratified 2026-09-16). A link is keyed on machineId,
 * so the two pipes to one phone are not two links — they are a candidate and an
 * incumbent, and the higher-ranked one takes the slot.
 *
 * The invariant that makes the swap safe is ORDER: the challenger is fully
 * handshaken and authenticated before the incumbent is touched. Nothing above
 * the manager may observe a swap, because the machineId does not change.
 */
describe('MobileLinkManager transport preemption', () => {
  /** The phone's LAN address — a different id space from a BLE peripheral id. */
  const LAN = '192.168.1.50:7420';

  function preemptHarness() {
    return makeHarness({ [ADDR]: PHONE, [LAN]: PHONE }, undefined, {
      ranks: [RANK_BLE, RANK_LAN],
    });
  }

  /** Link the phone over BLE, and hand back the incumbent's parts. */
  async function linkOverBle(h: Harness) {
    pair(h, PHONE);
    await h.manager.start();
    const link = new FakeLink(ADDR, 'Pixel 8');
    await offerOn(h.transports[0], link);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    return { link, channel: h.channels[0] };
  }

  it('lets a LAN link take over from a live BLE link', async () => {
    const h = preemptHarness();
    const ble = await linkOverBle(h);

    const lan = new FakeLink(LAN, 'Pixel 8');
    await offerOn(h.transports[1], lan);

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(lan.closed).toBe(false);

    // Traffic now goes out the new channel, and not the old one.
    expect(h.manager.send(PHONE, Buffer.from('hello'))).toBe(true);
    expect(h.channels[1].sent.map((b) => b.toString())).toEqual(['hello']);
    expect(ble.channel.sent).toEqual([]);
  });

  it('never reports the phone offline across the swap', async () => {
    // This is the whole point of keying on machineId: MobileChatBridge,
    // MobileGate and the settings UI must not see the phone blink.
    const h = preemptHarness();
    await linkOverBle(h);

    const states: boolean[] = [];
    h.manager.on('switched', () => states.push(h.manager.isOnline(PHONE)));
    await offerOn(h.transports[1], new FakeLink(LAN));

    expect(h.offline).toEqual([]);
    expect(h.online).toEqual([PHONE]);
    expect(states).toEqual([true]);
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });

  it('retires the displaced BLE link without the refusal cooldown', async () => {
    // reject() marks an advertiser unwelcome for a cooldown so a neighbour's
    // phone is not reconnected on every rescan. A link retired because LAN
    // took over must NOT pay that penalty — it is the phone Helm wants back
    // over Bluetooth the moment LAN drops. teardown therefore goes through
    // the transport's disconnect, never reject.
    vi.useFakeTimers();
    try {
      const h = preemptHarness();
      const ble = await linkOverBle(h);
      await offerOn(h.transports[1], new FakeLink(LAN));

      // Retirement waits out the drain grace, like every displacement.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.transports[0].retired).toHaveLength(1);
      expect(h.transports[0].rejected).toEqual([]);
      expect(ble.link.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a BLE link while a LAN link is live', async () => {
    const h = preemptHarness();
    pair(h, PHONE);
    await h.manager.start();
    const lan = new FakeLink(LAN);
    await offerOn(h.transports[1], lan);

    const ble = new FakeLink(ADDR);
    await offerOn(h.transports[0], ble);

    expect(ble.closed).toBe(true);
    expect(lan.closed).toBe(false);
    // The refusal is routed to the transport that produced the link, not to
    // whichever one happens to be first.
    expect(h.transports[0].rejected).toHaveLength(1);
    expect(h.transports[1].rejected).toEqual([]);
  });

  it('refuses a second link of EQUAL rank, as it always has', async () => {
    const h = preemptHarness();
    const ble = await linkOverBle(h);

    const second = new FakeLink(ROTATED);
    await offerOn(h.transports[0], second);

    expect(second.closed).toBe(true);
    expect(ble.link.closed).toBe(false);
  });

  it('leaves the live BLE link untouched when the LAN handshake FAILS', async () => {
    // The safety rule: authenticate first, displace second. A LAN peer that
    // cannot complete the handshake must cost the user nothing.
    const h = makeHarness({ [ADDR]: PHONE }, undefined, { ranks: [RANK_BLE, RANK_LAN] });
    const ble = await linkOverBle(h);

    // LAN is not in the `phones` map, so the fake handshake rejects it.
    const lan = new FakeLink(LAN);
    await offerOn(h.transports[1], lan);

    expect(lan.closed).toBe(true);
    expect(ble.link.closed).toBe(false);
    expect(ble.channel.closed).toBe(false);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('never lets an unauthenticated peer reach the preempt path', async () => {
    const h = makeHarness(
      { [ADDR]: PHONE },
      async (link) => new FakeChannel(link.deviceId === ADDR ? PHONE : 'an-impostor'),
      { ranks: [RANK_BLE, RANK_LAN] },
    );
    const ble = await linkOverBle(h);

    // A high-rank stranger that authenticates as a machine we do not know.
    await offerOn(h.transports[1], new FakeLink(LAN));

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(ble.link.closed).toBe(false);
    expect(h.manager.isOnline('an-impostor')).toBe(false);
  });

  it('offers the PSK of the phone already on BLE when a LAN link arrives', async () => {
    // Found on real hardware. An upgrading link gets ONE handshake attempt —
    // the phone dials once per Bluetooth link — so offering the wrong PSK is
    // not a delay, it is a permanent failure. With two phones paired the walk
    // reliably picked the other one, and LAN never came up at all.
    //
    // A device already linked over a SLOWER transport is overwhelmingly likely
    // to be the peer dialling in over a faster one: that is what an upgrade is.
    const h = preemptHarness();
    // The other phone was paired FIRST and has connected before, so on general
    // likelihood alone it sorts ahead — which is the production case, and the
    // one that made LAN fail every time.
    const other = pair(h, OTHER_PHONE);
    h.devices.update(other.id, { lastSeenAt: 1_700_000_000_000 });
    pair(h, PHONE);
    await h.manager.start();

    // Bluetooth itself takes two attempts here: the walk offers the other
    // phone's PSK first, and only the second connection finds the right one.
    await offerOn(h.transports[0], new FakeLink(ADDR));
    await offerOn(h.transports[0], new FakeLink(ADDR));
    expect(h.manager.isOnline(PHONE)).toBe(true);
    const beforeLan = h.attempts.length;

    await offerOn(h.transports[1], new FakeLink(LAN));

    // The LAN link gets exactly ONE attempt, so this has to be right first time.
    expect(h.attempts.length).toBe(beforeLan + 1);

    // The LAN attempt offered PHONE's PSK, not the other device's.
    expect(h.attempts.at(-1)?.psk).toBe(`mobile-${PHONE}`);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('does not let a LAN address evict the stored BLE reconnect hint', async () => {
    // MobileDevice.deviceId is a BLE SCANNING hint: it decides which stored PSK
    // is tried first against an advertiser. A TCP source port is ephemeral, so
    // writing one here would make every later BLE reconnect guess wrong — one
    // LAN session silently degrading the transport it displaced.
    const h = preemptHarness();
    await linkOverBle(h);
    const device = h.devices.getByMachineId(PHONE)!;
    expect(h.devices.get(device.id)?.deviceId).toBe(ADDR);

    h.transports[1].persistsAddressHint = false;
    await offerOn(h.transports[1], new FakeLink(LAN));

    expect(h.devices.get(device.id)?.deviceId).toBe(ADDR);
    // The sighting itself is still recorded — only the address is withheld.
    expect(h.devices.get(device.id)?.lastSeenAt).toBeGreaterThan(0);
  });

  it('refuses a preempt by a device that has since been disabled', async () => {
    const h = preemptHarness();
    const ble = await linkOverBle(h);
    const device = h.devices.getByMachineId(PHONE)!;
    h.devices.update(device.id, { enabled: false });

    await offerOn(h.transports[1], new FakeLink(LAN));

    // Trust moved while the challenger was handshaking: it is refused, and the
    // incumbent is left for dropLink to deal with rather than silently upgraded.
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(ble.link.closed).toBe(false);
  });
});

/**
 * Footgun 1 (P-0752). `register` installs four machineId-keyed close handlers —
 * transport error, pipe close, channel close and the transport's `disconnected`
 * scan — and none of them used to check WHICH link had closed. After a swap the
 * retired link's late teardown therefore deleted the entry that replaced it: the
 * phone would drop offline seconds after a good upgrade, at random, with nothing
 * in the log to explain it. Each of the four gets its own test.
 */
describe('MobileLinkManager retired links cannot drop their successor', () => {
  const LAN = '192.168.1.50:7420';

  async function swapped() {
    const h = makeHarness({ [ADDR]: PHONE, [LAN]: PHONE }, undefined, {
      ranks: [RANK_BLE, RANK_LAN],
    });
    pair(h, PHONE);
    await h.manager.start();
    const ble = new FakeLink(ADDR);
    await offerOn(h.transports[0], ble);
    const lan = new FakeLink(LAN);
    await offerOn(h.transports[1], lan);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    return { h, ble, lan, bleChannel: h.channels[0], lanChannel: h.channels[1] };
  }

  it('survives the retired link\'s pipe closing late', async () => {
    const { h, ble } = await swapped();
    ble.close();

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('survives the retired link\'s write deadline firing late', async () => {
    const { h, ble } = await swapped();
    ble.failPendingWrite();

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('survives the retired channel emitting close late', async () => {
    const { h, bleChannel } = await swapped();
    bleChannel.emit('close');

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('survives the old transport reporting the disconnect late', async () => {
    const { h, ble } = await swapped();
    h.transports[0].drop(ble);

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });

  it('still drops the link when the CURRENT one really closes', async () => {
    // The guard must not buy safety by ignoring genuine teardown.
    const { h, lan } = await swapped();
    lan.close();

    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);
  });
});

describe('MobileLinkManager retires the old link after a drain grace', () => {
  const LAN = '192.168.1.50:7420';
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the old channel open briefly so in-flight replies can drain', async () => {
    // Envelope ids are chosen by the phone and Helm never awaits a reply, so a
    // request in flight at swap time would simply lose its answer. The grace
    // lets the queued reply out; the phone retries anything still missing.
    const h = makeHarness({ [ADDR]: PHONE, [LAN]: PHONE }, undefined, {
      ranks: [RANK_BLE, RANK_LAN],
      retireGraceMs: 500,
    });
    pair(h, PHONE);
    await h.manager.start();
    const ble = new FakeLink(ADDR);
    await offerOn(h.transports[0], ble);
    await offerOn(h.transports[1], new FakeLink(LAN));
    const bleChannel = h.channels[0];

    expect(bleChannel.closed).toBe(false);
    expect(ble.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(500);

    expect(bleChannel.closed).toBe(true);
    // Retirement, not refusal: the displaced BLE link must not pay the
    // rejection cooldown that exists for strangers — the phone may need
    // Bluetooth back the moment LAN drops.
    expect(h.transports[0].retired).toHaveLength(1);
    expect(h.transports[0].rejected).toEqual([]);
    // And the retirement still did not disturb the live link.
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
  });
});

describe('MobileLinkManager revocation and disable', () => {
  it('drops a revoked device\'s live link and does not re-establish it', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    // The manager supplies the coordinator's dropLink, so revoke reaches the radio.
    await h.manager.start();
    const link = new FakeLink(ADDR);
    await offer(h, link);

    expect(h.pairing.revoke(device.id)).toBe(true);

    expect(link.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);

    // The phone is still advertising; with no record and no PSK it is a stranger.
    const again = new FakeLink(ADDR);
    await offer(h, again);
    expect(again.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });

  it('drops the link when a device is disabled, and refuses to link it again', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    const device = pair(h, PHONE);
    await h.manager.start();
    const link = new FakeLink(ADDR);
    await offer(h, link);

    h.devices.update(device.id, { enabled: false });
    h.manager.dropLink(PHONE);

    expect(link.closed).toBe(true);
    await offer(h, new FakeLink(ADDR));
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
    const link: MobileLink = {
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

/**
 * A link lent to the pairing coordinator has to come back.
 *
 * The coordinator is deliberately transport-ignorant — it closes channels, never
 * connections — so the manager stays the single owner of every link it hands
 * out. It used to hand one over and forget it: `identify` returned early on a
 * taken link, which skipped the handshake deadline AND recorded nothing, so a
 * cancelled or abandoned flow left the transport's one active-link slot occupied
 * by a link nobody was using. No disconnect, no rescan, radio wedged until Helm
 * restarted. Observed on real hardware.
 */
describe('MobileLinkManager pairing link ownership', () => {
  /** Arm pairing, offer a link, and settle the phone's end of the handshake. */
  async function armAndOffer(h: Harness) {
    h.pairing.start();
    const { a, b } = createMemoryPipePair();
    const link: MobileLink = {
      deviceId: ADDR,
      deviceName: 'Pixel 8',
      pipe: a as BytePipe,
      onFramingDrop: () => {},
    };
    const phone = SecureChannel.open({ pipe: b as BytePipe, role: 'responder', machineId: PHONE });
    h.transport.offer(link);
    const phoneChannel = await phone;
    await flush();
    return { link, phoneChannel };
  }

  it('releases the link when the user cancels the flow', async () => {
    const h = makeHarness({});
    await h.manager.start();
    const { link } = await armAndOffer(h);
    expect(h.pairing.getState().status).toBe('awaiting-sas');
    expect(h.transport.rejected).toEqual([]);

    h.pairing.cancel('cancelled by the user');
    await flush();

    expect(h.transport.rejected).toHaveLength(1);
    expect(h.transport.rejected[0].deviceId).toBe(ADDR);
    expect((link.pipe as unknown as { closed: boolean }).closed).toBe(true);
  });

  it('releases the link when the user rejects the SAS digits', async () => {
    const h = makeHarness({});
    await h.manager.start();
    await armAndOffer(h);

    h.pairing.confirm(false);
    await flush();

    expect(h.transport.rejected).toHaveLength(1);
    expect(h.transport.rejected[0].deviceId).toBe(ADDR);
    expect(h.manager.isOnline(PHONE)).toBe(false);
  });

  it('keeps the link when pairing succeeds, and adopts it', async () => {
    const h = makeHarness({});
    await h.manager.start();
    const { phoneChannel } = await armAndOffer(h);

    h.pairing.confirm(true);
    phoneChannel.confirmSas(true);
    await flush();

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.transport.rejected).toEqual([]);
  });

  it('releases a link the flow never settles, once the attempt TTL passes', async () => {
    // Expiry in the coordinator is lazy — nothing reaps an abandoned attempt
    // until the next call arrives. So the hold needs its own deadline, the same
    // shape and for the same reason as the identification handshake's.
    vi.useFakeTimers();
    try {
      const h = makeHarness({});
      await h.manager.start();
      h.pairing.start();

      const { a, b } = createMemoryPipePair();
      const link: MobileLink = {
        deviceId: ADDR,
        deviceName: 'Pixel 8',
        pipe: a as BytePipe,
        onFramingDrop: () => {},
      };
      // The phone connects and answers the handshake, then simply goes quiet:
      // no confirm, no disconnect, nothing for the manager to react to.
      const phone = SecureChannel.open({ pipe: b as BytePipe, role: 'responder', machineId: PHONE });
      h.transport.offer(link);
      await vi.advanceTimersByTimeAsync(0);
      await phone;
      expect(h.transport.rejected).toEqual([]);

      await vi.advanceTimersByTimeAsync(PAIRING_TTL_MS + 1_000);

      expect(h.transport.rejected).toHaveLength(1);
      expect(h.transport.rejected[0].deviceId).toBe(ADDR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a link whose peer connects but never answers the pairing handshake', async () => {
    // The loan has to be recorded BEFORE the coordinator is awaited, not after.
    // offerLink awaits a real handshake with no deadline of its own, so a phone
    // that connects and then says nothing never lets that await return — and a
    // hold armed on the far side of it is never armed at all. That is the exact
    // shape that wedged the radio on real hardware AFTER the first fix landed.
    vi.useFakeTimers();
    try {
      const h = makeHarness({});
      await h.manager.start();
      h.pairing.start();

      const { a } = createMemoryPipePair();
      const link: MobileLink = {
        deviceId: ADDR,
        deviceName: 'Pixel 8',
        pipe: a as BytePipe,
        onFramingDrop: () => {},
      };
      // No responder on the other end: the phone is connected and mute.
      h.transport.offer(link);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.transport.rejected).toEqual([]);

      await vi.advanceTimersByTimeAsync(PAIRING_TTL_MS + 1_000);

      expect(h.transport.rejected).toHaveLength(1);
      expect(h.transport.rejected[0].deviceId).toBe(ADDR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('identifies a link the coordinator declines, rather than dropping it', async () => {
    // Declining is not refusing: a link pairing does not want is still a link,
    // and the paired-device path must get its normal chance at it.
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();
    // Armed, but with an attempt already holding a channel, so offerLink says no.
    h.pairing.start();
    await armAndOffer(h);
    expect(h.pairing.getState().status).toBe('awaiting-sas');

    const second = new FakeLink(ROTATED);
    h.transport.offer(second);
    await flush();

    // It was identified on its own merits, not silently dropped by the loan.
    expect(h.attempts.map((a) => a.deviceId)).toContain(ROTATED);
  });

  it('never offers a LAN link to the coordinator, even while pairing is armed', async () => {
    // Proximity is the trust anchor: a socket may only ever carry a handshake
    // against a PSK that Bluetooth already established (P-0752). The rule was
    // documented but never enforced, and the cost was not theoretical — an
    // ALREADY PAIRED phone dialling in over LAN was pulled into the pairing
    // flow, failed the confirm-MAC check against a coordinator that holds no
    // PSK, and took the whole pairing attempt down with it. Arming pairing at
    // home therefore destroyed itself within seconds, every time.
    const h = makeHarness({ [ADDR]: PHONE }, undefined, { ranks: [RANK_BLE, RANK_LAN] });
    pair(h, PHONE);
    await h.manager.start();
    h.pairing.start();

    const lan = new FakeLink(ADDR, 'Pixel 8 over LAN');
    await offerOn(h.transports[1], lan);

    // Identified on its own merits against the stored PSK, not offered to pairing.
    expect(h.attempts.map((a) => a.deviceId)).toEqual([ADDR]);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    // And the pairing attempt is untouched — still armed, waiting for a radio.
    expect(h.pairing.getState().status).toBe('scanning');
  });

  it('releases a held link when Helm stops', async () => {
    const h = makeHarness({});
    await h.manager.start();
    await armAndOffer(h);

    await h.manager.stop();
    await flush();

    expect(h.transport.rejected).toHaveLength(1);
    expect(h.transport.rejected[0].deviceId).toBe(ADDR);
  });
});

describe('MobileLinkManager handshake deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops a link whose peer accepts the connection but never answers the handshake', async () => {
    // The HELLO write settles — the transport's own write deadline is satisfied —
    // but the phone never replies. Nothing downstream can announce that: no
    // disconnect, no transport error, no pipe close. Only a deadline here gets
    // the transport's active-link slot back so a rescan can happen.
    const h = makeHarness(
      { [ADDR]: PHONE },
      async () => new Promise<MobileChannel>(() => {}),
      { handshakeTimeoutMs: 10_000 },
    );
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeLink(ADDR);
    await offer(h, link);

    // Still inside the deadline: nothing has been torn down yet.
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(link.closed).toBe(false);
    expect(h.transport.rejected).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.transport.rejected).toHaveLength(1);
    expect(h.transport.rejected[0].deviceId).toBe(ADDR);
    expect(link.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.online).toEqual([]);
    expect(h.offline).toEqual([]);
    expect(h.logs.join(' ')).toContain('handshake timed out');
  });

  it('does not drop a peer that answers the handshake inside the deadline', async () => {
    const h = makeHarness({ [ADDR]: PHONE }, undefined, { handshakeTimeoutMs: 10_000 });
    pair(h, PHONE);
    await h.manager.start();

    const link = new FakeLink(ADDR);
    await offer(h, link);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(link.closed).toBe(false);
    expect(h.transport.rejected).toEqual([]);
  });
});

/**
 * A phone that vanishes without noble noticing — the wedged-radio-stack case —
 * leaves a link that looks online until a send burns its write deadline, and a
 * quiet link looks online FOREVER. The keepalive forces traffic instead: one
 * probe per silent interval, and silence across the miss limit means the link
 * is dead and the drop → offline → reject → rescan chain takes over.
 */
describe('MobileLinkManager keepalive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function keepaliveHarness() {
    return makeHarness({ [ADDR]: PHONE }, undefined, {
      keepaliveIntervalMs: 1_000,
      keepaliveMissLimit: 2,
    });
  }

  async function linkAPhone(h: Harness): Promise<FakeChannel> {
    pair(h, PHONE);
    await h.manager.start();
    await offer(h, new FakeLink(ADDR));
    return h.channels[0];
  }

  it('probes a link that has gone quiet and drops it when the probe brings nothing back', async () => {
    const h = keepaliveHarness();
    const channel = await linkAPhone(h);
    // A healthy phone answers; this one has gone away without a disconnect.
    channel.answerPings = false;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.pings).toBe(1);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);

    // A second full interval with no inbound: the probe went out and died.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);
    // Dropping returns the transport's active-link slot, so the rescan recovers
    // — as a retirement now, not a refusal: a keepalive drop is not a stranger.
    expect(h.transport.retired.map((entry) => entry.deviceId)).toEqual([ADDR]);
    expect(h.transport.rejected).toEqual([]);
  });

  it('never drops a healthy link that answers its probes', async () => {
    const h = keepaliveHarness();
    const channel = await linkAPhone(h);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(channel.pings).toBeGreaterThan(0);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
    expect(h.transport.rejected).toEqual([]);
  });

  it('resets the probe clock on ANY inbound, not just a pong', async () => {
    const h = keepaliveHarness();
    const channel = await linkAPhone(h);
    channel.answerPings = false;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.pings).toBe(1);

    // An application message from the phone is exactly as much proof of life.
    channel.emit('message', Buffer.from('still here'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(channel.pings).toBe(2);
    expect(h.manager.isOnline(PHONE)).toBe(true);
  });

  it('pauses probing while a handshake is in flight, and resumes after', async () => {
    const PENDING = '44:44:44:44:44:44';
    const channels: FakeChannel[] = [];
    let release: ((channel: MobileChannel) => void) | null = null;
    const h = makeHarness(
      { [ADDR]: PHONE, [PENDING]: OTHER_PHONE },
      async (link) => {
        if (link.deviceId === PENDING) {
          return new Promise<MobileChannel>((resolve) => { release = resolve; });
        }
        const channel = new FakeChannel(link.deviceId === ADDR ? PHONE : OTHER_PHONE);
        channels.push(channel);
        return channel;
      },
      { keepaliveIntervalMs: 1_000, keepaliveMissLimit: 2 },
    );
    pair(h, PHONE);
    pair(h, OTHER_PHONE);
    await h.manager.start();
    await offer(h, new FakeLink(ADDR));
    // A second advertiser starts a handshake that never answers.
    await offer(h, new FakeLink(PENDING));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(channels[0].pings).toBe(0);
    expect(h.manager.isOnline(PHONE)).toBe(true);

    // The stalled handshake settles; the next silent interval probes again.
    // (The linked phone says something first, so the pause did not push it
    // past the miss limit.)
    channels[0].emit('message', Buffer.from('still here'));
    release!(new FakeChannel(OTHER_PHONE));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channels[0].pings).toBe(1);
  });

  it('stops probing once stopped', async () => {
    const h = keepaliveHarness();
    const channel = await linkAPhone(h);
    await h.manager.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.pings).toBe(0);
  });

  /**
   * The churn root cause, transport side: a ~55KB session_list reply chunked at
   * 20 bytes held the outbound queue for ~58s, the PING queued behind it never
   * reached the air, and the silence rule dropped the link mid-transfer. While
   * the queue is still working, the transfer IS the evidence of life — the peer
   * is accepting chunks, and the inbound traffic that would reset the clock
   * cannot arrive until the answer has finished going out.
   */
  it('does not silence-drop while the outbound queue is still working a transfer', async () => {
    const h = keepaliveHarness();
    const link = new FakeLink(ADDR);
    pair(h, PHONE);
    await h.manager.start();
    await offer(h, link);
    const channel = h.channels[0];
    channel.answerPings = false;
    link.pendingWrites = 1;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.manager.isOnline(PHONE)).toBe(true);
    expect(h.offline).toEqual([]);
    // A probe would queue behind the transfer and arrive after it anyway.
    expect(channel.pings).toBe(0);
    expect(h.transport.rejected).toEqual([]);
  });

  it('resumes the silence-drop once the queue drains', async () => {
    const h = keepaliveHarness();
    const link = new FakeLink(ADDR);
    pair(h, PHONE);
    await h.manager.start();
    await offer(h, link);
    const channel = h.channels[0];
    channel.answerPings = false;
    link.pendingWrites = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.manager.isOnline(PHONE)).toBe(true);

    // The transfer is done but nothing came back: the normal rule applies again.
    link.pendingWrites = 0;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(channel.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);
  });

  /**
   * The exemption must not become a way to hold a dead link forever. It cannot:
   * each queued chunk carries the transport's own write deadline, and the error
   * it raises drops the link through the transport-error path long before the
   * keepalive clock would ever matter again.
   */
  it('still drops a wedged queue through the per-chunk write deadline', async () => {
    const h = keepaliveHarness();
    const link = new FakeLink(ADDR);
    pair(h, PHONE);
    await h.manager.start();
    await offer(h, link);
    const channel = h.channels[0];
    channel.answerPings = false;
    link.pendingWrites = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.manager.isOnline(PHONE)).toBe(true);

    // The 10s chunk-write deadline fires on the stalled first chunk.
    link.failPendingWrite();

    expect(channel.closed).toBe(true);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(h.offline).toEqual([PHONE]);
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

  it('announces every online device offline and closes its channel when stopped', async () => {
    const h = makeHarness({ [ADDR]: PHONE });
    pair(h, PHONE);
    await h.manager.start();
    const link = new FakeLink(ADDR);
    await offer(h, link);
    expect(h.manager.isOnline(PHONE)).toBe(true);
    const channel = h.channels[0];

    await h.manager.stop();

    expect(h.offline).toEqual([PHONE]);
    expect(h.manager.isOnline(PHONE)).toBe(false);
    expect(channel.closed).toBe(true);

    // The late pipe close — the radio noticing what stop already handled —
    // must not announce the device offline a second time.
    h.transport.drop(link);
    expect(h.offline).toEqual([PHONE]);
  });

  it('starts every transport it was given, and only once there is a phone', async () => {
    const h = makeHarness({}, undefined, { ranks: [RANK_BLE, RANK_LAN] });
    await h.manager.start();
    expect(h.transports.map((t) => t.started)).toEqual([false, false]);

    pair(h, PHONE);
    await Promise.resolve();
    expect(h.transports.map((t) => t.started)).toEqual([true, true]);

    await h.manager.stop();
    expect(h.transports.map((t) => t.started)).toEqual([false, false]);
  });

  it('closes links held on either transport when stopped', async () => {
    const LAN = '192.168.1.50:7420';
    const h = makeHarness({ [LAN]: OTHER_PHONE }, undefined, { ranks: [RANK_BLE, RANK_LAN] });
    pair(h, OTHER_PHONE);
    await h.manager.start();
    await offerOn(h.transports[1], new FakeLink(LAN));
    expect(h.manager.isOnline(OTHER_PHONE)).toBe(true);

    await h.manager.stop();

    expect(h.offline).toEqual([OTHER_PHONE]);
    expect(h.channels[0].closed).toBe(true);
  });

  it('logs and stays alive when the radio cannot be loaded at all', async () => {
    const devices = new MobileDeviceStore();
    const secrets = new SecretStore();
    const pairing = new MobilePairing({ deviceStore: devices, secretStore: secrets, machineId: 'd' });
    const logs: string[] = [];
    const manager = new MobileLinkManager({
      createTransports: () => { throw new Error('noble is unavailable'); },
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
      createTransports: () => [transport],
      deviceStore: devices,
      secretStore: secrets,
      pairing,
      machineId: 'desktop',
      logger: () => {},
    });
    await manager.start();

    const { a, b } = createMemoryPipePair();
    const link: MobileLink = {
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
