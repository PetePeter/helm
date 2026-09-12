/**
 * ble-link-client — Helm's BLE central. The only file that talks to noble.
 *
 * ROLE FLIP (ratified 2026-09-11, context af250949): the Android app advertises
 * and serves GATT; Helm scans, connects, discovers, subscribes to TX and writes
 * to RX. `@stoprocent/bleno` cannot serve GATT on Windows without a WinUSB
 * driver swap, so the peripheral role is not available to us.
 *
 * What escapes this directory is a `BleLink`: a device identity plus a
 * `BytePipe`, the interface `secure-channel.ts` already consumes. No noble or
 * GATT type crosses that line, which is what lets SecureChannel stay entirely
 * transport-agnostic and hardware-free to test.
 *
 * Per invariant 7's spirit, BLE errors are logged and emitted, never thrown into
 * the session layer: a radio that misbehaves must not take a session with it.
 */

import { EventEmitter } from 'node:events';
import type { BytePipe } from '../secure-channel';
import { BleChunker, BleReassembler, MIN_CHUNK_BYTES } from './ble-framing';
import {
  HELM_RX_UUID_SHORT,
  HELM_SERVICE_UUID_SHORT,
  HELM_TX_UUID_SHORT,
  normaliseUuid,
} from './characteristics';

/** ATT protocol overhead on a notification or write: opcode + handle. */
const ATT_OVERHEAD_BYTES = 3;

/** Fallback when the adapter does not report a negotiated MTU. */
const DEFAULT_ATT_MTU = 23;

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/**
 * How long any one step of the connect sequence may take before Helm gives up
 * on it.
 *
 * None of the three steps had a bound, and on real hardware `discover` simply
 * never returned: Helm sat for ~33 seconds, died on noble's bare "Disconnected
 * unknown", and could not say which await had been stuck. Ten seconds is well
 * under the ~30s the phone was observed holding a silent connection, so Helm
 * now gives up first and gets to describe what happened.
 */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

/**
 * How long a refused advertiser is skipped. Identity is only known after a
 * handshake, so the layer above has to connect before it can say no — without
 * this window a neighbour's phone would be reconnected on every rescan forever.
 */
const DEFAULT_REJECT_IGNORE_MS = 60_000;

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
}

export interface NobleApi {
  readonly state: string;
  startScanningAsync(serviceUuids: string[], allowDuplicates: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
  on(event: 'stateChange', handler: (state: string) => void): unknown;
  on(event: 'discover', handler: (peripheral: NoblePeripheral) => void): unknown;
}

/* ------------------------------------------------------------------ */

/** What the rest of Helm sees: an identified phone and a byte pipe to it. */
export interface BleLink {
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly pipe: BytePipe;
  /** Observe framing losses on this link — diagnostics, never fatal. */
  onFramingDrop(handler: (reason: string) => void): void;
}

export interface BleLinkClientOptions {
  noble: NobleApi;
  /** Overridable for tests against a second service UUID; defaults to Helm's. */
  serviceUuid?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Per-step ceiling on the connect sequence; see DEFAULT_STEP_TIMEOUT_MS. */
  stepTimeoutMs?: number;
  /** How long a rejected peripheral is skipped before it is tried again. */
  rejectIgnoreMs?: number;
  now?: () => number;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * Scans for the phone, connects it, and emits a `BleLink` per connection.
 *
 * Events: `link` (BleLink), `disconnected` (deviceId), `error` (Error).
 */
export class BleLinkClient extends EventEmitter {
  private readonly noble: NobleApi;
  private readonly serviceUuid: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stepTimeoutMs: number;
  private readonly rejectIgnoreMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private started = false;
  private busy = false;
  private active: BleLinkPipe | null = null;
  private attempts = 0;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Peripheral id → epoch ms until which it is skipped. */
  private readonly ignored = new Map<string, number>();

  constructor(options: BleLinkClientOptions) {
    super();
    this.noble = options.noble;
    this.serviceUuid = normaliseUuid(options.serviceUuid ?? HELM_SERVICE_UUID_SHORT);
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.rejectIgnoreMs = options.rejectIgnoreMs ?? DEFAULT_REJECT_IGNORE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? (() => {});
  }

  /** Begin scanning. Safe to call once; the adapter may power on later. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.noble.on('stateChange', (state: string) => {
      if (state === 'poweredOn') void this.scan();
      else this.log(`BLE adapter state ${state}`);
    });
    this.noble.on('discover', (peripheral: NoblePeripheral) => {
      void this.onDiscover(peripheral);
    });

    if (this.noble.state === 'poweredOn') await this.scan();
  }

  /** Stop scanning, drop any live link, and cancel pending retries. */
  async stop(): Promise<void> {
    this.started = false;
    this.clearRescan();
    const link = this.active;
    this.active = null;
    if (link) await link.disconnect();
    await this.safely('stopScanning', () => this.noble.stopScanningAsync());
  }

  /**
   * Refuse a link the layer above would not keep: disconnect it, skip that
   * advertiser for a while, and go back to scanning. Identity is only knowable
   * after a handshake, so refusing AFTER connecting is the only filter possible
   * — see the identity note in mobile-link-manager.ts.
   */
  async reject(link: BleLink, reason: string): Promise<void> {
    this.ignored.set(link.deviceId, this.now() + this.rejectIgnoreMs);
    this.log(`BLE rejecting ${link.deviceId}: ${reason}`);

    const active = this.active;
    if (!active || active.deviceId !== link.deviceId) return;
    await active.disconnect();
    // A peripheral that never fires 'disconnect' would otherwise wedge the
    // client with a dead active link and no scheduled rescan.
    if (this.active !== active) return;
    this.active = null;
    this.emit('disconnected', active.deviceId);
    this.scheduleRescan();
  }

  private async scan(): Promise<void> {
    if (!this.started || this.active || this.busy) return;
    await this.safely('startScanning', () => this.noble.startScanningAsync([this.serviceUuid], false));
  }

  private async onDiscover(peripheral: NoblePeripheral): Promise<void> {
    if (!this.started || this.active || this.busy) return;
    if (this.isIgnored(peripheral.id)) return;
    this.busy = true;
    // WHICH STEP, how long it took, and a bound on each one. P-0756 caught this
    // sequence hanging for 35 seconds and failing with noble's bare "Disconnected
    // unknown", while the phone sat in Connecting having seen a perfectly
    // successful GATT connect. Three awaits, no timing and no ceiling on any of
    // them, and one bare error for all three: nothing could say which stalled.
    const startedAt = Date.now();
    let step = 'stopScanning';
    try {
      await this.noble.stopScanningAsync();

      step = 'connect';
      await this.bounded(step, () => peripheral.connectAsync());
      this.log(`BLE ${step} to ${peripheral.id} took ${Date.now() - startedAt}ms`);

      step = 'discover';
      const { characteristics } = await this.bounded(step, () =>
        peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [this.serviceUuid],
          [HELM_RX_UUID_SHORT, HELM_TX_UUID_SHORT],
        ),
      );
      this.log(`BLE ${step} on ${peripheral.id} took ${Date.now() - startedAt}ms`);

      const rx = findCharacteristic(characteristics, HELM_RX_UUID_SHORT);
      const tx = findCharacteristic(characteristics, HELM_TX_UUID_SHORT);
      if (!rx || !tx) throw new Error(`peripheral ${peripheral.id} is missing the Helm characteristics`);

      step = 'subscribe';
      await this.bounded(step, () => tx.subscribeAsync());
      this.log(`BLE link to ${peripheral.id} is ready after ${Date.now() - startedAt}ms`);

      const link = new BleLinkPipe(peripheral, rx, tx, this.log);
      this.active = link;
      this.attempts = 0;
      peripheral.once('disconnect', () => this.onDisconnect(link));
      this.busy = false;
      this.emit('link', link);
    } catch (error) {
      this.busy = false;
      this.log(`BLE ${step} to ${peripheral.id} failed after ${Date.now() - startedAt}ms`, error);
      await this.abandon(peripheral);
      this.emitError(error);
      this.scheduleRescan();
    }
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

  private onDisconnect(link: BleLinkPipe): void {
    if (this.active !== link) return;
    this.active = null;
    link.handleClose();
    this.emit('disconnected', link.deviceId);
    this.scheduleRescan();
  }

  /**
   * Helm is the central, so the phone cannot call us back — recovery is always
   * our own rescan. Backoff exists so a phone that is simply out of range does
   * not put the radio in a tight scan loop all day.
   */
  private scheduleRescan(): void {
    if (!this.started || this.rescanTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempts, this.reconnectMaxMs);
    this.attempts += 1;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.scan();
    }, delay);
  }

  /** Whether this advertiser is still inside its rejection window. */
  private isIgnored(peripheralId: string): boolean {
    const until = this.ignored.get(peripheralId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.ignored.delete(peripheralId);
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
class BleLinkPipe implements BleLink {
  private readonly chunker = new BleChunker();
  private readonly reassembler = new BleReassembler();
  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly peripheral: NoblePeripheral,
    private readonly rx: NobleCharacteristic,
    tx: NobleCharacteristic,
    private readonly log: (message: string, error?: unknown) => void,
  ) {
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

  get pipe(): BytePipe {
    return this;
  }

  onFramingDrop(handler: (reason: string) => void): void {
    this.reassembler.on('drop', handler);
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

    this.queue = this.queue.then(async () => {
      for (const chunk of chunks) {
        if (this.closed) return;
        try {
          await this.rx.writeAsync(chunk, false);
        } catch (error) {
          // One failed chunk poisons only this message; the link stays up and
          // the layer above sees a framing drop rather than a thrown error.
          this.log(`BLE write to ${this.deviceId} failed: ${describe(error)}`, error);
          return;
        }
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
      await this.peripheral.disconnectAsync();
    } catch (error) {
      this.log(`BLE disconnect of ${this.deviceId} failed`, error);
    }
    this.handleClose();
  }

  /** Fire close handlers exactly once, whoever noticed the link was gone. */
  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }

  /** Read the MTU per write: it can be renegotiated mid-connection. */
  private chunkSize(): number {
    const mtu = this.peripheral.mtu ?? DEFAULT_ATT_MTU;
    return Math.max(MIN_CHUNK_BYTES, mtu - ATT_OVERHEAD_BYTES);
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
