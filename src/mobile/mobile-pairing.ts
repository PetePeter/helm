/**
 * MobilePairing — the coordinator that turns a BLE link into a trusted phone.
 *
 * IT IS NOT A CRYPTO STATE MACHINE. SecureChannel already performs the whole SAS
 * exchange (X25519 commit/reveal, the 6-digit comparison, the confirm-MAC and the
 * derived PSK) over an abstract BytePipe, and the Kotlin client asserts against
 * committed vectors for exactly those bytes. A second pairing exchange — on the
 * CTL characteristic or anywhere else — would fork the wire format, and a
 * cross-language wire mismatch does not fail loudly: it fails as "pairing just
 * never works". So this module only drives the flow and owns the trust lifecycle:
 *
 *   start() -> offerLink() -> [SAS on both screens] -> confirm() -> persisted
 *
 * The CTL characteristic stays declared and RESERVED-BUT-UNUSED in
 * ble/characteristics.ts; removing the UUID would itself be a wire break.
 *
 * Shaped after the fleet PairingCoordinator + PeerPairing.tryFinalize: one
 * pairing in flight, a TTL, an attempt cap, and an ATOMIC finalize that rolls
 * back every write if any part of it fails. Trust is persisted only when a real
 * handshake AND a real user confirmation have both happened.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { SecureChannel } from './secure-channel.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { SecretStore } from '../mcp/peer/secret-store.js';
import type { BleLink } from './ble/ble-link-client.js';

/** How long an unconfirmed pairing may sit on screen before it is reaped. */
export const PAIRING_TTL_MS = 180_000;
/** Failed attempts tolerated inside one window before a cooldown applies. */
export const MAX_ATTEMPTS_PER_WINDOW = 5;
/** The window failed attempts are counted over. */
export const ATTEMPT_WINDOW_MS = 10 * 60_000;
/** How long the cooldown lasts once the cap is hit. */
export const COOLDOWN_MS = 15 * 60_000;

export type MobilePairingStatus = 'idle' | 'scanning' | 'awaiting-sas' | 'paired' | 'failed';

/**
 * What the renderer is told about the flow. Carries the SAS digits — which are a
 * KDF *output*, safe to display — and never any key material.
 */
export interface MobilePairingState {
  status: MobilePairingStatus;
  sas?: string;
  deviceName?: string;
  reason?: string;
}

export interface StartResult {
  ok: boolean;
  reason?: string;
}

export interface MobilePairingOptions {
  deviceStore: MobileDeviceStore;
  secretStore: SecretStore;
  /** This hub's stable machine id, bound into the handshake transcript. */
  machineId: string;
  /** Force-disconnect a device's live link (used by revoke). */
  dropLink?: (machineId: string) => void;
  now?: () => number;
  ttlMs?: number;
  /**
   * Seam for opening the channel over a link. Defaults to the real
   * SecureChannel; tests override it only to simulate a transport failure.
   */
  openChannel?: (link: BleLink, machineId: string) => Promise<SecureChannel>;
}

/** An in-flight attempt. Nothing here is persisted until finalize succeeds. */
interface ActivePairing {
  startedAt: number;
  channel: SecureChannel | null;
  link: BleLink | null;
  decided: boolean;
}

export class MobilePairing extends EventEmitter {
  private readonly opts: MobilePairingOptions;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly openChannel: (link: BleLink, machineId: string) => Promise<SecureChannel>;

  private active: ActivePairing | null = null;
  private state: MobilePairingState = { status: 'idle' };
  private failures: number[] = [];
  private cooldownUntil = 0;

  constructor(options: MobilePairingOptions) {
    super();
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PAIRING_TTL_MS;
    this.openChannel = options.openChannel ?? ((link, machineId) =>
      SecureChannel.open({
        pipe: link.pipe,
        role: 'initiator',
        machineId,
        sessionId: `mobile-${link.deviceId}-${this.now()}`,
      }));
  }

  /** Arm pairing mode. The user has put the phone into advertising mode. */
  start(): StartResult {
    this.reapExpired();
    if (this.active) return { ok: false, reason: 'A pairing is already in progress' };

    const now = this.now();
    if (now < this.cooldownUntil) {
      return { ok: false, reason: 'Too many failed attempts — try again shortly' };
    }
    this.failures = this.failures.filter(at => now - at < ATTEMPT_WINDOW_MS);
    if (this.failures.length >= MAX_ATTEMPTS_PER_WINDOW) {
      this.cooldownUntil = now + COOLDOWN_MS;
      return { ok: false, reason: 'Too many failed attempts — cooldown in effect' };
    }

    this.active = { startedAt: now, channel: null, link: null, decided: false };
    this.setState({ status: 'scanning' });
    return { ok: true };
  }

  /**
   * Offer a freshly discovered link to the flow. Returns whether it was taken.
   * A link arriving outside pairing mode is ignored — an unpaired phone can
   * never pair itself without a local user action.
   */
  async offerLink(link: BleLink): Promise<boolean> {
    this.reapExpired();
    if (!this.active || this.active.channel) return false;

    try {
      const channel = await this.openChannel(link, this.opts.machineId);
      // A second link may have been taken, or the flow cancelled, while we awaited.
      if (!this.active || this.active.channel) {
        channel.close('pairing no longer active');
        return false;
      }
      this.active.channel = channel;
      this.active.link = link;
      this.setState({
        status: 'awaiting-sas',
        sas: channel.sas,
        deviceName: link.deviceName ?? channel.peerMachine,
      });
      return true;
    } catch (err) {
      this.fail(`handshake-failed: ${truncate((err as Error)?.message)}`);
      return false;
    }
  }

  /**
   * The user's verdict on the two 6-digit codes. `false` — or any failure below —
   * persists nothing at all.
   */
  confirm(accepted: boolean): void {
    this.reapExpired();
    const active = this.active;
    if (!active || active.decided || !active.channel) return;
    active.decided = true;

    if (!accepted) {
      active.channel.confirmSas(false);
      this.fail('user-rejected');
      return;
    }
    active.channel.confirmSas(true);
    this.finalize(active);
  }

  /** Abandon the flow from outside (expiry, UI cancel, link loss). */
  cancel(reason = 'cancelled'): void {
    if (!this.active) return;
    this.fail(reason);
  }

  /** The current flow state, as handed to the renderer. */
  getState(): MobilePairingState {
    return { ...this.state };
  }

  /**
   * Revoke a paired device: remove the record AND its PSK, and drop the live
   * link so revocation takes effect immediately rather than at next reconnect.
   * With the record gone the device matches nothing, so inbound calls fall
   * through to the same uniform denial as any unknown caller.
   */
  revoke(id: string): boolean {
    const device = this.opts.deviceStore.get(id);
    if (!device) return false;

    this.opts.deviceStore.remove(id);
    try {
      this.opts.secretStore.remove(device.pskRef);
    } catch (err) {
      logger.error(`[MobilePairing] Failed to drop secret on revoke: ${truncate((err as Error)?.message)}`);
    }
    try {
      this.opts.dropLink?.(device.machineId);
    } catch (err) {
      logger.error(`[MobilePairing] Failed to drop link on revoke: ${truncate((err as Error)?.message)}`);
    }
    logger.info(`[MobilePairing] Revoked device "${device.name}" (${device.id})`);
    return true;
  }

  // ------------------------------------------------------------------ finalize

  /**
   * ATOMIC: write the device record and the PSK, or leave the store exactly as it
   * was. Mirrors PeerPairing.tryFinalize — a half-paired device that has a record
   * but no usable key is worse than no device at all, because it looks trusted.
   */
  private finalize(active: ActivePairing): void {
    const channel = active.channel!;
    const link = active.link!;
    const machineId = channel.peerMachine;
    const pskRef = `mobile-${machineId}`;

    const existing = this.opts.deviceStore.getByMachineId(machineId);
    let recordId: string | null = null;
    let psk: Buffer | null = null;

    try {
      psk = Buffer.from(channel.pairingPsk);

      const device = this.opts.deviceStore.upsertByMachineId({
        machineId,
        name: link.deviceName ?? machineId,
        deviceId: link.deviceId,
        pskRef,
        // Deny-by-default for a new phone; an existing one keeps what it was granted.
        ...(existing ? {} : { allow: [] }),
      });
      recordId = device.id;

      this.opts.secretStore.set(pskRef, psk);

      this.active = null;
      this.setState({ status: 'paired', deviceName: device.name });
      this.emit('paired', { id: device.id, machineId });
      logger.info(`[MobilePairing] Paired "${device.name}" (${device.id})`);
    } catch (err) {
      // ROLLBACK — undo everything this attempt wrote.
      try {
        if (recordId && !existing) {
          this.opts.deviceStore.remove(recordId);
        } else if (recordId && existing) {
          this.opts.deviceStore.update(recordId, {
            name: existing.name,
            pskRef: existing.pskRef,
            allow: existing.allow,
            ...(existing.deviceId !== undefined ? { deviceId: existing.deviceId } : {}),
          });
        }
      } catch { /* the abort below is what matters */ }
      this.fail(`persist-failed: ${truncate((err as Error)?.message)}`);
    } finally {
      psk?.fill(0);
    }
  }

  // ------------------------------------------------------------------- helpers

  /** Reap an attempt the user walked away from, so the flow never wedges. */
  private reapExpired(): void {
    if (!this.active) return;
    if (this.now() - this.active.startedAt < this.ttlMs) return;
    this.fail('expired');
  }

  private fail(reason: string): void {
    const channel = this.active?.channel;
    this.active = null;
    this.failures.push(this.now());
    try {
      channel?.close(reason);
    } catch { /* a channel that is already gone is not an error */ }
    logger.warn(`[MobilePairing] Pairing aborted (${reason})`);
    this.setState({ status: 'failed', reason });
  }

  private setState(state: MobilePairingState): void {
    this.state = state;
    this.emit('state', this.getState());
  }
}

function truncate(message: string | undefined): string {
  return (message ?? 'unknown').slice(0, 80);
}
