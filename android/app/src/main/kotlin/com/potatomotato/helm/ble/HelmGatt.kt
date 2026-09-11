package com.potatomotato.helm.ble

import java.util.UUID

/**
 * HelmGatt — the GATT contract the phone serves and Helm consumes.
 *
 * These values mirror `src/mobile/ble/characteristics.ts` exactly. The names
 * there are stated from HELM's point of view and are kept verbatim here on
 * purpose: one vocabulary across both languages. That means the DIRECTIONS
 * INVERT on this side —
 *
 *   RX: Helm WRITES it, so the PHONE RECEIVES on it  -> writable characteristic
 *   TX: Helm SUBSCRIBES to it, so the PHONE NOTIFIES -> notify characteristic,
 *       and the wake channel
 *   CTL: declared and RESERVED, currently unused. Dropping it or repurposing it
 *        is a wire break — see docs/mobile-pairing.md.
 *
 * Changing any UUID breaks discovery with no error message, only a device that
 * is never found.
 */
object HelmGatt {
    /** The service this app advertises. Helm scans for exactly this. */
    val SERVICE_UUID: UUID = UUID.fromString("48454c4d-4d4f-4249-4c45-000000000001")

    /** Helm -> phone. Helm writes session traffic here. */
    val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("48454c4d-4d4f-4249-4c45-000000000002")

    /** Phone -> Helm. Helm subscribes here; also the wake channel. */
    val TX_CHARACTERISTIC_UUID: UUID = UUID.fromString("48454c4d-4d4f-4249-4c45-000000000003")

    /** Reserved. Declared so the service shape matches; carries nothing today. */
    val CTL_CHARACTERISTIC_UUID: UUID = UUID.fromString("48454c4d-4d4f-4249-4c45-000000000004")

    /** The standard Client Characteristic Configuration descriptor. */
    val CCC_DESCRIPTOR_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}
