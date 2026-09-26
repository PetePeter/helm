/**
 * PeerLink — JSON-RPC 2.0 multiplexer over an ALREADY-authenticated ws socket.
 *
 * The link is transport-agnostic: it receives a ws-like object (send / ping /
 * pong / terminate + 'message'/'pong'/'close'/'error' events) whose TLS + PSK
 * handshake has already succeeded. It owns NO trust decisions — those live in
 * the server/client that build it. Here we only frame, correlate, time out, and
 * heartbeat.
 *
 * FRAME DISCIPLINE (strict): every inbound object is discriminated exactly once —
 *   • a string `method` → an inbound REQUEST → routed to onCall, reply with
 *     {result} or a {error:{code:-32000}} on throw;
 *   • a `result`/`error` with a KNOWN pending id → settle that request;
 *   • anything else (unknown/late id, malformed) → logged and dropped, allocating
 *     nothing (so a peer cannot exhaust memory with junk ids).
 *
 * SAFETY: max 256 in-flight requests (257th rejects without allocating); the
 * pending entry is inserted BEFORE ws.send so a synchronous inbound reply can
 * never race ahead of registration; dispose() is idempotent and rejects every
 * pending exactly once.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../../utils/logger.js';

/** Minimal ws surface PeerLink depends on (real `ws` satisfies this). */
export interface WsLike {
  send(data: string): void;
  ping(data?: unknown): void;
  pong(data?: unknown): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
}

export type OnCall = (peerId: string, method: string, params: unknown) => Promise<unknown>;

export interface PeerLinkOptions {
  peerId: string;
  connectionEpoch: number;
  onCall: OnCall;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  now?: () => number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_IN_FLIGHT = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

export class PeerLink extends EventEmitter {
  private readonly ws: WsLike;
  private readonly peerId: string;
  private readonly epoch: number;
  private readonly onCall: OnCall;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;

  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  /** Ids of inbound requests currently being handled (dup-detection). */
  private readonly activeInbound = new Set<string>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // Bound handlers kept so dispose() can remove EXACTLY its own listeners —
  // never removeAllListeners(), which would also strip the ws-internal 'close'
  // handler a WebSocketServer relies on to stop tracking the client.
  private readonly onMessageBound = (data: unknown) => this.onMessage(data);
  private readonly onPongBound = () => this.onPong();
  private readonly onCloseBound = () => this.dispose('ws-close');
  private readonly onErrorBound = (err: Error) => {
    // Guard emit: 'error' with no listener throws under EventEmitter semantics.
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this.dispose('ws-error');
  };

  constructor(ws: WsLike, opts: PeerLinkOptions) {
    super();
    this.ws = ws;
    this.peerId = opts.peerId;
    this.epoch = opts.connectionEpoch;
    this.onCall = opts.onCall;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;

    this.ws.on('message', this.onMessageBound);
    this.ws.on('pong', this.onPongBound);
    this.ws.on('close', this.onCloseBound);
    this.ws.on('error', this.onErrorBound);

    this.startHeartbeat();
    // 'online' is emitted on the next tick so a synchronous listener attached
    // right after construction still observes it.
    queueMicrotask(() => { if (!this.disposed) this.emit('online'); });
  }

  /** Whether the link is still usable. */
  isOnline(): boolean {
    return !this.disposed;
  }

  /** Number of outbound requests awaiting a reply. */
  inFlightCount(): number {
    return this.pending.size;
  }

  /**
   * Send a JSON-RPC request and resolve with its result (or reject on error /
   * timeout / link close). Rejects immediately if the in-flight cap is hit — no
   * pending entry is allocated for the rejected call.
   */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('PeerLink is closed'));
    if (this.pending.size >= MAX_IN_FLIGHT) {
      return Promise.reject(new Error(`PeerLink in-flight capacity reached (${MAX_IN_FLIGHT}); too many pending requests`));
    }

    const id = `${this.epoch}:${++this.counter}`;
    const ms = clampTimeout(timeoutMs ?? this.requestTimeoutMs);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PeerLink request timeout after ${ms}ms (${method})`));
      }, ms);

      // Insert BEFORE send so a synchronous reply cannot arrive before we are
      // registered to receive it.
      this.pending.set(id, { resolve, reject, timer });

      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.ws.send(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Fire-and-forget JSON-RPC notification (no id, no reply, no timeout) for
   * streams where a round-trip per chunk would be too slow. No-op once closed.
   */
  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch (err) {
      logger.warn(`[PeerLink] Failed to send notification to peer ${this.peerId}: ${(err as Error).message}`);
      this.dispose('notify-send-failed');
    }
  }

  /**
   * Idempotent teardown: stop timers, drop ws listeners, terminate the socket,
   * reject every pending exactly once, and emit 'offline' exactly once.
   */
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`PeerLink closed: ${reason}`));
    }
    this.pending.clear();
    this.activeInbound.clear();

    // Remove ONLY our own listeners (see onMessageBound comment).
    const off = (this.ws.off ?? this.ws.removeListener)?.bind(this.ws);
    if (off) {
      try {
        off('message', this.onMessageBound);
        off('pong', this.onPongBound);
        off('close', this.onCloseBound);
        off('error', this.onErrorBound);
      } catch { /* best effort */ }
    }
    try { this.ws.terminate(); } catch { /* best effort */ }

    logger.info(`[PeerLink] Disposed link to peer ${this.peerId} (${reason})`);
    this.emit('offline', reason);
  }

  // ---------------------------------------------------------------- internals

  private onMessage(data: unknown): void {
    if (this.disposed) return;
    let msg: any;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : (data as Buffer).toString('utf8'));
    } catch {
      logger.warn(`[PeerLink] Dropped malformed frame from peer ${this.peerId}`);
      return;
    }
    if (msg === null || typeof msg !== 'object') return;

    if (typeof msg.method === 'string') {
      if (typeof msg.id === 'undefined') this.emitNotification(msg.method, msg.params);
      else void this.handleInboundRequest(msg);
      return;
    }
    if (typeof msg.id !== 'undefined' && (('result' in msg) || ('error' in msg))) {
      this.settlePending(msg);
      return;
    }
    // Unknown / late / junk — allocate nothing.
    logger.debug?.(`[PeerLink] Ignored unrecognised frame from peer ${this.peerId}`);
  }

  /**
   * Id-less frames are JSON-RPC notifications: they never reach onCall (the MCP
   * tool gate) and never get a reply. A throwing listener must not kill the link.
   */
  private emitNotification(method: string, params: unknown): void {
    try {
      this.emit('notification', method, params);
    } catch (err) {
      logger.warn(`[PeerLink] Notification handler for ${method} from peer ${this.peerId} threw: ${(err as Error).message}`);
    }
  }

  private async handleInboundRequest(msg: any): Promise<void> {
    const id = String(msg.id);
    if (this.activeInbound.has(id)) {
      this.reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Duplicate request id' } });
      return;
    }
    this.activeInbound.add(id);
    try {
      const result = await this.onCall(this.peerId, msg.method, msg.params);
      this.reply({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
    } finally {
      this.activeInbound.delete(id);
    }
  }

  private settlePending(msg: any): void {
    const p = this.pending.get(String(msg.id));
    if (!p) {
      logger.debug?.(`[PeerLink] Ignored reply for unknown id ${msg.id} from peer ${this.peerId}`);
      return;
    }
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    if ('error' in msg && msg.error) {
      const m = msg.error && typeof msg.error.message === 'string' ? msg.error.message : 'remote error';
      p.reject(new Error(m));
    } else {
      p.resolve(msg.result);
    }
  }

  private reply(frame: unknown): void {
    if (this.disposed) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn(`[PeerLink] Failed to send reply to peer ${this.peerId}: ${(err as Error).message}`);
      this.dispose('reply-send-failed');
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatIntervalMs);
  }

  private beat(): void {
    if (this.disposed) return;
    // A pong is still outstanding from the previous beat — do NOT re-arm (that
    // would keep pushing the deadline out and mask a dead peer). Wait for the
    // existing deadline to fire.
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      logger.warn(`[PeerLink] Pong timeout for peer ${this.peerId} — terminating`);
      this.dispose('pong-timeout');
    }, this.pongTimeoutMs);
    try {
      this.ws.ping();
    } catch {
      this.dispose('ping-failed');
    }
  }

  private onPong(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}
