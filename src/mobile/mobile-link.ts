/**
 * MobileLink — one connected phone, independent of how it is connected.
 *
 * This is the only shape `MobileLinkManager` and `MobilePairing` ever see: an
 * address to name the connection by, a `BytePipe` for `SecureChannel` to speak
 * over, and a few optional diagnostics. Nothing about a radio or a socket
 * crosses this line, which is what lets one manager own BLE and LAN transports
 * without a branch on which is which.
 *
 * It lived in `ble/ble-link-client.ts` as `BleLink` while BLE was the only
 * transport. It was already transport-neutral in shape — only the name tied it
 * to a radio, and a LAN socket presenting itself as a `BleLink` would have been
 * actively misleading. See P-0752.
 */

import type { BytePipe } from './secure-channel';

/**
 * Transport ranks. Higher wins: a LAN link displaces a live BLE one.
 *
 * This is a fixed ordering, not a heuristic — BLE is ~5-20 KB/s and LAN is not,
 * so there is nothing to weigh. Deliberately NOT "prefer whatever connected
 * first": at home BLE routinely wins the race, and the user would spend the
 * evening on the slow pipe with a gigabit link sitting idle beside it.
 *
 * They live HERE, beside the link contract, rather than in the manager: a
 * transport must declare its rank, and making a transport import the manager to
 * do so is a cycle (`ble-link-client` → `mobile-link-manager` → …), which ESM
 * resolves as an undefined class at import time rather than an error.
 */
export const RANK_BLE = 1;
export const RANK_LAN = 2;

export interface MobileLink {
  /**
   * How the transport names this connection: a BLE peripheral id, or a socket
   * address. NOT an identity — these are different id spaces and must never be
   * compared across transports. Identity is the `machineId` the handshake
   * proves. See the MobileLinkManager header.
   */
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly pipe: BytePipe;
  /** Observe framing losses on this link — diagnostics, never fatal. */
  onFramingDrop(handler: (reason: string) => void): void;
  /** Observe a transport failure that makes the byte stream unsafe to continue. */
  onTransportError?(handler: (failure: LinkTransportError) => void): void;
  /**
   * Whether writes are still queued or in flight — a bulk transfer the
   * transport has not finished sending. The keepalive reads this as liveness:
   * see mobile-link-manager.ts. Optional because a transport that cannot answer
   * simply gets the plain silence rule.
   */
  hasPendingWrites?(): boolean;
}

/**
 * A write that failed in a way that makes the stream unsafe to continue.
 *
 * The chunking fields describe a GATT write and mean nothing to a socket, which
 * is why `onTransportError` is optional: a transport that has no such failure
 * mode simply does not report one.
 */
export interface LinkTransportError {
  readonly chunkLength: number;
  readonly mtu: number;
  readonly withoutResponse: boolean;
  readonly elapsedMs: number;
  readonly error: unknown;
}
