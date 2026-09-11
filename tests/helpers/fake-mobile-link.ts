/**
 * fake-mobile-link — in-memory stand-ins for the BLE transport and one link.
 *
 * FAKES, not mocks: the transport really holds a link, really fires
 * `disconnected`, and really records rejections, so MobileLinkManager can be
 * driven through its whole lifecycle without a radio. They implement exactly the
 * interfaces the manager declares, so TypeScript catches any drift from the real
 * BleLinkClient.
 */

import { EventEmitter } from 'node:events';
import type { BleLink } from '../../src/mobile/ble/ble-link-client';
import type { MobileLinkTransport } from '../../src/mobile/mobile-link-manager';

/** One connected phone, presented as a BytePipe that records what is written. */
export class FakeBleLink implements BleLink {
  readonly writes: Buffer[] = [];
  closed = false;

  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  constructor(
    readonly deviceId: string,
    readonly deviceName?: string,
  ) {}

  get pipe(): this {
    return this;
  }

  write(data: Buffer): void {
    if (!this.closed) this.writes.push(Buffer.from(data));
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }

  onFramingDrop(): void {
    /* diagnostics only; nothing under test listens */
  }

  /** Simulate the phone notifying Helm. */
  deliver(chunk: Buffer): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }
}

/** A BleLinkClient stand-in the test drives by hand. */
export class FakeTransport extends EventEmitter implements MobileLinkTransport {
  started = false;
  startCount = 0;
  /** Every link the manager refused, with the reason it gave. */
  readonly rejected: Array<{ deviceId: string; reason: string }> = [];

  async start(): Promise<void> {
    this.started = true;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async reject(link: BleLink, reason: string): Promise<void> {
    this.rejected.push({ deviceId: link.deviceId, reason });
    link.pipe.close();
    this.emit('disconnected', link.deviceId);
  }

  /** Simulate a phone being discovered, connected and handed up. */
  offer(link: BleLink): void {
    this.emit('link', link);
  }

  /** Simulate the radio losing a link that the manager still holds. */
  drop(link: BleLink): void {
    link.pipe.close();
    this.emit('disconnected', link.deviceId);
  }
}
