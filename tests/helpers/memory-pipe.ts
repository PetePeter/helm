/**
 * memory-pipe — an in-process duplex byte pipe pair for SecureChannel tests.
 *
 * Deliberately dumb: no BLE, no sockets, no chunking policy. Each end writes
 * bytes that arrive synchronously (next microtask) at the other end, so a whole
 * handshake can run inside a single test without timers.
 *
 * `transform` lets a test act as a hostile relay — tampering with, replaying or
 * dropping bytes in flight — which is how the tamper/replay cases are proven.
 */

import type { BytePipe } from '../../src/mobile/secure-channel';

export type PipeTransform = (chunk: Buffer) => Buffer | null;

class MemoryPipeEnd implements BytePipe {
  peer!: MemoryPipeEnd;
  transform: PipeTransform | null = null;

  private dataHandlers: Array<(chunk: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private isClosed = false;

  /** Every chunk this end has written, post-transform — used to replay frames. */
  readonly sent: Buffer[] = [];

  write(data: Buffer): void {
    if (this.isClosed) return;
    const outgoing = this.transform ? this.transform(Buffer.from(data)) : Buffer.from(data);
    if (!outgoing) return;
    this.sent.push(outgoing);
    queueMicrotask(() => this.peer.receive(outgoing));
  }

  /** Feed bytes into THIS end as if the peer had sent them (replay attacks). */
  deliver(data: Buffer): void {
    queueMicrotask(() => this.receive(Buffer.from(data)));
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const handler of this.closeHandlers) handler();
    queueMicrotask(() => this.peer.close());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private receive(chunk: Buffer): void {
    if (this.isClosed) return;
    for (const handler of this.dataHandlers) handler(chunk);
  }
}

export interface MemoryPipePair {
  a: MemoryPipeEnd;
  b: MemoryPipeEnd;
}

export function createMemoryPipePair(): MemoryPipePair {
  const a = new MemoryPipeEnd();
  const b = new MemoryPipeEnd();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

export type { MemoryPipeEnd };
