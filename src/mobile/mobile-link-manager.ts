/**
 * MobileLinkManager — the one owner of the BLE transport lifecycle.
 *
 * Before this existed the mobile pieces were all correct and none of them were
 * connected: `BleLinkClient` connected to whatever advertised the Helm service,
 * nothing re-established a link to a phone that had already paired, and the
 * settings tab reported every device offline because nobody could say otherwise.
 * This module closes that gap — scan, identify, keep or drop, report.
 *
 * IDENTITY IS THE `machineId`, NEVER THE BLE ADDRESS. Android rotates the
 * advertised peripheral address, so the filter cannot be an address allow-list:
 * Helm connects to any Helm-service advertiser, completes a SecureChannel
 * handshake with a STORED PSK, and only then knows who it is talking to. A
 * handshake that does not authenticate, or that names a machine the registry
 * does not hold, is dropped immediately. The advertised address is kept only as
 * a scanning hint (`MobileDevice.deviceId`) so the likeliest PSK is tried first.
 *
 * Since the PSK is bound into the handshake, identification is "try a candidate
 * PSK and see": a failure closes the pipe, so exactly one candidate can be tried
 * per connection. A per-peripheral cursor walks the remaining candidates across
 * reconnects rather than retrying the same one forever. With one or two paired
 * phones that converges immediately.
 *
 * Per invariant 7's spirit, every BLE failure here logs and continues; nothing
 * throws into the session layer.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { SecureChannel } from './secure-channel.js';
import type { BleLink } from './ble/ble-link-client.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { MobilePairing } from './mobile-pairing.js';
import type { MobileDevice } from '../types/mobile-device.js';
import type { SecretStore } from '../mcp/peer/secret-store.js';

/**
 * The slice of a live channel this manager needs. `SecureChannel` satisfies it;
 * declaring it narrowly is what lets the lifecycle be tested without crypto.
 */
export interface MobileChannel {
  readonly peerMachine: string;
  close(reason?: string): void;
  /** Encrypt and send one application message. */
  send?(message: Buffer): void;
  /** `message` carries a decrypted payload; `close` fires once, with a reason. */
  on?(event: 'message' | 'close', handler: (payload: Buffer) => void): unknown;
}

/**
 * The slice of `BleLinkClient` the manager drives. Declared here so the manager
 * never sees noble, and so a fake transport is a first-class implementation
 * rather than a mock.
 */
export interface MobileLinkTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Disconnect a link the manager refused, and go back to scanning. */
  reject(link: BleLink, reason: string): Promise<void>;
  on(event: 'link', handler: (link: BleLink) => void): unknown;
  on(event: 'disconnected', handler: (deviceId: string) => void): unknown;
}

export type OpenMobileChannel = (
  link: BleLink,
  options: { machineId: string; psk: Buffer },
) => Promise<MobileChannel>;

export interface MobileLinkManagerOptions {
  /** Built on first use so the native radio is only loaded when wanted. */
  createTransport: () => MobileLinkTransport;
  deviceStore: MobileDeviceStore;
  secretStore: SecretStore;
  pairing: MobilePairing;
  /** This hub's stable machine id, bound into the handshake transcript. */
  machineId: string;
  now?: () => number;
  openChannel?: OpenMobileChannel;
  logger?: (message: string, error?: unknown) => void;
}

/** One phone Helm currently holds a link to. */
interface ActiveLink {
  machineId: string;
  link: BleLink;
  /** Absent for a link the pairing coordinator owns the channel of. */
  channel: MobileChannel | null;
}

/**
 * Events: `online` (machineId), `offline` (machineId), `message` (machineId, Buffer).
 */
export class MobileLinkManager extends EventEmitter {
  private readonly opts: MobileLinkManagerOptions;
  private readonly now: () => number;
  private readonly openChannel: OpenMobileChannel;

  private transport: MobileLinkTransport | null = null;
  private enabled = false;
  private running = false;
  private readonly links = new Map<string, ActiveLink>();
  /** Which candidate to try next for a given advertised address. */
  private readonly cursor = new Map<string, number>();

  constructor(options: MobileLinkManagerOptions) {
    super();
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.openChannel = options.openChannel ?? ((link, { machineId, psk }) =>
      SecureChannel.open({
        pipe: link.pipe,
        role: 'initiator',
        machineId,
        sessionId: `mobile-${link.deviceId}-${this.now()}`,
        psk,
      }));

    // The radio should run only while there is a phone to reach: any paired
    // device, or an armed pairing (which is how the first one ever arrives).
    this.opts.deviceStore.on('mobile-devices:changed', () => this.ensure());
    this.opts.pairing.on('state', () => this.ensure());
    this.opts.pairing.on('paired', (event: PairedEvent) => this.adoptPaired(event));
    // Revocation must reach the radio, and this is the only object that holds it.
    this.opts.pairing.setDropLink((machineId) => this.dropLink(machineId, 'device revoked'));
  }

  /** Allow the transport to run. Idempotent. */
  async start(): Promise<void> {
    this.enabled = true;
    this.ensure();
  }

  /** Stop the radio and drop every link. Idempotent. */
  async stop(): Promise<void> {
    this.enabled = false;
    this.links.clear();
    this.cursor.clear();
    this.running = false;
    await this.transport?.stop().catch((error) => this.log('stopping the BLE transport failed', error));
  }

  /** Whether this machine currently holds a live link to `machineId`. */
  isOnline(machineId: string): boolean {
    return this.links.has(machineId);
  }

  /**
   * Force-disconnect a device's link. Used by revoke and by disable, both of
   * which must take effect on the radio now rather than at next reconnect.
   */
  dropLink(machineId: string, reason = 'dropped by Helm'): void {
    const active = this.links.get(machineId);
    if (!active) return;
    this.links.delete(machineId);
    this.log(`dropping the link to ${machineId}: ${reason}`);
    try {
      active.channel?.close(reason);
    } catch (error) {
      this.log(`closing the channel for ${machineId} failed`, error);
    }
    void this.transport?.reject(active.link, reason)
      .catch((error) => this.log(`dropping the link for ${machineId} failed`, error));
    this.emit('offline', machineId);
  }

  /** Send an application message to a linked phone. Returns whether it went. */
  send(machineId: string, message: Buffer): boolean {
    const channel = this.links.get(machineId)?.channel;
    if (!channel?.send) return false;
    try {
      channel.send(message);
      return true;
    } catch (error) {
      this.log(`sending to ${machineId} failed`, error);
      return false;
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start or stop the radio to match "is there anything to connect to". */
  private ensure(): void {
    const wanted = this.enabled && (this.opts.deviceStore.list().length > 0 || this.pairingArmed());
    if (wanted === this.running) return;
    this.running = wanted;

    if (!wanted) {
      void this.transport?.stop().catch((error) => this.log('stopping the BLE transport failed', error));
      return;
    }

    const transport = this.ensureTransport();
    if (!transport) {
      this.running = false;
      return;
    }
    void transport.start().catch((error) => this.log('starting the BLE transport failed', error));
  }

  private pairingArmed(): boolean {
    const status = this.opts.pairing.getState().status;
    return status === 'scanning' || status === 'awaiting-sas';
  }

  /**
   * Build the transport once, on demand. A machine with no usable Bluetooth
   * stack must degrade to "mobile does not work", never to a failed startup.
   */
  private ensureTransport(): MobileLinkTransport | null {
    if (this.transport) return this.transport;
    try {
      const transport = this.opts.createTransport();
      transport.on('link', (link: BleLink) => void this.onLink(link));
      transport.on('disconnected', (deviceId: string) => this.onDisconnected(deviceId));
      this.transport = transport;
      return transport;
    } catch (error) {
      this.log('the BLE transport is unavailable', error);
      return null;
    }
  }

  // ------------------------------------------------------------- identification

  private async onLink(link: BleLink): Promise<void> {
    // Pairing first: while it is armed the coordinator owns the handshake, and a
    // second one on the same pipe would fight it for the bytes.
    if (this.pairingArmed() && await this.opts.pairing.offerLink(link)) return;

    const device = this.nextCandidate(link);
    if (!device) {
      await this.refuse(link, 'no paired device matches this advertiser');
      return;
    }

    // A freshly decoded copy each call, handed to the channel for the lifetime
    // of the handshake — so it is not zeroed here, which would corrupt it.
    let psk: Buffer | undefined;
    try {
      psk = this.opts.secretStore.get(device.pskRef);
    } catch (error) {
      this.log(`reading the PSK for ${device.machineId} failed`, error);
    }
    if (!psk) {
      await this.refuse(link, 'no stored PSK for the candidate device');
      return;
    }

    let channel: MobileChannel;
    try {
      channel = await this.openChannel(link, { machineId: this.opts.machineId, psk });
    } catch (error) {
      // The expected outcome for a stranger, or for the wrong candidate PSK.
      this.log(`identification of ${link.deviceId} failed`, error);
      await this.refuse(link, 'handshake did not authenticate');
      return;
    }

    this.register(link, channel);
  }

  /** Accept an authenticated channel, or drop it if trust has since moved. */
  private register(link: BleLink, channel: MobileChannel): void {
    const machineId = channel.peerMachine;
    const device = this.opts.deviceStore.getByMachineId(machineId);
    if (!device || device.enabled === false) {
      channel.close('device is not trusted');
      void this.refuse(link, 'authenticated machine is not a trusted device');
      return;
    }
    if (this.links.has(machineId)) {
      channel.close('already linked');
      void this.refuse(link, 'a link to this device already exists');
      return;
    }

    this.links.set(machineId, { machineId, link, channel });
    this.cursor.delete(link.deviceId);
    // The address is a hint, so it is UPDATED on the existing record — keying a
    // new entry off a rotated address is exactly the regression this prevents.
    this.opts.deviceStore.update(device.id, { deviceId: link.deviceId, lastSeenAt: this.now() });
    this.attachChannel(machineId, channel);
    link.onTransportError?.((failure) => {
      this.dropLink(machineId, `BLE write failed after ${failure.elapsedMs}ms`);
    });
    link.pipe.onClose(() => this.onClosed(machineId, 'the BLE pipe closed'));
    this.log(`linked "${device.name}" (${machineId}) via ${link.deviceId}`);
    this.emit('online', machineId);
  }

  /** Adopt the link the pairing coordinator just turned into a trusted phone. */
  private adoptPaired(event: PairedEvent): void {
    const link = event.link;
    if (!link || this.links.has(event.machineId)) return;

    this.links.set(event.machineId, {
      machineId: event.machineId,
      link,
      channel: event.channel ?? null,
    });
    if (event.channel) this.attachChannel(event.machineId, event.channel);
    link.onTransportError?.((failure) => {
      this.dropLink(event.machineId, `BLE write failed after ${failure.elapsedMs}ms`);
    });
    link.pipe.onClose(() => this.onClosed(event.machineId, 'the BLE pipe closed'));
    this.emit('online', event.machineId);
  }

  /**
   * Choose which paired phone this advertiser might be. The record whose
   * last-seen address matches is tried first; after that the cursor walks the
   * rest across reconnects so a rotated address still finds its device.
   */
  private nextCandidate(link: BleLink): MobileDevice | undefined {
    const candidates = this.opts.deviceStore
      .list()
      .filter((device) => device.enabled !== false && !this.links.has(device.machineId))
      .sort((a, b) => rank(b, link.deviceId) - rank(a, link.deviceId));
    if (candidates.length === 0) return undefined;

    const index = (this.cursor.get(link.deviceId) ?? 0) % candidates.length;
    this.cursor.set(link.deviceId, index + 1);
    return candidates[index];
  }

  private attachChannel(machineId: string, channel: MobileChannel): void {
    channel.on?.('message', (message: Buffer) => this.emit('message', machineId, message));
    channel.on?.('close', () => this.onClosed(machineId, 'the secure channel closed'));
  }

  /** Disconnect a link we will not keep, and let the transport rescan. */
  private async refuse(link: BleLink, reason: string): Promise<void> {
    // The reason used to go to the transport and nowhere else, so a hub that
    // refused every advertiser in range looked identical to one that saw none.
    this.log(`refusing ${link.deviceId}: ${reason}`);
    try {
      await this.transport?.reject(link, reason);
    } catch (error) {
      this.log(`refusing ${link.deviceId} failed`, error);
    }
  }

  private onDisconnected(deviceId: string): void {
    for (const active of this.links.values()) {
      if (active.link.deviceId === deviceId) this.onClosed(active.machineId, 'the transport reported a disconnect');
    }
  }

  /**
   * Every BLE failure ends here and goes no further: the cause is folded into
   * the message so a caller-supplied sink sees it too.
   */
  private log(message: string, error?: unknown): void {
    const full = error === undefined ? message : `${message}: ${describe(error)}`;
    if (this.opts.logger) this.opts.logger(full, error);
    else if (error === undefined) logger.info(`[MobileLink] ${full}`);
    else logger.warn(`[MobileLink] ${full}`);
  }

  /**
   * A link ended. The REASON is required, because the three call sites mean
   * genuinely different things — the radio went, the crypto went, or the OS
   * told us — and a bare "closed" made a 13-to-40-second reconnect loop
   * undiagnosable from the desktop end. See P-0756.
   */
  private onClosed(machineId: string, reason: string): void {
    if (!this.links.delete(machineId)) return;
    this.log(`link to ${machineId} closed: ${reason}`);
    this.emit('offline', machineId);
  }
}

/** What MobilePairing reports when a phone completes the SAS flow. */
interface PairedEvent {
  id: string;
  machineId: string;
  link?: BleLink;
  channel?: MobileChannel;
}

/** Sort key: the record whose last-seen address matches is the likeliest. */
function rank(device: MobileDevice, deviceId: string): number {
  if (device.deviceId === deviceId) return 2;
  return device.lastSeenAt ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
