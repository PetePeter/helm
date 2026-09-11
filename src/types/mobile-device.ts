/**
 * MobileDevice — a phone that has completed the SAS pairing flow and may talk to
 * this hub over BLE.
 *
 * A PURE data model, exactly like PeerConfig: no networking, no crypto, and it
 * NEVER holds secret material — `pskRef` is an opaque lookup key into the mobile
 * SecretStore, not the PSK itself.
 *
 * IDENTITY IS `machineId`, NOT `deviceId`. Android rotates a peripheral's
 * advertised BLE address for privacy, so the address cannot key the registry — a
 * phone would fork a duplicate entry (and orphan its PSK) the first time the OS
 * rotated it. `machineId` is generated once by the phone app and carried in the
 * SecureChannel handshake transcript, so it survives rotation, reinstall-free
 * restarts and reconnects. `deviceId` is kept only as a last-seen scanning hint.
 */
export interface MobileDevice {
  /** Unique local identifier (UUID v4). */
  id: string;
  /** The phone's stable, app-generated machine identity. The registry key. */
  machineId: string;
  /** Human-facing label taken from the BLE advertisement, e.g. "Pixel 8". */
  name: string;
  /**
   * Last-seen BLE peripheral id. A scanning HINT only — never an identity.
   * Android rotates this, so it is expected to change between connections.
   */
  deviceId?: string;
  /**
   * Opaque reference into the mobile secret store for this device's pairing PSK.
   * NEVER the secret itself — only a lookup key.
   */
  pskRef: string;
  /**
   * Tool-name glob patterns this device may invoke, e.g. ["session_*"].
   * `*` is the only wildcard. Empty = deny all (deny-by-default).
   */
  allow: string[];
  /** Epoch ms the device was paired. */
  createdAt: number;
  /** Epoch ms the device was last connected. Absent until it reconnects once. */
  lastSeenAt?: number;
  /**
   * Whether this device may connect. Default-true semantics: `undefined` is
   * ENABLED. Explicit `false` denies both the BLE link and every inbound call.
   */
  enabled?: boolean;
}
