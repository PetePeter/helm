/**
 * Mobile IPC handler tests — the boundary contract.
 *
 * Real MobileDeviceStore, real MobilePairing, faked Electron. The things worth
 * asserting here are the ones a UI bug would otherwise hide: that no secret
 * material crosses the boundary, that disabling a device drops its live link at
 * once rather than at next reconnect, and that the channels stay inert (rather
 * than throwing) when the BLE transport is not running.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { MobileDeviceStore } = await import('../src/mobile/mobile-device-store.js');
const { MobilePairing } = await import('../src/mobile/mobile-pairing.js');
const { SecretStore } = await import('../src/mcp/peer/secret-store.js');
const { setupMobileHandlers } = await import('../src/electron/ipc/mobile-handlers.js');

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

interface Harness {
  devices: InstanceType<typeof MobileDeviceStore>;
  secrets: InstanceType<typeof SecretStore>;
  pairing: InstanceType<typeof MobilePairing>;
  dropped: string[];
  dispose: () => void;
}

function setup(options: { withPairing?: boolean } = {}): Harness {
  const devices = new MobileDeviceStore();
  const secrets = new SecretStore();
  const dropped: string[] = [];
  const pairing = new MobilePairing({
    deviceStore: devices,
    secretStore: secrets,
    machineId: 'desktop',
    dropLink: (machineId: string) => { dropped.push(machineId); },
  });

  const dispose = setupMobileHandlers({
    deviceStore: devices,
    getPairing: () => (options.withPairing === false ? null : pairing),
    isOnline: (machineId: string) => machineId === 'phone-online',
    dropLink: (machineId: string) => { dropped.push(machineId); },
  });

  return { devices, secrets, pairing, dropped, dispose };
}

function addDevice(h: Harness, machineId = 'phone-machine-1') {
  const device = h.devices.add({
    machineId,
    name: 'Pixel 8',
    pskRef: `mobile-${machineId}`,
    allow: ['session_*'],
  });
  h.secrets.set(device.pskRef, Buffer.alloc(32, 7));
  return device;
}

describe('mobile IPC handlers', () => {
  let h: Harness;

  beforeEach(() => {
    handleCalls.clear();
    h = setup();
  });

  it('never sends secret material to the renderer', async () => {
    addDevice(h);
    const listed = await getHandler('mobile:list')();

    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain(Buffer.alloc(32, 7).toString('base64'));
    expect(serialised).not.toMatch(/pskRef/);
  });

  it('reports enabled and online state for the tab', async () => {
    addDevice(h, 'phone-online');
    const offline = addDevice(h, 'phone-offline');
    h.devices.update(offline.id, { enabled: false });

    const listed = await getHandler('mobile:list')();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ machineId: 'phone-online', enabled: true, online: true });
    expect(listed[1]).toMatchObject({ machineId: 'phone-offline', enabled: false, online: false });
  });

  it('drops the live link the moment a device is disabled', async () => {
    const device = addDevice(h);

    await getHandler('mobile:setEnabled')({}, device.id, false);

    expect(h.devices.get(device.id)?.enabled).toBe(false);
    expect(h.dropped).toEqual(['phone-machine-1']);
    // Denied for inbound too, without waiting for a reconnect.
    expect(h.devices.isToolAllowed(device.id, 'session_list')).toBe(false);
  });

  it('does not drop a link when a device is re-enabled', async () => {
    const device = addDevice(h);
    await getHandler('mobile:setEnabled')({}, device.id, false);
    h.dropped.length = 0;

    await getHandler('mobile:setEnabled')({}, device.id, true);

    expect(h.devices.isToolAllowed(device.id, 'session_list')).toBe(true);
    expect(h.dropped).toEqual([]);
  });

  it('revoking removes the record and its secret', async () => {
    const device = addDevice(h);

    const result = await getHandler('mobile:revoke')({}, device.id);

    expect(result).toEqual({ ok: true });
    expect(h.devices.get(device.id)).toBeUndefined();
    expect(h.secrets.get(device.pskRef)).toBeUndefined();
  });

  it('rejects a revoke for an unknown device rather than reporting success', async () => {
    expect(await getHandler('mobile:revoke')({}, 'no-such-device')).toEqual({ ok: false });
  });

  it('strips non-string entries from a submitted allow-list', async () => {
    const device = addDevice(h);

    await getHandler('mobile:setAllowList')({}, device.id, ['session_*', '', 7, null]);

    expect(h.devices.get(device.id)?.allow).toEqual(['session_*']);
  });

  it('stays inert instead of throwing when BLE is not running', async () => {
    handleCalls.clear();
    const off = setup({ withPairing: false });

    expect(await getHandler('mobile:startPairing')()).toMatchObject({ ok: false });
    expect(await getHandler('mobile:revoke')({}, 'anything')).toMatchObject({ ok: false });
    expect(await getHandler('mobile:pairingState')()).toEqual({ status: 'idle' });
    // The registry is local, so it still answers.
    expect(await getHandler('mobile:list')()).toEqual([]);

    off.dispose();
  });

  it('removes every channel on dispose', () => {
    expect(handleCalls.size).toBeGreaterThan(0);
    h.dispose();
    expect(handleCalls.size).toBe(0);
  });
});
