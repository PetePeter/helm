/**
 * fake-noble — an in-memory stand-in for the @stoprocent/noble central API.
 *
 * A FAKE, not a mock: it actually holds state, actually delivers the bytes
 * written to it, and actually fires disconnect. Tests assert on real behaviour
 * of BleLinkClient against it rather than on call bookkeeping. It implements
 * exactly the narrow surface BleLinkClient declares, so if that surface drifts
 * from real noble, TypeScript says so here.
 */

import { EventEmitter } from 'node:events';
import type {
  NobleApi,
  NobleCharacteristic,
  NoblePeripheral,
} from '../../src/mobile/ble/ble-link-client';
import {
  HELM_CTL_UUID_SHORT,
  HELM_RX_UUID_SHORT,
  HELM_TX_UUID_SHORT,
} from '../../src/mobile/ble/characteristics';

export class FakeCharacteristic extends EventEmitter implements NobleCharacteristic {
  /** Everything Helm has written to this characteristic, in order. */
  readonly writes: Buffer[] = [];
  readonly writeModes: boolean[] = [];
  subscribed = false;
  failNextWrite: Error | null = null;
  /** Never resolve a subscribe, the way a stalled CCC descriptor write behaves. */
  hangSubscribe = false;

  constructor(readonly uuid: string) {
    super();
  }

  async writeAsync(data: Buffer, withoutResponse: boolean): Promise<void> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    const copy = Buffer.from(data);
    this.writes.push(copy);
    this.writeModes.push(withoutResponse);
    // Lets a test cross-wire one fake peripheral's RX into another's TX.
    this.emit('write', copy);
  }

  async subscribeAsync(): Promise<void> {
    if (this.hangSubscribe) return new Promise<void>(() => {});
    this.subscribed = true;
  }

  /** Simulate the phone notifying Helm. */
  notify(data: Buffer): void {
    this.emit('data', data);
  }
}

export class FakePeripheral extends EventEmitter implements NoblePeripheral {
  readonly rx = new FakeCharacteristic(HELM_RX_UUID_SHORT);
  readonly tx = new FakeCharacteristic(HELM_TX_UUID_SHORT);
  readonly ctl = new FakeCharacteristic(HELM_CTL_UUID_SHORT);
  connected = false;
  mtu = 185;
  advertisement: { localName?: string } = { localName: 'helm-phone' };
  failConnect: Error | null = null;
  failDiscover: Error | null = null;
  failDiscoverPermanently = true;
  discoverFailuresRemaining = 0;
  discoverCalls = 0;
  /**
   * Never resolve discovery. This is the observed real failure: the GATT
   * connection succeeds, the phone sits in Connecting, and noble's discover
   * await simply never comes back.
   */
  hangDiscover = false;
  /** Never resolve a connect, so the connect step can be timed out too. */
  hangConnect = false;
  /** How many times Helm asked for a disconnect — proves orphan cleanup. */
  disconnectCalls = 0;

  constructor(readonly id: string = 'aa:bb:cc:dd:ee:ff') {
    super();
  }

  async connectAsync(): Promise<void> {
    if (this.failConnect) throw this.failConnect;
    if (this.hangConnect) return new Promise<void>(() => {});
    this.connected = true;
  }

  async disconnectAsync(): Promise<void> {
    this.disconnectCalls += 1;
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  }

  async discoverSomeServicesAndCharacteristicsAsync(): Promise<{
    characteristics: NobleCharacteristic[];
  }> {
    this.discoverCalls += 1;
    if (this.discoverFailuresRemaining > 0) {
      this.discoverFailuresRemaining -= 1;
      throw this.failDiscover ?? new Error('discovery failed');
    }
    if (this.failDiscover && this.failDiscoverPermanently) throw this.failDiscover;
    if (this.hangDiscover) {
      return new Promise<{ characteristics: NobleCharacteristic[] }>(() => {});
    }
    return { characteristics: [this.rx, this.tx, this.ctl] };
  }

  /** Simulate the phone or the radio dropping the link. */
  dropLink(): void {
    this.connected = false;
    this.emit('disconnect');
  }
}

export class FakeNoble extends EventEmitter implements NobleApi {
  state = 'unknown';
  scanning = false;
  /** Number of times scanning was started — proves backoff is not a tight loop. */
  scanStarts = 0;
  /** Service UUID filter of the most recent scan — proves Helm filters at all. */
  lastScanFilter: string[] = [];

  async startScanningAsync(serviceUuids: string[] = []): Promise<void> {
    this.scanning = true;
    this.scanStarts += 1;
    this.lastScanFilter = serviceUuids;
  }

  async stopScanningAsync(): Promise<void> {
    this.scanning = false;
  }

  /** Simulate the adapter coming up. */
  powerOn(): void {
    this.state = 'poweredOn';
    this.emit('stateChange', 'poweredOn');
  }

  /** Simulate a scan result. */
  discover(peripheral: FakePeripheral): void {
    this.emit('discover', peripheral);
  }
}
