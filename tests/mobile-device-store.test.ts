/**
 * MobileDeviceStore — registry behaviour and the YAML round-trip.
 *
 * The round-trip tests exist because the fleet registry lost `machineId` on load
 * once: a peer that lost its key could no longer be found, so re-pairing forked a
 * duplicate entry and orphaned the original PSK. The mobile registry is keyed on
 * machineId for the same reason, so the same regression is worth guarding here.
 */

import { describe, it, expect, vi } from 'vitest';
import * as YAML from 'yaml';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { sanitizeMobileDevices } from '../src/mobile/mobile-device-sanitize.js';
import type { MobileDevice } from '../src/types/mobile-device.js';

const clock = () => 1_700_000_000_000;

function makeStore(persist?: (devices: MobileDevice[]) => void): MobileDeviceStore {
  return new MobileDeviceStore(persist, clock);
}

function addPixel(store: MobileDeviceStore): MobileDevice {
  return store.add({
    machineId: 'phone-machine-1',
    name: 'Pixel 8',
    deviceId: 'aa:bb:cc:dd:ee:ff',
    pskRef: 'mobile-phone-machine-1',
    allow: ['session_*'],
  });
}

describe('MobileDeviceStore', () => {
  it('persists and announces a change on add', () => {
    const persist = vi.fn();
    const store = makeStore(persist);
    const changed = vi.fn();
    store.on('mobile-devices:changed', changed);

    const device = addPixel(store);

    expect(device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(device.createdAt).toBe(clock());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('upserts by machineId in place rather than forking a duplicate', () => {
    const store = makeStore();
    const first = addPixel(store);

    // A reconnect after Android rotated the advertised BLE address.
    const second = store.upsertByMachineId({
      machineId: 'phone-machine-1',
      name: 'Pixel 8',
      deviceId: '11:22:33:44:55:66',
      pskRef: 'mobile-phone-machine-1',
    });

    expect(store.list()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.deviceId).toBe('11:22:33:44:55:66');
  });

  it('preserves the allow-list across a re-pair that does not supply one', () => {
    const store = makeStore();
    addPixel(store);

    const repaired = store.upsertByMachineId({
      machineId: 'phone-machine-1',
      name: 'Pixel 8',
      pskRef: 'mobile-phone-machine-1',
    });

    expect(repaired.allow).toEqual(['session_*']);
  });

  it('hands out copies, so a caller cannot mutate the registry through one', () => {
    const store = makeStore();
    const device = addPixel(store);

    device.allow.push('restart_helm');
    device.name = 'tampered';

    const stored = store.get(device.id);
    expect(stored?.allow).toEqual(['session_*']);
    expect(stored?.name).toBe('Pixel 8');
  });

  it('denies by default: unknown device, empty allow-list, or disabled device', () => {
    const store = makeStore();
    const device = addPixel(store);

    expect(store.isToolAllowed(device.id, 'session_list')).toBe(true);
    expect(store.isToolAllowed('no-such-device', 'session_list')).toBe(false);

    store.update(device.id, { allow: [] });
    expect(store.isToolAllowed(device.id, 'session_list')).toBe(false);

    store.update(device.id, { allow: ['session_*'], enabled: false });
    expect(store.isToolAllowed(device.id, 'session_list')).toBe(false);
  });

  it('treats an absent enabled flag as enabled', () => {
    const store = makeStore();
    const device = addPixel(store);
    expect(store.get(device.id)?.enabled).toBeUndefined();
    expect(store.isToolAllowed(device.id, 'session_list')).toBe(true);
  });

  it('removes a device and reports whether one went', () => {
    const persist = vi.fn();
    const store = makeStore(persist);
    const device = addPixel(store);
    persist.mockClear();

    expect(store.remove(device.id)).toBe(true);
    expect(store.remove(device.id)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.list()).toHaveLength(0);
  });

  it('round-trips through YAML without dropping a field', () => {
    const store = makeStore();
    const device = store.add({
      machineId: 'phone-machine-1',
      name: 'Pixel 8',
      deviceId: 'aa:bb:cc:dd:ee:ff',
      pskRef: 'mobile-phone-machine-1',
      allow: ['session_*', 'artifact_get'],
      enabled: false,
    });
    store.update(device.id, { lastSeenAt: 1_700_000_123_456 });

    const exported = store.exportAll();
    const reloaded = makeStore();
    reloaded.importAll(sanitizeMobileDevices(
      (YAML.parse(YAML.stringify({ devices: exported })) as { devices: unknown }).devices,
    ));

    expect(reloaded.exportAll()).toEqual(exported);
    // Named explicitly: these are the fields whose silent loss forked duplicates.
    const restored = reloaded.getByMachineId('phone-machine-1');
    expect(restored?.machineId).toBe('phone-machine-1');
    expect(restored?.enabled).toBe(false);
    expect(restored?.lastSeenAt).toBe(1_700_000_123_456);
    expect(restored?.deviceId).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('never writes secret material into the registry snapshot', () => {
    const store = makeStore();
    addPixel(store);
    const yaml = YAML.stringify({ devices: store.exportAll() });

    expect(yaml).toContain('pskRef');
    expect(yaml).toContain('mobile-phone-machine-1');
    // Only the opaque reference — no key material, under any spelling.
    expect(yaml).not.toMatch(/\bpsk:/);
    expect(yaml).not.toMatch(/\bsecret\b/i);
  });
});

describe('sanitizeMobileDevices', () => {
  it('drops entries that are not structurally sound', () => {
    const sane = sanitizeMobileDevices([
      { id: 'a', machineId: 'm1', name: 'Phone', pskRef: 'r', allow: [], createdAt: 1 },
      { id: '', machineId: 'm2', name: 'No id', pskRef: 'r', allow: [], createdAt: 1 },
      { id: 'c', name: 'No machineId', pskRef: 'r', allow: [], createdAt: 1 },
      'not an object',
      null,
    ], clock);

    expect(sane.map((d: MobileDevice) => d.id)).toEqual(['a']);
  });

  it('coerces a corrupt allow-list to a safe empty list rather than throwing', () => {
    const sane = sanitizeMobileDevices([
      { id: 'a', machineId: 'm1', name: 'Phone', pskRef: 'r', allow: 'session_*', createdAt: 1 },
      { id: 'b', machineId: 'm2', name: 'Phone', pskRef: 'r', allow: ['ok', 7, null], createdAt: 1 },
    ], clock);

    expect(sane[0].allow).toEqual([]);
    expect(sane[1].allow).toEqual(['ok']);
  });

  it('supplies a fallback createdAt so a hand-edited file cannot produce NaN', () => {
    const sane = sanitizeMobileDevices([
      { id: 'a', machineId: 'm1', name: 'Phone', pskRef: 'r', allow: [] },
    ], clock);

    expect(sane[0].createdAt).toBe(clock());
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeMobileDevices(undefined, clock)).toEqual([]);
    expect(sanitizeMobileDevices({ devices: [] }, clock)).toEqual([]);
  });
});
