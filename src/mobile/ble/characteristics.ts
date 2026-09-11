/**
 * characteristics — the GATT UUIDs the phone serves and Helm consumes.
 *
 * Directions are stated from HELM's point of view. Helm is the central: the
 * Android app advertises this service and serves the GATT server (see context
 * af250949 — the role flip). These values are a wire contract shared with the
 * Kotlin peripheral; changing one breaks discovery with no error message, only
 * a device that is never found.
 *
 * Noble reports UUIDs lowercased with the dashes stripped, so every UUID is
 * exported in both spellings and compared in the normalised form.
 */

/** The service the phone advertises. Helm scans for exactly this. */
export const HELM_SERVICE_UUID = '48454c4d-4d4f-4249-4c45-000000000001';

/** Helm → phone. Helm WRITES session traffic here. */
export const HELM_RX_CHARACTERISTIC_UUID = '48454c4d-4d4f-4249-4c45-000000000002';

/** Phone → Helm. Helm SUBSCRIBES here; also the wake channel. */
export const HELM_TX_CHARACTERISTIC_UUID = '48454c4d-4d4f-4249-4c45-000000000003';

/** Pairing traffic only. Never carries session data. */
export const HELM_CTL_CHARACTERISTIC_UUID = '48454c4d-4d4f-4249-4c45-000000000004';

/** Strip dashes and lowercase, matching how noble reports a UUID. */
export function normaliseUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

export const HELM_SERVICE_UUID_SHORT = normaliseUuid(HELM_SERVICE_UUID);
export const HELM_RX_UUID_SHORT = normaliseUuid(HELM_RX_CHARACTERISTIC_UUID);
export const HELM_TX_UUID_SHORT = normaliseUuid(HELM_TX_CHARACTERISTIC_UUID);
export const HELM_CTL_UUID_SHORT = normaliseUuid(HELM_CTL_CHARACTERISTIC_UUID);
