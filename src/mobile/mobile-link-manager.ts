/**
 * MobileLinkManager — the one owner of the phone transports' lifecycle.
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
 * per connection. A cursor walks the remaining candidates across reconnects
 * rather than retrying the same one forever. That cursor must NOT be keyed on
 * the advertised address — rotation would reset it on every attempt and the
 * same candidate would be tried forever. See nextCandidate.
 *
 * ONE LINK PER PHONE, ACROSS ALL TRANSPORTS. The manager owns N transports and
 * knows them only by rank, so two pipes to one phone are not two links — they
 * are an incumbent and a challenger, and the higher rank takes the slot (LAN
 * displaces BLE; see RANK_BLE). A swap keeps the machineId, so nothing above
 * here can observe which pipe the bytes take. The cost of that is that every
 * teardown handler outlives its link, which is what `generation` exists for.
 *
 * Per invariant 7's spirit, every transport failure here logs and continues;
 * nothing throws into the session layer.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { SecureChannel } from './secure-channel.js';
import { RANK_BLE, type MobileLink } from './mobile-link.js';

// Re-exported so callers have ONE import site for the link vocabulary.
export { RANK_BLE, RANK_LAN } from './mobile-link.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { MobilePairing } from './mobile-pairing.js';
import type { MobileDevice } from '../types/mobile-device.js';
import type { SecretStore } from '../mcp/peer/secret-store.js';

/**
 * How long the initiator waits for the peer's handshake answer.
 *
 * The HELLO write is already bounded in the transport, but a phone that accepts
 * the connection and then goes silent — the app frozen before it could reply,
 * while the radio keeps the link alive — settles the write and never answers.
 * Without a deadline here the transport's one active-link slot is held forever:
 * no error, no disconnect, no rescan.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How long a registered link may hear nothing from the phone before the manager
 * probes it with a PING.
 *
 * noble can lose a phone without ever emitting 'disconnect' — the observed
 * wedged-radio-stack case — and a quiet link would then look online forever,
 * until a send burned its 10s write deadline. The probe forces traffic: the
 * peer answers PONG, which is inbound, which resets the clock.
 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Silent probe intervals that make a link dead. Two intervals of silence means
 * one probe went out and came back with nothing — not merely a link between
 * messages, which is what a healthy idle phone looks like.
 */
const DEFAULT_KEEPALIVE_MISS_LIMIT = 2;


/**
 * How long a displaced link stays open after its replacement takes the slot.
 *
 * Envelope ids are chosen by the phone and Helm never initiates a request
 * expecting a reply, so a request in flight at swap time would simply lose its
 * answer down the closing pipe. The grace lets a queued reply finish going out;
 * the phone retries anything still missing. No protocol change buys more.
 */
const DEFAULT_RETIRE_GRACE_MS = 500;

/**
 * The slice of a live channel this manager needs. `SecureChannel` satisfies it;
 * declaring it narrowly is what lets the lifecycle be tested without crypto.
 */
export interface MobileChannel {
  readonly peerMachine: string;
  close(reason?: string): void;
  /** Encrypt and send one application message. */
  send?(message: Buffer): void;
  /** Send the keepalive probe; the peer answers with inbound traffic. */
  sendPing?(): void;
  /** `message` carries a decrypted payload; `close` fires once, with a reason. */
  on?(event: 'message' | 'close', handler: (payload: Buffer) => void): unknown;
  /** Inbound control traffic — any of it resets the keepalive probe clock. */
  on?(event: 'pong' | 'ping', handler: () => void): unknown;
}

/**
 * The slice of a transport the manager drives. Declared here so the manager
 * never sees noble, and so a fake transport is a first-class implementation
 * rather than a mock.
 */
export interface MobileLinkTransport {
  /** Higher displaces lower for the same phone. See RANK_BLE / RANK_LAN. */
  readonly rank: number;
  /**
   * Whether this transport's address is worth remembering as a reconnect hint.
   *
   * A BLE peripheral id is: it tells the candidate ranking which stored PSK to
   * try first. A TCP source port is not — it is ephemeral, and persisting it
   * would EVICT the BLE hint from the single `MobileDevice.deviceId` field, so
   * one LAN connection would degrade every later BLE reconnect.
   *
   * The manager asks the transport rather than testing its rank, so this stays
   * a property of the transport and not a BLE branch in the manager.
   */
  readonly persistsAddressHint?: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Disconnect a link the manager refused, and go back to scanning. */
  reject(link: MobileLink, reason: string): Promise<void>;
  on(event: 'link', handler: (link: MobileLink) => void): unknown;
  on(event: 'disconnected', handler: (deviceId: string) => void): unknown;
}

export type OpenMobileChannel = (
  link: MobileLink,
  options: { machineId: string; psk: Buffer },
) => Promise<MobileChannel>;

export interface MobileLinkManagerOptions {
  /**
   * Built on first use so the native radio is only loaded when wanted. Returns
   * EVERY transport this machine can reach a phone over; the manager owns them
   * all and knows them only by rank.
   */
  createTransports: () => MobileLinkTransport[];
  deviceStore: MobileDeviceStore;
  secretStore: SecretStore;
  pairing: MobilePairing;
  /** This hub's stable machine id, bound into the handshake transcript. */
  machineId: string;
  /** Ceiling on waiting for the peer's handshake answer; see DEFAULT_HANDSHAKE_TIMEOUT_MS. */
  handshakeTimeoutMs?: number;
  /** Silence before an idle link is probed; see DEFAULT_KEEPALIVE_INTERVAL_MS. */
  keepaliveIntervalMs?: number;
  /** Silent probe intervals that make a link dead; see DEFAULT_KEEPALIVE_MISS_LIMIT. */
  keepaliveMissLimit?: number;
  /** Drain window for a displaced link; see DEFAULT_RETIRE_GRACE_MS. */
  retireGraceMs?: number;
  now?: () => number;
  openChannel?: OpenMobileChannel;
  logger?: (message: string, error?: unknown) => void;
}

/** One phone Helm currently holds a link to. */
interface ActiveLink {
  machineId: string;
  link: MobileLink;
  /** Absent for a link the pairing coordinator owns the channel of. */
  channel: MobileChannel | null;
  /** Epoch ms of the last inbound byte — the keepalive probe's reference. */
  lastInboundAt: number;
  /** The transport that produced this link — where a refusal must be routed. */
  transport: MobileLinkTransport | null;
  /** Its transport's rank, kept here so preemption never re-derives it. */
  rank: number;
  /**
   * Process-unique id for THIS occupancy of the machineId slot.
   *
   * Every teardown handler is keyed on machineId, and a displaced link tears
   * down after its replacement has taken the slot. Without an identity to
   * compare, that late teardown deletes the successor. See P-0752 footgun 1.
   */
  generation: number;
}

/**
 * Events: `online` (machineId), `offline` (machineId), `message` (machineId,
 * Buffer), `switched` (machineId, fromRank, toRank).
 *
 * `switched` is DIAGNOSTIC ONLY. A swap deliberately raises no offline/online
 * pair: the machineId has not changed, so nothing above this manager — the chat
 * bridge, the gate, the settings UI — has any business noticing which pipe the
 * bytes take.
 */
export class MobileLinkManager extends EventEmitter {
  private readonly opts: MobileLinkManagerOptions;
  private readonly now: () => number;
  private readonly openChannel: OpenMobileChannel;
  private readonly handshakeTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveMissLimit: number;
  private readonly retireGraceMs: number;

  private transports: MobileLinkTransport[] | null = null;
  private enabled = false;
  private running = false;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Handshakes currently running — keepalive probing pauses while any is. */
  private handshakesInFlight = 0;
  private readonly links = new Map<string, ActiveLink>();
  /**
   * How many identification attempts have been made since the last success.
   *
   * Deliberately NOT per-address: see nextCandidate. This is the offset into the
   * candidate list, so every paired device is tried in turn however often the
   * peer's advertised address changes.
   */
  private attempt = 0;
  /** Increments on every slot occupancy; see ActiveLink.generation. */
  private generation = 0;
  /**
   * Which transport handed us a given link. A refusal must go back to the
   * transport that produced the link — with two of them, "the" transport is no
   * longer a meaningful thing to reject on.
   */
  private readonly origin = new WeakMap<MobileLink, MobileLinkTransport>();
  /** Displaced links still inside their drain window. */
  private readonly retiring = new Map<ReturnType<typeof setTimeout>, ActiveLink>();

  constructor(options: MobileLinkManagerOptions) {
    super();
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.keepaliveMissLimit = Math.max(1, options.keepaliveMissLimit ?? DEFAULT_KEEPALIVE_MISS_LIMIT);
    this.retireGraceMs = options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS;
    this.openChannel = options.openChannel ?? ((link, { machineId, psk }) =>
      SecureChannel.open({
        pipe: link.pipe,
        role: 'initiator',
        machineId,
        sessionId: `mobile-${link.deviceId}-${this.now()}`,
        psk,
        log: (message) => this.log(message),
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
    this.scheduleKeepalive();
    this.ensure();
  }

  /**
   * Stop the radio and drop every link. Idempotent.
   *
   * Every online device is announced offline and its channel closed BEFORE the
   * map is dropped: a bare `clear()` left consumers holding stale online state,
   * because `onClosed` early-returns once `links.delete` misses — the exact
   * symptom this used to ship with.
   */
  async stop(): Promise<void> {
    this.enabled = false;
    this.clearKeepalive();
    this.flushRetiring('Helm stopped');
    for (const active of [...this.links.values()]) {
      this.links.delete(active.machineId);
      try {
        active.channel?.close('Helm stopped');
      } catch (error) {
        this.log(`closing the channel for ${active.machineId} failed`, error);
      }
      this.emit('offline', active.machineId);
    }
    this.attempt = 0;
    this.running = false;
    await this.stopTransports();
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
    if (active) this.dropGeneration(machineId, active.generation, reason);
  }

  /**
   * Drop a link only if it is STILL the one holding the slot.
   *
   * Every teardown handler a link installs outlives that link, so a displaced
   * link's late failure would otherwise drop the link that replaced it. The
   * generation is the only thing that can tell the two apart.
   */
  private dropGeneration(machineId: string, generation: number, reason: string): void {
    const active = this.links.get(machineId);
    if (!active || active.generation !== generation) return;
    this.links.delete(machineId);
    this.log(`dropping the link to ${machineId}: ${reason}`);
    this.teardown(active, reason);
    this.emit('offline', machineId);
  }

  /** Close a link's channel and hand the link back to its own transport. */
  private teardown(active: ActiveLink, reason: string): void {
    try {
      active.channel?.close(reason);
    } catch (error) {
      this.log(`closing the channel for ${active.machineId} failed`, error);
    }
    void active.transport?.reject(active.link, reason)
      .catch((error) => this.log(`dropping the link for ${active.machineId} failed`, error));
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
      void this.stopTransports();
      return;
    }

    const transports = this.ensureTransports();
    if (transports.length === 0) {
      this.running = false;
      return;
    }
    for (const transport of transports) {
      void transport.start().catch((error) => this.log('starting a mobile transport failed', error));
    }
  }

  private async stopTransports(): Promise<void> {
    for (const transport of this.transports ?? []) {
      await transport.stop().catch((error) => this.log('stopping a mobile transport failed', error));
    }
  }

  private pairingArmed(): boolean {
    const status = this.opts.pairing.getState().status;
    return status === 'scanning' || status === 'awaiting-sas';
  }

  // ----------------------------------------------------------------- keepalive

  /**
   * One self-rescheduling clock for every link. A link that has been silent for
   * an interval is probed with a PING; one silent for the miss limit is dead —
   * noble never told us, so the drop → offline → reject → rescan chain is the
   * only recovery path that exists.
   *
   * One exemption: a link whose outbound queue is still working a transfer is
   * never silence-dropped or probed. See keepaliveTick.
   */
  private scheduleKeepalive(): void {
    if (!this.enabled || this.keepaliveTimer) return;
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      try {
        this.keepaliveTick();
      } finally {
        this.scheduleKeepalive();
      }
    }, this.keepaliveIntervalMs);
  }

  private clearKeepalive(): void {
    if (!this.keepaliveTimer) return;
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private keepaliveTick(): void {
    // A handshake in flight means a phone is mid-identification on a second
    // link; probing registered links can wait a beat rather than race it.
    if (this.handshakesInFlight > 0) return;
    for (const active of [...this.links.values()]) {
      if (!active.channel) continue;
      const silentFor = this.now() - active.lastInboundAt;
      // A bulk write still working through the outbound queue IS evidence of a
      // live peer path: the phone is accepting chunks, and the inbound traffic
      // that would reset this clock — the reply itself — cannot arrive until
      // the transfer finishes. Without this exemption every long transfer died:
      // a ~55KB session_list reply at 20-byte chunks outpaced the silence
      // budget, the PING queued behind it never reached the air, and the link
      // was dropped mid-transfer, reconnecting and repeating forever.
      //
      // This cannot hold a dead link forever, bounded by construction: each
      // queued chunk carries the transport's own write deadline, and the error
      // it raises drops the link through onTransportError; a queue that keeps
      // draining slowly empties, and the silence rule below resumes. Probing is
      // paused too — a PING would queue behind the transfer and arrive after it.
      if (active.link.hasPendingWrites?.()) continue;
      if (silentFor >= this.keepaliveIntervalMs * this.keepaliveMissLimit) {
        this.dropLink(active.machineId, `keepalive: no inbound traffic for ${silentFor}ms`);
        continue;
      }
      if (silentFor < this.keepaliveIntervalMs) continue;
      try {
        active.channel.sendPing?.();
      } catch (error) {
        this.log(`keepalive probe to ${active.machineId} failed`, error);
      }
    }
  }

  /** ANY inbound byte — pong, ping, or application message — resets the probe. */
  private markInbound(machineId: string): void {
    const active = this.links.get(machineId);
    if (active) active.lastInboundAt = this.now();
  }

  /**
   * Build the transports once, on demand. A machine with no usable Bluetooth
   * stack must degrade to "mobile does not work", never to a failed startup.
   */
  private ensureTransports(): MobileLinkTransport[] {
    if (this.transports) return this.transports;
    try {
      const transports = this.opts.createTransports();
      for (const transport of transports) {
        transport.on('link', (link: MobileLink) => {
          this.origin.set(link, transport);
          void this.onLink(link);
        });
        transport.on('disconnected', (deviceId: string) => this.onDisconnected(deviceId, transport));
      }
      this.transports = transports;
      return transports;
    } catch (error) {
      // Deliberately not cached: a radio that was missing at startup may be
      // present by the next time there is a phone worth reaching.
      this.log('the BLE transport is unavailable', error);
      return [];
    }
  }

  // ------------------------------------------------------------- identification

  private async onLink(link: MobileLink): Promise<void> {
    // Both handshake paths below count as in flight until they settle, so the
    // keepalive clock stays out of the way while a link is being decided.
    this.handshakesInFlight += 1;
    try {
      await this.identify(link);
    } finally {
      this.handshakesInFlight -= 1;
    }
  }

  private async identify(link: MobileLink): Promise<void> {
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
      channel = await this.boundedHandshake(
        this.openChannel(link, { machineId: this.opts.machineId, psk }),
      );
    } catch (error) {
      // The expected outcome for a stranger, or for the wrong candidate PSK.
      this.log(`identification of ${link.deviceId} failed`, error);
      await this.refuse(link, 'handshake did not authenticate');
      return;
    }

    this.register(link, channel);
  }

  /**
   * Race the handshake answer against the clock. Same shape as the transport's
   * own bounds, and for the same reason: the loser of the race is left running,
   * because a pipe cannot be asked to cancel its read — its eventual failure
   * goes nowhere once we have stopped caring.
   */
  private boundedHandshake(run: Promise<MobileChannel>): Promise<MobileChannel> {
    return new Promise<MobileChannel>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`handshake timed out after ${this.handshakeTimeoutMs}ms`)),
        this.handshakeTimeoutMs,
      );
      run.then(
        (channel) => {
          clearTimeout(timer);
          resolve(channel);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Accept an authenticated channel, or drop it if trust has since moved.
   *
   * ORDER IS THE SAFETY RULE. This runs only once the challenger has completed
   * a PSK-bound handshake, so an incumbent is never disturbed on the strength of
   * a connection that might not authenticate. A failed LAN handshake costs a
   * working BLE link nothing.
   */
  private register(link: MobileLink, channel: MobileChannel): void {
    const machineId = channel.peerMachine;
    const device = this.opts.deviceStore.getByMachineId(machineId);
    if (!device || device.enabled === false) {
      channel.close('device is not trusted');
      void this.refuse(link, 'authenticated machine is not a trusted device');
      return;
    }

    const rank = this.rankOf(link);
    const incumbent = this.links.get(machineId);
    if (incumbent && rank <= incumbent.rank) {
      channel.close('already linked');
      void this.refuse(link, 'a link to this device already exists');
      return;
    }

    this.occupy({ machineId, link, channel, rank, lastInboundAt: this.now() });
    // A success means the ordering was right; start the next walk from the top.
    this.attempt = 0;
    // The address is a hint, so it is UPDATED on the existing record — keying a
    // new entry off a rotated address is exactly the regression this prevents.
    // Only a transport whose address survives a reconnect may write it; see
    // MobileLinkTransport.persistsAddressHint.
    this.opts.deviceStore.update(device.id, {
      ...(this.origin.get(link)?.persistsAddressHint === false ? {} : { deviceId: link.deviceId }),
      lastSeenAt: this.now(),
    });

    if (incumbent) {
      this.log(`"${device.name}" (${machineId}) moved from rank ${incumbent.rank} to ${rank}`);
      this.retire(incumbent, `displaced by a rank ${rank} link`);
      // No online/offline pair: the machineId never went away. See the class
      // comment — a swap must be invisible to everything above this manager.
      this.emit('switched', machineId, incumbent.rank, rank);
      return;
    }
    this.log(`linked "${device.name}" (${machineId}) via ${link.deviceId}`);
    this.emit('online', machineId);
  }

  /**
   * Take the machineId slot, wiring this link's teardown handlers to its own
   * generation so they can never act on whatever occupies the slot later.
   */
  private occupy(entry: Omit<ActiveLink, 'generation' | 'transport'>): void {
    this.generation += 1;
    const generation = this.generation;
    const { machineId, link, channel } = entry;
    this.links.set(machineId, {
      ...entry,
      generation,
      transport: this.origin.get(link) ?? null,
    });
    if (channel) this.attachChannel(machineId, generation, channel);
    link.onTransportError?.((failure) => {
      this.dropGeneration(machineId, generation, `BLE write failed after ${failure.elapsedMs}ms`);
    });
    link.pipe.onClose(() => this.onClosed(machineId, generation, 'the BLE pipe closed'));
  }

  /**
   * Let a displaced link drain, then close it. See DEFAULT_RETIRE_GRACE_MS.
   *
   * It has already lost the slot, so its eventual close is a no-op against the
   * generation guard — this is purely about not severing a reply mid-flight.
   */
  private retire(active: ActiveLink, reason: string): void {
    const timer = setTimeout(() => {
      this.retiring.delete(timer);
      this.teardown(active, reason);
    }, this.retireGraceMs);
    // A drain window must not keep an exiting process alive.
    timer.unref?.();
    this.retiring.set(timer, active);
  }

  /** Close every draining link now — stop cannot wait out a grace window. */
  private flushRetiring(reason: string): void {
    for (const [timer, active] of this.retiring) {
      clearTimeout(timer);
      this.teardown(active, reason);
    }
    this.retiring.clear();
  }

  private rankOf(link: MobileLink): number {
    return this.origin.get(link)?.rank ?? RANK_BLE;
  }

  /**
   * How likely this device is to be the peer on the other end of `link`.
   *
   * A device ALREADY LINKED over a slower transport outranks everything else,
   * because that is precisely what an upgrade looks like: the phone on BLE has
   * just dialled in over LAN. Without this the walk picks by general
   * likelihood, and with two phones paired it reliably offered the WRONG PSK to
   * an upgrading link — the LAN handshake then failed with a confirm-MAC error
   * on the one connection the phone makes per link, so LAN never came up at
   * all. Observed on real hardware.
   */
  private candidateRank(device: MobileDevice, link: MobileLink, incoming: number): number {
    const active = this.links.get(device.machineId);
    if (active && active.rank < incoming) return 3;
    return rank(device, link.deviceId);
  }

  private linkedAtOrAbove(machineId: string, rank: number): boolean {
    const active = this.links.get(machineId);
    return active !== undefined && active.rank >= rank;
  }

  /**
   * Adopt the link the pairing coordinator just turned into a trusted phone.
   *
   * Pairing is BLE-only by design (P-0752: proximity is the trust anchor), so
   * this never preempts — a freshly paired phone cannot already be linked.
   */
  private adoptPaired(event: PairedEvent): void {
    const link = event.link;
    if (!link || this.links.has(event.machineId)) return;

    this.occupy({
      machineId: event.machineId,
      link,
      channel: event.channel ?? null,
      rank: this.rankOf(link),
      lastInboundAt: this.now(),
    });
    this.emit('online', event.machineId);
  }

  /**
   * Choose which paired phone this advertiser might be.
   *
   * Identification is "try a candidate PSK and see", because a failure closes
   * the pipe and only one can be tried per connection. So the walk has to
   * advance across RECONNECTS, and this is where that used to be wrong: the
   * cursor was keyed on the advertised address. Android rotates that address on
   * every connection, so the key was new every time, the index was always 0,
   * and the same first candidate was tried forever.
   *
   * The consequence was not slowness. With two phones paired, whichever sorted
   * second could NEVER be identified — observed on real hardware as an endless
   * six-second loop of "Peer confirmation MAC failed". A rotating address is the
   * normal case, so the walk must not be keyed on anything that rotates.
   */
  private nextCandidate(link: MobileLink): MobileDevice | undefined {
    // A device already linked at this rank or better is not a candidate — but
    // one linked over a SLOWER transport is, or a LAN link could never identify
    // itself as the phone already on BLE and preemption would be unreachable.
    const incoming = this.rankOf(link);
    const candidates = this.opts.deviceStore
      .list()
      .filter((device) => device.enabled !== false && !this.linkedAtOrAbove(device.machineId, incoming))
      .sort((a, b) => this.candidateRank(b, link, incoming) - this.candidateRank(a, link, incoming));
    if (candidates.length === 0) return undefined;

    const index = this.attempt % candidates.length;
    this.attempt += 1;
    return candidates[index];
  }

  private attachChannel(machineId: string, generation: number, channel: MobileChannel): void {
    // Inbound on a RETIRED channel is still genuinely the phone, so a late
    // application message is delivered — but none of it may reset a keepalive
    // clock the retired link no longer owns, or a dead replacement would look
    // alive for as long as the old pipe kept chattering.
    const stillOurs = () => this.isCurrent(machineId, generation);
    channel.on?.('message', (message: Buffer) => {
      if (stillOurs()) this.markInbound(machineId);
      this.emit('message', machineId, message);
    });
    channel.on?.('pong', () => { if (stillOurs()) this.markInbound(machineId); });
    channel.on?.('ping', () => { if (stillOurs()) this.markInbound(machineId); });
    channel.on?.('close', () => this.onClosed(machineId, generation, 'the secure channel closed'));
  }

  private isCurrent(machineId: string, generation: number): boolean {
    return this.links.get(machineId)?.generation === generation;
  }

  /** Disconnect a link we will not keep, and let its transport rescan. */
  private async refuse(link: MobileLink, reason: string): Promise<void> {
    // The reason used to go to the transport and nowhere else, so a hub that
    // refused every advertiser in range looked identical to one that saw none.
    this.log(`refusing ${link.deviceId}: ${reason}`);
    try {
      await this.origin.get(link)?.reject(link, reason);
    } catch (error) {
      this.log(`refusing ${link.deviceId} failed`, error);
    }
  }

  /**
   * A transport lost a link. Matched on the transport AND the address, because
   * a BLE peripheral id and a socket address are different id spaces that must
   * never be compared — and a retired link is already out of `links`, so its
   * late disconnect finds nothing to drop.
   */
  private onDisconnected(deviceId: string, transport: MobileLinkTransport): void {
    for (const active of [...this.links.values()]) {
      if (active.transport !== transport || active.link.deviceId !== deviceId) continue;
      this.onClosed(active.machineId, active.generation, 'the transport reported a disconnect');
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
  private onClosed(machineId: string, generation: number, reason: string): void {
    // The generation check is what makes a swap safe: a displaced link's pipe,
    // channel and transport all report their close AFTER the replacement has
    // taken the slot, and a bare delete-by-machineId would take the successor
    // down with them. See P-0752 footgun 1.
    if (!this.isCurrent(machineId, generation)) return;
    this.links.delete(machineId);
    this.log(`link to ${machineId} closed: ${reason}`);
    this.emit('offline', machineId);
  }
}

/** What MobilePairing reports when a phone completes the SAS flow. */
interface PairedEvent {
  id: string;
  machineId: string;
  link?: MobileLink;
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
