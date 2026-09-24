/**
 * ble-link-client — Helm's BLE central. The only file that talks to noble.
 *
 * ROLE FLIP (ratified 2026-09-11, context af250949): the Android app advertises
 * and serves GATT; Helm scans, connects, discovers, subscribes to TX and writes
 * to RX. `@stoprocent/bleno` cannot serve GATT on Windows without a WinUSB
 * driver swap, so the peripheral role is not available to us.
 *
 * What escapes this directory is a `MobileLink`: a device identity plus a
 * `BytePipe`, the interface `secure-channel.ts` already consumes. No noble or
 * GATT type crosses that line, which is what lets SecureChannel stay entirely
 * transport-agnostic and hardware-free to test.
 *
 * Per invariant 7's spirit, BLE errors are logged and emitted, never thrown into
 * the session layer: a radio that misbehaves must not take a session with it.
 */

import { EventEmitter } from 'node:events';
import type { BytePipe } from '../secure-channel';
import { RANK_BLE, type MobileLink, type LinkTransportError } from '../mobile-link';
import {
  BleChunker,
  BleReassembler,
  MAX_ATTRIBUTE_VALUE_BYTES,
  MIN_CHUNK_BYTES,
} from './ble-framing';
import {
  HELM_RX_UUID_SHORT,
  HELM_SERVICE_UUID_SHORT,
  HELM_TX_UUID_SHORT,
  normaliseUuid,
} from './characteristics';

/** ATT protocol overhead on a notification or write: opcode + handle. */
const ATT_OVERHEAD_BYTES = 3;

/**
 * Application frames can contain hundreds of ATT chunks. Waiting for an
 * Android GATT-server response for every chunk makes Windows/noble stall on a
 * long session_list reply even though the phone has already accepted the
 * writes. The queue still serialises chunks; disabling the per-chunk response
 * avoids the native response backlog while preserving ordering.
 */
const DEFAULT_WRITE_WITHOUT_RESPONSE = false;

/** Fallback when the adapter does not report a negotiated MTU. */
const DEFAULT_ATT_MTU = 23;

/**
 * The smallest MTU report worth trusting. Anything below is an old radio or a
 * stack that never negotiated; the 20-byte fallback is safer than chasing it.
 */
const MIN_NEGOTIATED_ATT_MTU = 23;

/**
 * Ceiling on the negotiated MTU we will act on. The report Windows emits is the
 * GATT session's MaxPduSize — MTU minus the 3-byte ATT header — and the phone
 * negotiates a 517-byte MTU, so the genuine report is 514, exactly what the
 * phone chunks its notifications at. Any chunk at or below our own negotiated
 * payload is safe to send, so the cap sits at the 517 MTU itself. (The old 247
 * ceiling silently discarded that genuine report and pinned every real transfer
 * to 20-byte chunks, which is what starved the keepalive into dropping the link
 * mid-transfer.)
 *
 * chunkSize still subtracts ATT_OVERHEAD_BYTES from the report, so a 514 report
 * yields 511-byte chunks — 3 bytes under what the phone actually accepts. That
 * double-subtraction is harmless (we can only under-shoot the peer's window)
 * and is left alone deliberately.
 */
const MAX_NEGOTIATED_ATT_MTU = 517;

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/**
 * How long any one step of the connect sequence may take before Helm gives up
 * on it.
 *
 * None of the three steps had a bound, and on real hardware `discover` simply
 * never returned: Helm sat for ~33 seconds, died on noble's bare "Disconnected
 * unknown", and could not say which await had been stuck. The ceiling sits well
 * under the ~30s the phone was observed holding a silent connection, so Helm
 * now gives up first and gets to describe what happened.
 *
 * Five seconds, not ten: every healthy step on real hardware completes in well
 * under two, and while a connect is in flight the scan is paused — so a long
 * ceiling directly delays every OTHER phone's discovery too.
 */
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
/** Windows can report the first uncached GATT query as unreachable while the
 * connection is still settling. A bounded retry lets the stack converge. */
const DISCOVERY_ATTEMPTS = 2;

/**
 * How long a refused advertiser is skipped. Identity is only known after a
 * handshake, so the layer above has to connect before it can say no — without
 * this window a neighbour's phone would be reconnected on every rescan forever.
 */
const DEFAULT_REJECT_IGNORE_MS = 60_000;

/**
 * How long one ATT chunk write — and one disconnect request — may stay
 * unsettled before the link is treated as dead.
 *
 * The observed reinstall failure: the phone's GATT server vanished mid-write
 * and the Windows stack held the write promise FOREVER. No error, no
 * disconnect event, no rescan — Helm sat with a live-looking link and a write
 * queue stuck on its first chunk until the app was restarted by hand. A
 * 20-byte acknowledged write completes in tens of milliseconds; anything still
 * pending after ten seconds is a wedged stack, not a slow phone.
 */
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * The narrow slice of @stoprocent/noble this client uses. Declared here
 * rather than imported so the module stays testable against a fake and
 * so noble's types never leak past this file.
 * ------------------------------------------------------------------ */

export interface NobleCharacteristic {
  readonly uuid: string;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  subscribeAsync(): Promise<void>;
  on(event: 'data', handler: (data: Buffer) => void): unknown;
}

export interface NoblePeripheral {
  readonly id: string;
  readonly mtu?: number;
  readonly advertisement: { localName?: string };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    serviceUuids: string[],
    characteristicUuids: string[],
  ): Promise<{ characteristics: NobleCharacteristic[] }>;
  once(event: 'disconnect', handler: () => void): unknown;
  /**
   * The negotiated-MTU report. On Windows/noble this is the GATT session's
   * MaxPduSize, emitted shortly after connect and again if it changes; it is
   * the only MTU source trusted here (see BleLinkPipe.chunkSize).
   */
  on(event: 'mtu', handler: (mtu: number) => void): unknown;
  /** Detach the report listener again when an attempt or a link ends. */
  off(event: 'mtu', handler: (mtu: number) => void): unknown;
  /** Detach a disconnect listener for a link closed by other means. */
  off(event: 'disconnect', handler: () => void): unknown;
}

export interface NobleApi {
  readonly state: string;
  startScanningAsync(serviceUuids: string[], allowDuplicates: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
  on(event: 'stateChange', handler: (state: string) => void): unknown;
  on(event: 'discover', handler: (peripheral: NoblePeripheral) => void): unknown;
  /** Fires on every scan end — ours, and the ones the OS decides on its own. */
  on(event: 'scanStop', handler: () => void): unknown;
  /** Removes a handler added with on(); stop() must not leave any behind. */
  off(event: 'stateChange' | 'discover' | 'scanStop', handler: (...args: never[]) => void): unknown;
}

/* ------------------------------------------------------------------ */

/** What the rest of Helm sees: an identified phone and a byte pipe to it. */
export interface BleLinkClientOptions {
  noble: NobleApi;
  /** Overridable for tests against a second service UUID; defaults to Helm's. */
  serviceUuid?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Per-step ceiling on the connect sequence; see DEFAULT_STEP_TIMEOUT_MS. */
  stepTimeoutMs?: number;
  /** Ceiling on one unsettled chunk write or disconnect; see DEFAULT_WRITE_TIMEOUT_MS. */
  writeTimeoutMs?: number;
  /** How long a rejected peripheral is skipped before it is tried again. */
  rejectIgnoreMs?: number;
  now?: () => number;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * Scans for the phone, connects it, and emits a `MobileLink` per connection.
 *
 * Events: `link` (MobileLink), `disconnected` (deviceId), `error` (Error).
 */
export class BleLinkClient extends EventEmitter {
  /** The slow transport: anything else the manager owns displaces it. */
  readonly rank = RANK_BLE;

  /** A peripheral id survives a reconnect, so it is worth remembering. */
  readonly persistsAddressHint = true;

  private readonly noble: NobleApi;
  private readonly serviceUuid: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stepTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly rejectIgnoreMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private started = false;
  /**
   * Peripheral ids with a connect sequence in progress. Per peripheral, so one
   * phone mid-connect never blocks a second paired phone from linking.
   */
  private readonly connecting = new Set<string>();
  /**
   * Peripheral ids inside the connectAsync step itself. The scan is paused only
   * while this is non-empty: the WinRT stack has been seen to stall a connect
   * that races an active advertisement watcher, and the pause costs nothing
   * once connect completes — scanning resumes immediately after.
   */
  private readonly scanPausedFor = new Set<string>();
  /** Every live link, keyed by peripheral id. Several phones may be linked at once. */
  private readonly links = new Map<string, BleLinkPipe>();
  private attempts = 0;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Peripheral id → epoch ms until which it is skipped. */
  private readonly ignored = new Map<string, number>();
  /** One expiry timer per ignore entry; see onIgnoreExpired. */
  private readonly ignoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ignore entries whose skipped discovery has already been logged. */
  private readonly ignoreLogged = new Set<string>();
  /** True while WE are stopping the scan, so its scanStop is not unsolicited. */
  private stoppingScan = false;
  private nextAttemptId = 1;

  constructor(options: BleLinkClientOptions) {
    super();
    this.noble = options.noble;
    this.serviceUuid = normaliseUuid(options.serviceUuid ?? HELM_SERVICE_UUID_SHORT);
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.rejectIgnoreMs = options.rejectIgnoreMs ?? DEFAULT_REJECT_IGNORE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? (() => {});
  }

  /** Begin scanning. Safe to call once; the adapter may power on later. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.noble.on('stateChange', this.handleStateChange);
    this.noble.on('discover', this.handleDiscover);
    this.noble.on('scanStop', this.handleScanStop);

    if (this.noble.state === 'poweredOn') await this.scan('start');
  }

  // Bound once so stop() can remove exactly what start() added — otherwise
  // every start/stop cycle stacked another set, and one power-on scanned N times.
  private readonly handleStateChange = (state: string): void => {
    if (state === 'poweredOn') void this.scan('adapter powered on');
    else this.log(`BLE adapter state ${state}`);
  };
  private readonly handleDiscover = (peripheral: NoblePeripheral): void => {
    void this.onDiscover(peripheral);
  };
  private readonly handleScanStop = (): void => this.onScanStop();

  /** Stop scanning, drop any live link, and cancel pending retries. */
  async stop(): Promise<void> {
    this.started = false;
    this.noble.off('stateChange', this.handleStateChange);
    this.noble.off('discover', this.handleDiscover);
    this.clearRescan();
    for (const timer of this.ignoreTimers.values()) clearTimeout(timer);
    this.ignoreTimers.clear();
    // Cleared first: a stopping client closes quietly, with no per-link
    // 'disconnected' events or rescans.
    const links = [...this.links.values()];
    this.links.clear();
    this.connecting.clear();
    this.scanPausedFor.clear();
    await Promise.all(links.map((link) => link.disconnect()));
    await this.safely('stopScanning', () => this.stopScanning());
    // Removed last: stopScanning resolves on the scanStop event itself.
    this.noble.off('scanStop', this.handleScanStop);
  }

  /**
   * Refuse a link the layer above would not keep: disconnect it, skip that
   * advertiser for a while, and go back to scanning. Identity is only knowable
   * after a handshake, so refusing AFTER connecting is the only filter possible
   * — see the identity note in mobile-link-manager.ts.
   */
  /**
   * Close a RETIRED link without the refusal penalty. The manager calls this
   * when a healthy link is displaced (LAN took over) or the stack is stopping:
   * the phone is welcome back over Bluetooth at any moment, so its advertiser
   * id must not land in the ignore window reject() exists to impose on
   * strangers. Same mechanics as reject, minus the cooldown.
   */
  async disconnect(link: MobileLink, reason: string): Promise<void> {
    const current = this.currentPipe(link);
    if (!current) {
      this.log(`BLE ignoring stale close of ${link.deviceId}: ${reason}`);
      return;
    }
    this.log(`BLE closing ${link.deviceId}: ${reason}`);
    // Closing the pipe runs onLinkClosed, which frees the slot and rescans —
    // even when the peripheral never fires 'disconnect'.
    await current.disconnect();
  }

  async reject(link: MobileLink, reason: string): Promise<void> {
    const current = this.currentPipe(link);
    if (!current) {
      // No cooldown either: the advertiser is serving a newer, healthy link.
      this.log(`BLE ignoring stale reject of ${link.deviceId}: ${reason}`);
      return;
    }
    this.ignore(link.deviceId);
    this.log(`BLE rejecting ${link.deviceId}: ${reason}`);
    await current.disconnect();
  }

  /**
   * The live pipe only if `link` IS it. A MobileLink from a superseded
   * connection shares the peripheral id with its successor, so a lookup by id
   * alone would let a late teardown kill the newer, healthy link.
   */
  private currentPipe(link: MobileLink): BleLinkPipe | undefined {
    const current = this.links.get(link.deviceId);
    return current === (link as unknown) ? current : undefined;
  }

  /**
   * Skip an advertiser for the reject window, and arm a rescan for when it
   * ends. noble reports each peripheral once per scan, so without the rescan
   * an advertiser skipped while ignored would never be reported again.
   */
  private ignore(peripheralId: string): void {
    this.ignored.set(peripheralId, this.now() + this.rejectIgnoreMs);
    this.ignoreLogged.delete(peripheralId);
    const previous = this.ignoreTimers.get(peripheralId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.onIgnoreExpired(peripheralId), this.rejectIgnoreMs);
    timer.unref?.();
    this.ignoreTimers.set(peripheralId, timer);
  }

  private onIgnoreExpired(peripheralId: string): void {
    this.ignoreTimers.delete(peripheralId);
    this.ignored.delete(peripheralId);
    this.ignoreLogged.delete(peripheralId);
    this.log(`BLE ignore entry for ${peripheralId} expired`);
    void this.restartScan(`ignore entry for ${peripheralId} expired`);
  }

  /**
   * Stop and start the scan so noble forgets what it already reported. A
   * connect in progress owns the radio and resumes a fresh scan itself when it
   * completes, and a pending backoff rescan starts a fresh scan anyway.
   */
  private async restartScan(reason: string): Promise<void> {
    if (!this.started || this.scanPausedFor.size > 0 || this.rescanTimer) return;
    this.log(`BLE restarting scan: ${reason}`);
    await this.safely('stopScanning', () => this.stopScanning());
    await this.scan(reason);
  }

  /** Stop scanning, marking the resulting scanStop as ours. */
  private async stopScanning(): Promise<void> {
    this.stoppingScan = true;
    try {
      await this.noble.stopScanningAsync();
    } finally {
      this.stoppingScan = false;
    }
  }

  /**
   * A scan end we did not ask for (the OS, a radio reset) would otherwise leave
   * the client idle forever: nothing else restarts a scan that merely stopped.
   */
  private onScanStop(): void {
    if (this.stoppingScan) {
      this.log('BLE scan stopped');
      return;
    }
    if (!this.started || this.scanPausedFor.size > 0) return;
    this.log('BLE scanStop not requested by Helm; rescanning');
    this.scheduleRescan('unsolicited scanStop');
  }

  private async scan(reason: string): Promise<void> {
    if (!this.started || this.scanPausedFor.size > 0) return;
    this.log(`BLE scan start (${reason})`);
    try {
      await this.noble.startScanningAsync([this.serviceUuid], false);
    } catch (error) {
      this.log('BLE startScanning failed', error);
      this.emitError(error);
      // A refused scan start is silent by construction: nothing was scanned, so
      // no discover, no failed connect step, and no disconnect event will ever
      // fire to announce it. The backoff is the only recovery, so a radio that
      // transiently refuses must land here rather than idle the client forever.
      this.scheduleRescan('scan start failed');
    }
  }

  private async onDiscover(peripheral: NoblePeripheral): Promise<void> {
    if (!this.started || this.links.has(peripheral.id) || this.connecting.has(peripheral.id)) return;
    if (this.isIgnored(peripheral.id)) {
      if (!this.ignoreLogged.has(peripheral.id)) {
        this.ignoreLogged.add(peripheral.id);
        this.log(`BLE skipping ignored ${peripheral.id} until ${new Date(this.ignored.get(peripheral.id)!).toISOString()}`);
      }
      return;
    }
    this.connecting.add(peripheral.id);
    // WHICH STEP, how long it took, and a bound on each one. P-0756 caught this
    // sequence hanging for 35 seconds and failing with noble's bare "Disconnected
    // unknown", while the phone sat in Connecting having seen a perfectly
    // successful GATT connect. Three awaits, no timing and no ceiling on any of
    // them, and one bare error for all three: nothing could say which stalled.
    const startedAt = Date.now();
    const attemptId = this.nextAttemptId++;
    let step = 'stopScanning';
    // The pipe does not exist until the last connect step, but the MTU report
    // can beat it: on Windows the WinRT MaxPduSize report lands DURING
    // connectAsync — real logs show zero 'mtu' events ever reaching a listener
    // attached after the connect await. So the listener goes on before the
    // connect attempt is even started, the latest report is kept, and it is
    // replayed into the pipe the moment the pipe exists.
    let latestMtu: number | null = null;
    let pipe: BleLinkPipe | null = null;
    const onMtu = (mtu: number) => {
      latestMtu = mtu;
      pipe?.noteNegotiatedMtu(mtu);
    };
    peripheral.on('mtu', onMtu);
    this.log(`BLE attempt ${attemptId} discovered ${peripheral.id}`);
    try {
      this.log(`BLE attempt ${attemptId} starting ${step} for ${peripheral.id}`);
      this.scanPausedFor.add(peripheral.id);
      await this.stopScanning();

      step = 'connect';
      this.log(`BLE attempt ${attemptId} starting ${step} for ${peripheral.id}`);
      await this.bounded(step, () => peripheral.connectAsync());
      this.log(`BLE attempt ${attemptId} completed ${step} for ${peripheral.id} after ${Date.now() - startedAt}ms`);
      // Resume at once: other phones must stay discoverable while this one
      // discovers, subscribes and — above all — stays linked.
      this.resumeScanAfterConnect(peripheral.id);

      step = 'discover';
      this.log(`BLE attempt ${attemptId} starting ${step} for ${peripheral.id}`);
      const { characteristics } = await this.discoverWithRetry(peripheral);
      this.log(`BLE attempt ${attemptId} completed ${step} for ${peripheral.id} after ${Date.now() - startedAt}ms (characteristics=${characteristics.length})`);

      const rx = findCharacteristic(characteristics, HELM_RX_UUID_SHORT);
      const tx = findCharacteristic(characteristics, HELM_TX_UUID_SHORT);
      if (!rx || !tx) throw new Error(`peripheral ${peripheral.id} is missing the Helm characteristics`);

      step = 'subscribe';
      this.log(`BLE attempt ${attemptId} starting ${step} for ${peripheral.id} (tx=${tx.uuid})`);
      await this.bounded(step, () => tx.subscribeAsync());
      this.log(`BLE attempt ${attemptId} completed ${step} for ${peripheral.id} after ${Date.now() - startedAt}ms`);

      const onDisconnectEvent = () => link.handleClose();
      const link: BleLinkPipe = new BleLinkPipe(peripheral, rx, tx, this.log, this.now, this.writeTimeoutMs, () => {
        // Every exit path of a live link lands here exactly once, so this is
        // where its peripheral listeners come off — reconnects must not stack them.
        peripheral.off('mtu', onMtu);
        peripheral.off('disconnect', onDisconnectEvent);
        this.onLinkClosed(link);
      });
      // Replay a report that arrived before the pipe did; the plausibility band
      // in noteNegotiatedMtu applies to it exactly as to a live one. Later
      // reports (a renegotiation in either direction) update the live link
      // through the listener above.
      if (latestMtu !== null) link.noteNegotiatedMtu(latestMtu);
      pipe = link;
      this.links.set(peripheral.id, link);
      this.attempts = 0;
      peripheral.once('disconnect', onDisconnectEvent);
      this.connecting.delete(peripheral.id);
      this.emit('link', link);
    } catch (error) {
      this.connecting.delete(peripheral.id);
      // A connect-step failure leaves the scan paused; the backoff rescan below
      // is what resumes it, so a flapping phone never tight-loops the radio.
      this.scanPausedFor.delete(peripheral.id);
      this.log(`BLE attempt ${attemptId} ${step} to ${peripheral.id} failed after ${Date.now() - startedAt}ms`, error);
      peripheral.off('mtu', onMtu);
      await this.abandon(peripheral);
      this.emitError(error);
      this.scheduleRescan(`attempt ${attemptId} failed at ${step}`);
    }
  }

  private async discoverWithRetry(peripheral: NoblePeripheral): Promise<{ characteristics: NobleCharacteristic[] }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt += 1) {
      try {
        return await this.bounded('discover', () =>
          peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [this.serviceUuid],
            [HELM_RX_UUID_SHORT, HELM_TX_UUID_SHORT],
          ),
        );
      } catch (error) {
        lastError = error;
        if (attempt < DISCOVERY_ATTEMPTS && this.isRetryableDiscoveryError(error)) {
          this.log(`BLE discover attempt ${attempt} on ${peripheral.id} failed; retrying`, error);
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  private isRetryableDiscoveryError(error: unknown): boolean {
    return /unreachable|not reachable/i.test(error instanceof Error ? error.message : String(error));
  }

  /**
   * Run one step of the connect sequence under its own clock.
   *
   * The loser of the race is left running — noble gives us no way to cancel an
   * in-flight GATT operation — so its eventual rejection is swallowed rather
   * than surfacing as an unhandled rejection long after we stopped caring.
   */
  private bounded<T>(step: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${step} timed out after ${this.stepTimeoutMs}ms`));
      }, this.stepTimeoutMs);

      run().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Drop a half-built connection before going back to scanning.
   *
   * A failed sequence used to walk away without disconnecting, so a connect
   * that succeeded and a discover that then stalled left the phone holding a
   * live link carrying no traffic — and the next attempt met its own leftover
   * connection as "Peripheral already connected". State crossing an attempt
   * boundary made every subsequent capture suspect. The disconnect is attempted
   * unconditionally: a step that timed out may have completed since, so "we
   * never got that far" is not something this layer can know.
   */
  private async abandon(peripheral: NoblePeripheral): Promise<void> {
    try {
      await peripheral.disconnectAsync();
    } catch (error) {
      this.log(`BLE cleanup disconnect of ${peripheral.id} failed`, error);
    }
  }

  /** Resume scanning once no connect step holds the radio. */
  private resumeScanAfterConnect(peripheralId: string): void {
    this.scanPausedFor.delete(peripheralId);
    if (this.scanPausedFor.size === 0) void this.scan(`connect to ${peripheralId} completed`);
  }

  /**
   * A live link ended — peripheral disconnect, a failed or timed-out write,
   * a reject, or a retirement. Frees that peripheral's slot and rescans so it
   * is reported again; other linked phones are untouched.
   */
  private onLinkClosed(link: BleLinkPipe): void {
    if (this.links.get(link.deviceId) !== link) return;
    this.log(`BLE link ${link.deviceId} closed after ${Date.now() - link.connectedAt}ms`);
    this.links.delete(link.deviceId);
    this.emit('disconnected', link.deviceId);
    this.scheduleRescan(`link to ${link.deviceId} closed`);
  }

  /**
   * Helm is the central, so the phone cannot call us back — recovery is always
   * our own rescan. Backoff exists so a phone that is simply out of range does
   * not put the radio in a tight scan loop all day.
   */
  private scheduleRescan(reason: string): void {
    if (!this.started || this.rescanTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempts, this.reconnectMaxMs);
    this.attempts += 1;
    this.log(`BLE rescan in ${delay}ms: ${reason}`);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      // A restart, not a plain start: with other phones linked the scan may
      // still be running, and noble reports each peripheral once per scan.
      void this.restartScan(reason);
    }, delay);
  }

  /** Whether this advertiser is still inside its rejection window. */
  private isIgnored(peripheralId: string): boolean {
    const until = this.ignored.get(peripheralId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.ignored.delete(peripheralId);
    this.ignoreLogged.delete(peripheralId);
    return false;
  }

  private clearRescan(): void {
    if (!this.rescanTimer) return;
    clearTimeout(this.rescanTimer);
    this.rescanTimer = null;
  }

  /** Run a BLE call that must never reject into a caller. */
  private async safely(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log(`BLE ${what} failed`, error);
      this.emitError(error);
    }
  }

  /**
   * EventEmitter throws an unhandled 'error' event, which would turn a radio
   * hiccup into a crash — and, worse, would abort the retry that follows it.
   * A BLE error with nobody listening is a log line, not a fatal.
   */
  private emitError(error: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', asError(error));
  }
}

/**
 * One connected phone, presented as a BytePipe.
 *
 * Writes are serialised through a promise chain: GATT rejects overlapping
 * writes on the same characteristic, and `BytePipe.write` is synchronous by
 * contract, so ordering has to be kept here.
 */
class BleLinkPipe implements MobileLink {
  private readonly chunker = new BleChunker();
  private readonly reassembler = new BleReassembler();
  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly transportErrorHandlers: Array<(failure: LinkTransportError) => void> = [];
  private queue: Promise<void> = Promise.resolve();
  /** Write tasks queued or in flight; write() adds one and retires it. */
  private pendingWrites = 0;
  private closed = false;
  private readonly linkedAt: number;
  private writeSequence = 0;
  private writeWithoutResponse = DEFAULT_WRITE_WITHOUT_RESPONSE;
  /** The MTU the radio actually negotiated; null until a report arrives. */
  private negotiatedMtu: number | null = null;

  constructor(
    private readonly peripheral: NoblePeripheral,
    private readonly rx: NobleCharacteristic,
    tx: NobleCharacteristic,
    private readonly log: (message: string, error?: unknown) => void,
    private now: () => number,
    private readonly writeTimeoutMs: number,
    /** Runs once, after the consumers' close handlers; see BleLinkClient.onLinkClosed. */
    private readonly onClosed: () => void = () => {},
  ) {
    this.linkedAt = this.now();
    tx.on('data', (chunk: Buffer) => this.reassembler.push(chunk));
    this.reassembler.on('message', (message: Buffer) => {
      for (const handler of this.dataHandlers) handler(message);
    });
    this.reassembler.on('drop', (reason: string) => {
      this.log(`BLE framing drop on ${this.deviceId}: ${reason}`);
    });
  }

  get deviceId(): string {
    return this.peripheral.id;
  }

  get deviceName(): string | undefined {
    return this.peripheral.advertisement.localName;
  }

  get connectedAt(): number {
    return this.linkedAt;
  }

  get pipe(): BytePipe {
    return this;
  }

  setWriteWithoutResponse(enabled: boolean): void {
    this.writeWithoutResponse = enabled;
    this.log(`BLE write mode ${this.deviceId}: withoutResponse=${enabled}`);
  }

  /**
   * Adopt an MTU the radio reports as negotiated. Reports outside the plausible
   * band are ignored rather than clamped into it — a bogus value is a reason to
   * stay on the fallback, not to stretch it.
   */
  noteNegotiatedMtu(mtu: number): void {
    if (mtu < MIN_NEGOTIATED_ATT_MTU || mtu > MAX_NEGOTIATED_ATT_MTU) {
      this.log(`BLE ignoring implausible MTU report ${this.deviceId}: mtu=${mtu}`);
      return;
    }
    if (mtu === this.negotiatedMtu) return;
    const first = this.negotiatedMtu === null;
    this.negotiatedMtu = mtu;
    // Once per connection in the normal case; a renegotiation is rare enough
    // — and changes chunking hard enough — that it is worth its own line too.
    this.log(
      `BLE negotiated mtu ${this.deviceId}${first ? '' : ' (renegotiated)'}:` +
        ` mtu=${mtu} chunkSize=${this.chunkSize()}`,
    );
  }

  onFramingDrop(handler: (reason: string) => void): void {
    this.reassembler.on('drop', handler);
  }

  onTransportError(handler: (failure: LinkTransportError) => void): void {
    this.transportErrorHandlers.push(handler);
  }

  /**
   * Whether any chunk writes are still queued or in flight. The keepalive reads
   * this as liveness — a queue that is moving proves the peer path is up, and
   * one that stops moving is killed by the per-chunk write deadline well before
   * this could ever vouch for a dead link.
   */
  hasPendingWrites(): boolean {
    return this.pendingWrites > 0;
  }

  write(data: Buffer): void {
    if (this.closed) return;
    let chunks: Buffer[];
    try {
      chunks = this.chunker.chunk(data, this.chunkSize());
    } catch (error) {
      this.log(`BLE chunking failed for ${this.deviceId}`, error);
      return;
    }

    const writeSequence = ++this.writeSequence;
    this.log(
      `BLE write queued ${this.deviceId} seq=${writeSequence} frameBytes=${data.length}` +
        ` chunks=${chunks.length} chunkSize=${this.chunkSize()} mtu=${this.peripheral.mtu ?? DEFAULT_ATT_MTU}`,
    );

    this.pendingWrites += 1;
    this.queue = this.queue.then(async () => {
      try {
        this.log(`BLE write begin ${this.deviceId} seq=${writeSequence}`);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          if (this.closed) return;
          try {
            this.log(`BLE write chunk ${this.deviceId} seq=${writeSequence} index=${chunkIndex + 1}/${chunks.length} bytes=${chunk.length}`);
            await this.deadline('chunk write', this.rx.writeAsync(chunk, this.writeWithoutResponse));
            this.log(`BLE write chunk complete ${this.deviceId} seq=${writeSequence} index=${chunkIndex + 1}/${chunks.length}`);
          } catch (error) {
            const failure: LinkTransportError = {
              chunkLength: chunk.length,
              mtu: this.peripheral.mtu ?? DEFAULT_ATT_MTU,
              withoutResponse: this.writeWithoutResponse,
              elapsedMs: Date.now() - this.linkedAt,
              error,
            };
            // A missing chunk leaves the framed stream ambiguous. Continuing
            // would append later bytes to a truncated frame, so force the owner
            // through its existing reconnect path; never retry an uncertain write.
            this.log(
              `BLE write to ${this.deviceId} failed after ${failure.elapsedMs}ms` +
                ` (chunk=${failure.chunkLength}, mtu=${failure.mtu},` +
                ` withoutResponse=${failure.withoutResponse}): ${describe(error)}`,
              error,
            );
            for (const handler of this.transportErrorHandlers) handler(failure);
            void this.disconnect();
            return;
          }
        }
        this.log(`BLE write complete ${this.deviceId} seq=${writeSequence}`);
      } finally {
        this.pendingWrites -= 1;
      }
    });
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    void this.disconnect();
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    try {
      // Bounded for the same reason the writes are: a wedged stack ignores the
      // disconnect too, and an unbounded await here would leave the close
      // handlers — the manager's whole recovery path — never firing.
      await this.deadline('disconnect', this.peripheral.disconnectAsync());
    } catch (error) {
      this.log(`BLE disconnect of ${this.deviceId} failed`, error);
    }
    this.handleClose();
  }

  /**
   * Race a GATT call against the clock. Same shape as the client's connect-step
   * bound, applied to the pipe: a write whose promise never settles is the
   * observed reinstall failure, and the loser of the race is left running
   * because noble offers no way to cancel it.
   */
  private deadline<T>(what: string, call: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${what} on ${this.deviceId} timed out after ${this.writeTimeoutMs}ms`)),
        this.writeTimeoutMs,
      );
      call.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Fire close handlers exactly once, whoever noticed the link was gone. */
  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
    this.onClosed();
  }

  /**
   * Bytes of payload per chunk, derived from the MTU the radio NEGOTIATED — the
   * GATT session's MaxPduSize report, not the ambient `peripheral.mtu` read.
   * The ambient value has a history of being transiently large and then falling
   * back, and chunking a queue for an MTU the air link does not really carry
   * produced GATT status 3; only an explicit report is trusted. With no report
   * — an old radio, or a test double that never negotiates — the universally
   * valid 20-byte chunk is used, which the phone reassembler handles anyway.
   * A later report that moves the MTU takes effect from the next write on: the
   * chunker is sized per call precisely because the MTU can change.
   *
   * The result is capped at MAX_ATTRIBUTE_VALUE_BYTES regardless of what the
   * MTU allows: a 517 report yields 514 by the arithmetic, and a write that
   * size is CLIPPED to 512 by a real phone rather than refused, which loses two
   * bytes per chunk and silently destroys every multi-chunk message.
   */
  private chunkSize(): number {
    if (this.negotiatedMtu === null) return MIN_CHUNK_BYTES;
    return Math.max(
      MIN_CHUNK_BYTES,
      Math.min(
        MAX_ATTRIBUTE_VALUE_BYTES,
        Math.min(MAX_NEGOTIATED_ATT_MTU, this.negotiatedMtu) - ATT_OVERHEAD_BYTES,
      ),
    );
  }
}

function findCharacteristic(
  characteristics: NobleCharacteristic[],
  uuid: string,
): NobleCharacteristic | undefined {
  return characteristics.find((characteristic) => normaliseUuid(characteristic.uuid) === uuid);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
