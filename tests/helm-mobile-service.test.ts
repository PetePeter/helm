/**
 * HelmMobileService — the mobile_* tool surface.
 *
 * The tests that matter here are the two that describe why this service exists:
 *
 *  1. A phone that has just paired is granted NOTHING, so `mobile_device_allow`
 *     is the step that makes pairing useful. This was a real incident — a tablet
 *     paired, held a live BLE link, and had every single session_list denied
 *     because its allow-list was empty. The grant/revoke round-trip is checked
 *     against a REAL MobileDeviceStore + MobilePairing, not a mock, because the
 *     bug lived in the interaction between them.
 *
 *  2. Every mobile_* tool is hard-denied to phones and fleet peers. If that ever
 *     regresses, a paired phone can pair further devices or widen its own grants
 *     — privilege escalation through the very gate meant to contain it.
 */

import { describe, it, expect } from 'vitest';
import { HelmMobileService, type MobileDeps } from '../src/mcp/services/helm-mobile-service.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { MobilePairing } from '../src/mobile/mobile-pairing.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { HARD_DENY_TOOLS } from '../src/mcp/peer/inbound-call-gate.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';

const clock = () => 1_700_000_000_000;

const MOBILE_TOOLS = [
  'mobile_pair_start',
  'mobile_pair_status',
  'mobile_pair_confirm',
  'mobile_pair_cancel',
  'mobile_device_list',
  'mobile_device_allow',
];

/** A real store + real pairing coordinator; only the link state is stubbed. */
function makeService(online = false): {
  service: HelmMobileService;
  deviceStore: MobileDeviceStore;
  pairing: MobilePairing;
} {
  const deviceStore = new MobileDeviceStore(undefined, clock);
  const secretStore = new SecretStore();
  const pairing = new MobilePairing({ deviceStore, secretStore, machineId: 'test-hub', now: clock });
  const deps: MobileDeps = { pairing, deviceStore, isOnline: () => online };
  return { service: new HelmMobileService(() => deps), deviceStore, pairing };
}

describe('HelmMobileService', () => {
  it('reports a clear error for every method when mobile is not wired', () => {
    const service = new HelmMobileService(() => undefined);
    const expected = /Mobile support is not enabled/;

    expect(() => service.pairStart()).toThrow(expected);
    expect(() => service.pairStatus()).toThrow(expected);
    expect(() => service.pairConfirm(true)).toThrow(expected);
    expect(() => service.pairCancel()).toThrow(expected);
    expect(() => service.deviceList()).toThrow(expected);
    expect(() => service.deviceAllow('any', [])).toThrow(expected);
  });

  it('grants a paired-but-denied phone an allow-list, which is what unblocks it', () => {
    const { service, deviceStore } = makeService();
    // Exactly the state MobilePairing.finalize leaves a NEW phone in.
    const device = deviceStore.add({
      machineId: 'tablet-machine',
      name: 'Lenovo Tab M8',
      pskRef: 'mobile-tablet-machine',
      allow: [],
    });
    expect(deviceStore.isToolAllowed(device.id, 'session_list')).toBe(false);

    const updated = service.deviceAllow(device.id, ['session_list', 'session_read_terminal']);

    expect(updated.allow).toEqual(['session_list', 'session_read_terminal']);
    expect(deviceStore.isToolAllowed(device.id, 'session_list')).toBe(true);
    expect(deviceStore.isToolAllowed(device.id, 'session_read_terminal')).toBe(true);
    // Not granted → still denied. Replacing the list must not widen it.
    expect(deviceStore.isToolAllowed(device.id, 'session_send_text')).toBe(false);
  });

  it('replaces rather than merges, so an empty array revokes everything', () => {
    const { service, deviceStore } = makeService();
    const device = deviceStore.add({
      machineId: 'tablet-machine',
      name: 'Lenovo Tab M8',
      pskRef: 'ref',
      allow: ['session_*'],
    });

    service.deviceAllow(device.id, []);

    expect(deviceStore.isToolAllowed(device.id, 'session_list')).toBe(false);
    expect(service.deviceList().devices[0]?.allow).toEqual([]);
  });

  it('rejects an unknown device id instead of silently doing nothing', () => {
    const { service } = makeService();
    expect(() => service.deviceAllow('no-such-device', ['session_list']))
      .toThrow(/Unknown mobile device/);
  });

  it('summarises devices with live link state and without key material', () => {
    const { service, deviceStore } = makeService(true);
    deviceStore.add({ machineId: 'm1', name: 'Tab', pskRef: 'secret-ref', allow: ['session_list'] });

    const [summary] = service.deviceList().devices;

    expect(summary).toMatchObject({ machineId: 'm1', name: 'Tab', online: true, enabled: true });
    expect(JSON.stringify(summary)).not.toContain('secret-ref');
  });

  it('arms pairing and reports the state transition', () => {
    const { service } = makeService();
    expect(service.pairStatus().status).toBe('idle');

    expect(service.pairStart().ok).toBe(true);

    expect(service.pairStatus().status).toBe('scanning');
  });

  it('cancelling an armed scan returns it to a non-scanning state', () => {
    const { service } = makeService();
    service.pairStart();

    const state = service.pairCancel('changed my mind');

    expect(state.status).not.toBe('scanning');
  });
});

describe('mobile_* tools are local-only', () => {
  it('hard-denies every mobile tool to phones and fleet peers', () => {
    for (const tool of MOBILE_TOOLS) {
      expect(HARD_DENY_TOOLS.has(tool), `${tool} must be hard-denied`).toBe(true);
    }
  });

  it('declares every mobile tool in the catalogue', () => {
    const names = new Set(MCP_TOOLS.map(t => t.name));
    for (const tool of MOBILE_TOOLS) {
      expect(names.has(tool), `${tool} must be declared`).toBe(true);
    }
  });
});
