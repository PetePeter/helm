/**
 * MobilePairing — the pairing coordinator, exercised end to end against a REAL
 * SecureChannel handshake over an in-memory pipe pair, a real MobileDeviceStore
 * and a real SecretStore. No mocks: the point of these tests is that trust is
 * only ever persisted when a genuine handshake and a genuine user confirmation
 * both happened.
 *
 * The phone plays responder here exactly as it does over BLE.
 */

import { describe, it, expect, vi } from 'vitest';
import { SecureChannel, type BytePipe } from '../src/mobile/secure-channel.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import {
  MobilePairing,
  PAIRING_TTL_MS,
  MAX_ATTEMPTS_PER_WINDOW,
  type MobilePairingState,
} from '../src/mobile/mobile-pairing.js';
import { HARD_DENY_TOOLS } from '../src/mcp/peer/inbound-call-gate.js';
import type { BleLink } from '../src/mobile/ble/ble-link-client.js';
import { createMemoryPipePair } from './helpers/memory-pipe';

const PHONE_MACHINE = 'phone-machine-1';

interface Harness {
  pairing: MobilePairing;
  devices: MobileDeviceStore;
  secrets: SecretStore;
  states: MobilePairingState[];
  /** Offer a link and settle the handshake on both ends. */
  connect(options?: { deviceId?: string; machineId?: string }): Promise<SecureChannel>;
  dropped: string[];
  tick(ms: number): void;
}

function makeHarness(): Harness {
  let clock = 1_700_000_000_000;
  const devices = new MobileDeviceStore(undefined, () => clock);
  const secrets = new SecretStore();
  const dropped: string[] = [];

  const pairing = new MobilePairing({
    deviceStore: devices,
    secretStore: secrets,
    machineId: 'desktop',
    dropLink: (machineId) => { dropped.push(machineId); },
    now: () => clock,
  });

  const states: MobilePairingState[] = [];
  pairing.on('state', (s: MobilePairingState) => states.push(s));

  async function connect(options: { deviceId?: string; machineId?: string } = {}) {
    const { a, b } = createMemoryPipePair();
    const link: BleLink = {
      deviceId: options.deviceId ?? 'aa:bb:cc:dd:ee:ff',
      deviceName: 'Pixel 8',
      pipe: a as BytePipe,
      onFramingDrop: () => { /* not exercised here */ },
    };
    // The phone end: responder, no PSK — a first pairing. Both ends must be in
    // flight together, so start the phone before driving the hub side.
    const phone = SecureChannel.open({
      pipe: b as BytePipe,
      role: 'responder',
      machineId: options.machineId ?? PHONE_MACHINE,
    });
    await pairing.offerLink(link);
    return await phone;
  }

  return {
    pairing, devices, secrets, states, connect, dropped,
    tick: (ms: number) => { clock += ms; },
  };
}

describe('MobilePairing', () => {
  it('persists NOTHING until the user confirms the SAS', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();

    expect(h.pairing.getState().status).toBe('awaiting-sas');
    expect(h.pairing.getState().sas).toMatch(/^\d{6}$/);
    // The handshake ran, the SAS is on screen — and the registry is still empty.
    expect(h.devices.list()).toHaveLength(0);
    expect(h.secrets.exportAll()).toEqual({});

    phone.close('test');
  });

  it('shows the same six digits on both ends', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();

    expect(h.pairing.getState().sas).toBe(phone.sas);
    phone.close('test');
  });

  it('persists the device and its PSK once confirmed', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    phone.confirmSas(true);

    h.pairing.confirm(true);

    const device = h.devices.getByMachineId(PHONE_MACHINE);
    expect(device).toBeDefined();
    expect(device?.name).toBe('Pixel 8');
    expect(device?.deviceId).toBe('aa:bb:cc:dd:ee:ff');
    // Granted the full surface on pairing. An empty list used to be the default
    // and made UI pairing useless: the phone connected and every call was denied
    // with no way to grant anything. HARD_DENY_TOOLS still contains it.
    expect(device?.allow).toEqual(['*']);
    expect(h.secrets.get(device!.pskRef)).toHaveLength(32);
    expect(h.pairing.getState().status).toBe('paired');

    phone.close('test');
  });

  it('persists the same PSK the phone derived', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    phone.confirmSas(true);
    h.pairing.confirm(true);

    const device = h.devices.getByMachineId(PHONE_MACHINE)!;
    expect(h.secrets.get(device.pskRef)!.equals(phone.pairingPsk)).toBe(true);

    phone.close('test');
  });

  it('rejecting mid-flow persists nothing and leaves the store untouched', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();

    h.pairing.confirm(false);

    expect(h.devices.list()).toHaveLength(0);
    expect(h.secrets.exportAll()).toEqual({});
    expect(h.pairing.getState().status).toBe('failed');
    phone.close('test');
  });

  it('rolls back the device record when the secret cannot be stored', async () => {
    const h = makeHarness();
    vi.spyOn(h.secrets, 'set').mockImplementation(() => { throw new Error('disk full'); });

    h.pairing.start();
    const phone = await h.connect();
    h.pairing.confirm(true);

    // All-or-nothing: no half-paired device may survive a persist failure.
    expect(h.devices.list()).toHaveLength(0);
    expect(h.pairing.getState().status).toBe('failed');
    phone.close('test');
  });

  it('preserves an existing device\'s allow-list when it re-pairs', async () => {
    const h = makeHarness();
    h.pairing.start();
    const first = await h.connect();
    h.pairing.confirm(true);
    const device = h.devices.getByMachineId(PHONE_MACHINE)!;
    h.devices.update(device.id, { allow: ['session_*'] });
    first.close('test');

    h.pairing.start();
    const second = await h.connect({ deviceId: '11:22:33:44:55:66' });
    h.pairing.confirm(true);

    const repaired = h.devices.getByMachineId(PHONE_MACHINE)!;
    expect(h.devices.list()).toHaveLength(1);
    expect(repaired.id).toBe(device.id);
    expect(repaired.allow).toEqual(['session_*']);
    expect(repaired.deviceId).toBe('11:22:33:44:55:66');
    second.close('test');
  });

  it('grants a new phone a surface it can actually use, minus the hard-denied tools', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    h.pairing.confirm(true);

    const device = h.devices.getByMachineId(PHONE_MACHINE)!;

    // The point of the default: an ordinary session tool works immediately.
    expect(h.devices.isToolAllowed(device.id, 'session_list')).toBe(true);
    // `*` is not a bypass — the gate's hard-deny set is what keeps the dangerous
    // tools unreachable, and it is applied after this list.
    for (const denied of ['restart_helm', 'mobile_pair_start', 'mobile_device_allow']) {
      expect(HARD_DENY_TOOLS.has(denied), `${denied} must stay hard-denied`).toBe(true);
    }

    phone.close('test');
  });

  it('allows only one pairing in flight at a time', async () => {
    const h = makeHarness();
    expect(h.pairing.start().ok).toBe(true);

    const result = h.pairing.start();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already/i);
  });

  it('refuses a link when pairing mode was never started', async () => {
    const h = makeHarness();
    const { a } = createMemoryPipePair();
    const link: BleLink = {
      deviceId: 'aa:bb:cc:dd:ee:ff',
      deviceName: 'Pixel 8',
      pipe: a as BytePipe,
      onFramingDrop: () => { /* not exercised here */ },
    };

    // Refused outright — no handshake is even attempted, so an unpaired phone
    // can never pair itself without a local user action.
    await expect(h.pairing.offerLink(link)).resolves.toBe(false);
    expect(h.pairing.getState().status).toBe('idle');
    expect(h.devices.list()).toHaveLength(0);
  });

  it('expires an unconfirmed pairing after the TTL and persists nothing', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    expect(h.pairing.getState().status).toBe('awaiting-sas');

    h.tick(PAIRING_TTL_MS + 1);
    expect(h.pairing.start().ok).toBe(true); // the stale one was reaped, not stuck

    expect(h.devices.list()).toHaveLength(0);
    expect(h.secrets.exportAll()).toEqual({});
    phone.close('test');
  });

  it('caps repeated failed attempts, then refuses until the window passes', async () => {
    const h = makeHarness();

    for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
      expect(h.pairing.start().ok).toBe(true);
      h.pairing.cancel('test-failure');
    }

    const capped = h.pairing.start();
    expect(capped.ok).toBe(false);
    expect(capped.reason).toMatch(/too many|cooldown/i);
  });

  it('revokes a device: removes the record, the secret, and drops the live link', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    h.pairing.confirm(true);

    const device = h.devices.getByMachineId(PHONE_MACHINE)!;
    expect(h.pairing.revoke(device.id)).toBe(true);

    expect(h.devices.get(device.id)).toBeUndefined();
    expect(h.secrets.get(device.pskRef)).toBeUndefined();
    expect(h.dropped).toEqual([PHONE_MACHINE]);
    // Denied for inbound too — an unknown device matches nothing.
    expect(h.devices.isToolAllowed(device.id, 'session_list')).toBe(false);
    phone.close('test');
  });

  it('revoking an unknown device reports false and drops nothing', () => {
    const h = makeHarness();
    expect(h.pairing.revoke('no-such-device')).toBe(false);
    expect(h.dropped).toEqual([]);
  });

  it('never puts key material into an emitted state', async () => {
    const h = makeHarness();
    h.pairing.start();
    const phone = await h.connect();
    h.pairing.confirm(true);

    const serialised = JSON.stringify(h.states);
    const device = h.devices.getByMachineId(PHONE_MACHINE)!;
    const psk = h.secrets.get(device.pskRef)!;
    expect(serialised).not.toContain(psk.toString('base64'));
    expect(serialised).not.toContain(psk.toString('hex'));
    phone.close('test');
  });
});
