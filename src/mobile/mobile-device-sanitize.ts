/**
 * The ONE sanitizer for persisted mobile device entries.
 *
 * Both the YAML loader and MobileDeviceStore.importAll rebuild devices field by
 * field so a hand-edited or corrupt file can never crash startup. The fleet
 * equivalent (peer-sanitize) was written after the loader and the manager drifted
 * apart and silently dropped `machineId` — a peer that lost its key could not be
 * found again, so re-pairing forked a duplicate entry and orphaned its PSK.
 * Sharing one implementation makes that class of drift structurally impossible,
 * and it matters more here: machineId IS the mobile registry key.
 */

import type { MobileDevice } from '../types/mobile-device.js';

/**
 * Coerce arbitrary parsed data into valid MobileDevices, dropping entries that
 * are not structurally sound. `now` supplies a fallback `createdAt` (injectable
 * so tests stay deterministic).
 */
export function sanitizeMobileDevices(
  devices: unknown,
  now: () => number = Date.now,
): MobileDevice[] {
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((d): d is Record<string, unknown> =>
      isRecord(d) &&
      isNonEmptyString(d.id) &&
      isNonEmptyString(d.machineId) &&
      typeof d.name === 'string')
    .map((d): MobileDevice => ({
      id: d.id as string,
      machineId: d.machineId as string,
      name: d.name as string,
      pskRef: typeof d.pskRef === 'string' ? d.pskRef : '',
      allow: Array.isArray(d.allow) ? d.allow.filter((a): a is string => typeof a === 'string') : [],
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : now(),
      ...(isNonEmptyString(d.deviceId) ? { deviceId: d.deviceId } : {}),
      ...(typeof d.lastSeenAt === 'number' ? { lastSeenAt: d.lastSeenAt } : {}),
      ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}),
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
