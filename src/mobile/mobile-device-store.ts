/**
 * MobileDeviceStore — in-memory owner of the paired-phone registry.
 *
 * Records which phones may talk to this hub over BLE and WHICH tools each may
 * invoke (the `allow` glob list — deny-by-default). Pure model + authorisation:
 * no BLE, no crypto, and it never holds secret material (only `pskRef`
 * references; the PSKs live in the mobile SecretStore).
 *
 * Deliberately shaped like PeerConfigManager — same injected `persist` sink, same
 * no-I/O-in-the-constructor rule (the orchestrator hydrates via
 * `importAll(loadMobileDevices())`), same copy-on-read discipline, same
 * injectable clock. One pairing model for the project, per the fleet precedent.
 *
 * KEYED ON `machineId`. See the note in types/mobile-device.ts: the advertised
 * BLE address rotates on Android and cannot be an identity.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { MobileDevice } from '../types/mobile-device.js';
import { toolGlobMatch } from '../utils/glob-matcher.js';
import { sanitizeMobileDevices } from './mobile-device-sanitize.js';

export interface AddMobileDeviceInput {
  machineId: string;
  name: string;
  pskRef: string;
  deviceId?: string;
  allow?: string[];
  enabled?: boolean;
}

export class MobileDeviceStore extends EventEmitter {
  private devices: MobileDevice[] = [];

  constructor(
    private readonly persist?: (devices: MobileDevice[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /** Register a newly paired device and return a COPY of it. */
  add(input: AddMobileDeviceInput): MobileDevice {
    const device: MobileDevice = {
      id: randomUUID(),
      machineId: input.machineId,
      name: input.name,
      pskRef: input.pskRef,
      allow: [...(input.allow ?? [])],
      createdAt: this.now(),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    this.devices.push(device);
    this.markChanged();
    logger.info(`[MobileDeviceStore] Paired device "${device.name}" (${device.id})`);
    return this.copy(device);
  }

  /**
   * Upsert keyed by machineId: an already-known phone is updated IN PLACE (same
   * id + createdAt) so a re-pair never forks a duplicate; otherwise a fresh
   * device is added. An omitted `allow` PRESERVES the existing authorisation, so
   * re-pairing a trusted phone does not silently strip its permissions.
   */
  upsertByMachineId(input: AddMobileDeviceInput): MobileDevice {
    const existing = this.devices.find(d => d.machineId === input.machineId);
    if (!existing) return this.add(input);

    existing.name = input.name;
    existing.pskRef = input.pskRef;
    if (input.deviceId !== undefined) existing.deviceId = input.deviceId;
    if (input.allow !== undefined) existing.allow = [...input.allow];
    if (input.enabled !== undefined) existing.enabled = input.enabled;
    this.markChanged();
    logger.info(`[MobileDeviceStore] Re-paired device "${existing.name}" (${existing.id})`);
    return this.copy(existing);
  }

  /** All devices as independent copies. */
  list(): MobileDevice[] {
    return this.devices.map(d => this.copy(d));
  }

  /** Get a device by id (copy), or undefined. */
  get(id: string): MobileDevice | undefined {
    const device = this.devices.find(d => d.id === id);
    return device ? this.copy(device) : undefined;
  }

  /** Get a device by its stable machineId (copy), or undefined. */
  getByMachineId(machineId: string): MobileDevice | undefined {
    const device = this.devices.find(d => d.machineId === machineId);
    return device ? this.copy(device) : undefined;
  }

  /**
   * Merge `patch` into the device with `id` (id/machineId/createdAt immutable).
   * Returns a copy of the updated device, or undefined if not found.
   */
  update(
    id: string,
    patch: Partial<Omit<MobileDevice, 'id' | 'machineId' | 'createdAt'>>,
  ): MobileDevice | undefined {
    const device = this.devices.find(d => d.id === id);
    if (!device) return undefined;
    if (patch.name !== undefined) device.name = patch.name;
    if (patch.pskRef !== undefined) device.pskRef = patch.pskRef;
    if (patch.deviceId !== undefined) device.deviceId = patch.deviceId;
    if (patch.allow !== undefined) device.allow = [...patch.allow];
    if (patch.lastSeenAt !== undefined) device.lastSeenAt = patch.lastSeenAt;
    if (patch.enabled !== undefined) device.enabled = patch.enabled;
    this.markChanged();
    return this.copy(device);
  }

  /** Delete a device. Returns whether one was removed. */
  remove(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter(d => d.id !== id);
    const removed = this.devices.length !== before;
    if (removed) this.markChanged();
    return removed;
  }

  /**
   * Whether `deviceId` (the local record id) may invoke `toolName`.
   * Deny-by-default: an unknown device, an explicitly disabled one, or an empty
   * allow-list denies everything. Otherwise allowed iff ANY pattern matches.
   */
  isToolAllowed(deviceId: string, toolName: string): boolean {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device || device.enabled === false || device.allow.length === 0) return false;
    return device.allow.some(pattern => toolGlobMatch(pattern, toolName));
  }

  /** Snapshot of all devices for persistence (independent copies). */
  exportAll(): MobileDevice[] {
    return this.devices.map(d => this.copy(d));
  }

  /** Replace internal state from persisted data, sanitising each entry. */
  importAll(devices: MobileDevice[]): void {
    this.devices = sanitizeMobileDevices(devices, this.now);
    logger.info(`[MobileDeviceStore] Imported ${this.devices.length} device(s)`);
  }

  private copy(device: MobileDevice): MobileDevice {
    return { ...device, allow: [...device.allow] };
  }

  private markChanged(): void {
    this.persist?.(this.exportAll());
    this.emit('mobile-devices:changed');
  }
}
