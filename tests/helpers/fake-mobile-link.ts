/**
 * fake-mobile-link — in-memory stand-ins for a transport and one link.
 *
 * FAKES, not mocks: the transport really holds a link, really fires
 * `disconnected`, and really records rejections, so MobileLinkManager can be
 * driven through its whole lifecycle without a radio. They implement exactly the
 * interfaces the manager declares, so TypeScript catches any drift from the real
 * BleLinkClient.
 */

import { EventEmitter } from 'node:events';
import type { MobileLink, LinkTransportError } from '../../src/mobile/mobile-link';
import { RANK_BLE, type MobileLinkTransport } from '../../src/mobile/mobile-link-manager';

/** One connected phone, presented as a BytePipe that records what is written. */
export class FakeLink implements MobileLink {
  readonly writes: Buffer[] = [];
  closed = false;
  /** Chunk writes the transport is still working through; > 0 is a busy queue. */
  pendingWrites = 0;

  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly transportErrorHandlers: Array<(failure: LinkTransportError) => void> = [];

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

  hasPendingWrites(): boolean {
    return this.pendingWrites > 0;
  }

  onTransportError(handler: (failure: LinkTransportError) => void): void {
    this.transportErrorHandlers.push(handler);
  }

  /**
   * Simulate the transport's per-chunk write deadline firing — the way a wedged
   * queue is bounded in the real BleLinkPipe.
   */
  failPendingWrite(): void {
    const failure: LinkTransportError = {
      chunkLength: 20,
      mtu: 23,
      withoutResponse: false,
      elapsedMs: 10_000,
      error: new Error('chunk write timed out'),
    };
    for (const handler of this.transportErrorHandlers) handler(failure);
  }

  /** Simulate the phone notifying Helm. */
  deliver(chunk: Buffer): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }
}

/** A transport stand-in the test drives by hand; rank makes it BLE or LAN. */
export class FakeTransport extends EventEmitter implements MobileLinkTransport {
  started = false;
  startCount = 0;
  /** Every link the manager refused, with the reason it gave. */
  readonly rejected: Array<{ deviceId: string; reason: string }> = [];
  /** Every link the manager RETIRED (displaced/dropped/stopped), not refused. */
  readonly retired: Array<{ deviceId: string; reason: string }> = [];

  /** A radio remembers its address; a socket transport sets this false. */
  persistsAddressHint = true;

  /** Defaults to the BLE rank, so every existing test reads as a radio. */
  constructor(readonly rank: number = RANK_BLE) {
    super();
  }

  async start(): Promise<void> {
    this.started = true;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async reject(link: MobileLink, reason: string): Promise<void> {
    this.rejected.push({ deviceId: link.deviceId, reason });
    link.pipe.close();
    this.emit('disconnected', link.deviceId);
  }

  /** Retire a healthy link without the refusal penalty — mirrors BleLinkClient. */
  async disconnect(link: MobileLink, reason: string): Promise<void> {
    this.retired.push({ deviceId: link.deviceId, reason });
    link.pipe.close();
    this.emit('disconnected', link.deviceId);
  }

  /** Simulate a phone being discovered, connected and handed up. */
  offer(link: MobileLink): void {
    this.emit('link', link);
  }

  /** Simulate the radio losing a link that the manager still holds. */
  drop(link: MobileLink): void {
    link.pipe.close();
    this.emit('disconnected', link.deviceId);
  }
}
