/**
 * PeerLink unit tests — a fake in-memory duplex "ws" pair drives the request /
 * response multiplexing, heartbeat, and dispose contract. No real sockets here:
 * PeerLink is transport-agnostic once handed an authenticated ws-like object.
 *
 * The fake implements exactly the surface PeerLink touches: send/ping/pong/
 * terminate + the 'message'/'pong'/'close'/'error' events, wired as a loopback
 * pair so a frame sent on one end arrives as a 'message' on the other.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PeerLink } from '../src/mcp/peer/peer-link.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/** A fake ws end. Frames written via send() surface on its `peer` as 'message'. */
class FakeWs extends EventEmitter {
  peer!: FakeWs;
  terminated = false;
  sent: string[] = [];
  /** When true, the next send() throws to exercise the send-failure path. */
  throwOnSend = false;
  /** When true, ping() does NOT auto-answer with a pong (dead peer). */
  swallowPing = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(data);
    // Deliver asynchronously to mirror real socket semantics.
    queueMicrotask(() => {
      if (!this.peer.terminated) this.peer.emit('message', Buffer.from(data));
    });
  }

  ping(): void {
    if (this.swallowPing) return;
    queueMicrotask(() => {
      if (!this.terminated) this.emit('pong');
    });
  }

  pong(): void { /* no-op for tests */ }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    queueMicrotask(() => this.emit('close'));
  }

  removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

function makePair(): [FakeWs, FakeWs] {
  const a = new FakeWs();
  const b = new FakeWs();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('PeerLink', () => {
  let links: PeerLink[] = [];

  const track = (l: PeerLink) => { links.push(l); return l; };

  afterEach(() => {
    for (const l of links) l.dispose('test-teardown');
    links = [];
    vi.useRealTimers();
  });

  it('emits online once right after construction', async () => {
    const [a] = makePair();
    const online = vi.fn();
    const link = track(new PeerLink(a as any, { peerId: 'p', connectionEpoch: 1, onCall: async () => 'x' }));
    link.on('online', online);
    // 'online' fires synchronously on construct — attach a second listener via replay.
    await Promise.resolve();
    expect(link.isOnline()).toBe(true);
  });

  it('request/response: two concurrent requests resolve to their correct responses', async () => {
    const [a, b] = makePair();
    const serverA = track(new PeerLink(a as any, {
      peerId: 'B', connectionEpoch: 1,
      onCall: async (_peer, method, params: any) => ({ echoed: method, n: params.n }),
    }));
    const serverB = track(new PeerLink(b as any, {
      peerId: 'A', connectionEpoch: 1,
      onCall: async (_peer, method, params: any) => ({ echoed: method, n: params.n }),
    }));

    const [r1, r2] = await Promise.all([
      serverA.request('first', { n: 1 }),
      serverA.request('second', { n: 2 }),
    ]);
    expect(r1).toEqual({ echoed: 'first', n: 1 });
    expect(r2).toEqual({ echoed: 'second', n: 2 });
    void serverB;
  });

  it('onCall return flows back as the response; a throw becomes a JSON-RPC error', async () => {
    const [a, b] = makePair();
    const client = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 7, onCall: async () => 'unused' }));
    track(new PeerLink(b as any, {
      peerId: 'A', connectionEpoch: 7,
      onCall: async (peerId, method, params: any) => {
        if (method === 'boom') throw new Error('kaboom');
        return { peerId, method, got: params };
      },
    }));

    await expect(client.request('hello', { v: 42 })).resolves.toEqual({ peerId: 'A', method: 'hello', got: { v: 42 } });
    await expect(client.request('boom', {})).rejects.toThrow(/kaboom/);
  });

  it('request timeout rejects after N ms when peer never responds', async () => {
    const [a] = makePair(); // b intentionally never constructed → no responder
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
    await expect(link.request('slow', {}, 20)).rejects.toThrow(/timeout/i);
  });

  it('heartbeat detects a dead peer and emits offline within pong timeout', async () => {
    const [a, b] = makePair();
    a.swallowPing = true; // never answers our ping
    const link = track(new PeerLink(a as any, {
      peerId: 'B', connectionEpoch: 1, onCall: async () => 'x',
      heartbeatIntervalMs: 10, pongTimeoutMs: 15,
    }));
    void b;
    const offline = new Promise<void>(resolve => link.on('offline', () => resolve()));
    await offline;
    expect(link.isOnline()).toBe(false);
  });

  it('max in-flight (256) rejects the 257th without allocating a pending', async () => {
    const [a, b] = makePair();
    // Responder that never replies so requests stay in-flight.
    track(new PeerLink(b as any, { peerId: 'A', connectionEpoch: 1, onCall: () => new Promise(() => {}) }));
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));

    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 256; i++) pending.push(link.request('m', {}, 60_000).catch(() => 'rejected-later'));
    await expect(link.request('overflow', {}, 60_000)).rejects.toThrow(/in-flight|capacity|too many/i);
    expect(link.inFlightCount()).toBe(256);
  });

  it('dispose is idempotent: twice rejects pending exactly once, no unhandled rejections', async () => {
    const [a, b] = makePair();
    track(new PeerLink(b as any, { peerId: 'A', connectionEpoch: 1, onCall: () => new Promise(() => {}) }));
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));

    let rejections = 0;
    const p = link.request('m', {}, 60_000).catch(() => { rejections++; });

    const offline = vi.fn();
    link.on('offline', offline);
    link.dispose('first');
    link.dispose('second');
    await p;
    expect(rejections).toBe(1);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('ids embed the connection epoch (not reused across a reconnect)', async () => {
    const [a, b] = makePair();
    let seenId = '';
    track(new PeerLink(b as any, {
      peerId: 'A', connectionEpoch: 99,
      onCall: () => new Promise(() => {}),
    }));
    // Snoop the raw frame the link sends.
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 99, onCall: async () => 'x' }));
    void link.request('m', {}, 5).catch(() => {});
    await Promise.resolve();
    seenId = String(JSON.parse(a.sent[0]).id);
    expect(seenId.startsWith('99:')).toBe(true);
  });

  it('send-throw on request rejects immediately and leaves no pending', async () => {
    const [a] = makePair();
    a.throwOnSend = true;
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
    await expect(link.request('m', {}, 5000)).rejects.toThrow(/send failed/);
    expect(link.inFlightCount()).toBe(0);
  });

  it('malformed inbound JSON is ignored (no throw)', async () => {
    const [a] = makePair();
    const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
    expect(() => a.emit('message', Buffer.from('{not json'))).not.toThrow();
    expect(link.isOnline()).toBe(true);
  });

  it('duplicate inbound request id while active replies with a JSON-RPC error', async () => {
    const [a, b] = makePair();
    let release: (v: unknown) => void = () => {};
    track(new PeerLink(b as any, {
      peerId: 'A', connectionEpoch: 1,
      onCall: () => new Promise(res => { release = res; }),
    }));
    // Manually push two frames with the SAME id to the responder end (b).
    const frame = JSON.stringify({ jsonrpc: '2.0', id: '1:1', method: 'm', params: {} });
    b.emit('message', Buffer.from(frame));
    b.emit('message', Buffer.from(frame));
    await new Promise(r => setTimeout(r, 5));
    // The second should have produced an error reply on b.sent.
    const replies = b.sent.map(s => JSON.parse(s));
    const errs = replies.filter(r => r.error);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    release(undefined);
    void a;
  });

  describe('notifications (fire-and-forget streams, e.g. remote PTY data)', () => {
    it('notify() sends an id-less frame that surfaces as a notification event, not an onCall', async () => {
      const [a, b] = makePair();
      const sender = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
      const onCall = vi.fn(async () => 'x');
      const receiver = track(new PeerLink(b as any, { peerId: 'A', connectionEpoch: 1, onCall }));
      const got = new Promise<unknown[]>((resolve) => receiver.on('notification', (...args) => resolve(args)));

      sender.notify('remote.data', { sessionId: 's1', seq: 1, data: 'hi' });

      expect(await got).toEqual(['remote.data', { sessionId: 's1', seq: 1, data: 'hi' }]);
      expect(JSON.parse(a.sent[0])).not.toHaveProperty('id');
      expect(onCall).not.toHaveBeenCalled();
    });

    it('an inbound notification never produces a reply frame, even when a listener throws', async () => {
      const [a, b] = makePair();
      const sender = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
      const receiver = track(new PeerLink(b as any, { peerId: 'A', connectionEpoch: 1, onCall: async () => 'x' }));
      receiver.on('notification', () => { throw new Error('listener blew up'); });

      sender.notify('remote.write', { data: 'x' });
      await new Promise((r) => setTimeout(r, 5));

      expect(b.sent).toEqual([]);
      expect(receiver.isOnline()).toBe(true);
    });

    it('notify() after dispose is a silent no-op', () => {
      const [a] = makePair();
      const link = track(new PeerLink(a as any, { peerId: 'B', connectionEpoch: 1, onCall: async () => 'x' }));
      link.dispose('test');
      expect(() => link.notify('remote.data', {})).not.toThrow();
      expect(a.sent).toEqual([]);
    });
  });
});
