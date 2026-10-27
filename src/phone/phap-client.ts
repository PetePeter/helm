/**
 * PhAP 2026-10-27 controller client: JSON-RPC over a WebSocket (subprotocol
 * `phap`). Reconnects with backoff and resumes from the last processed `seq`,
 * so events are not lost across a dropped socket. A silent socket (no frame
 * for 3 × heartbeat) is declared dead — the owner may restart the server.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export const PHAP_VERSION = '2026-10-27';

export interface PhapEvent { seq: number; ts: string; type: string; [key: string]: unknown }

export interface PhapWelcome {
  protocolVersion: string;
  serverInfo: { name: string; version: string; instanceId?: string };
  capabilities: Record<string, unknown>;
  role: 'controller' | 'observer';
  state: { link: 'up' | 'down'; engine: string; calls: Array<{ callId: string; number: string; state: string; direction: string; name?: string }> };
  lastSeq: number;
  gap: boolean;
}

export class PhapError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export interface PhapClientOptions {
  uri: string;
  token: string;
  clientVersion: string;
  heartbeatS?: number;
  log?: (msg: string) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Events: `welcome` (PhapWelcome), `event` (PhapEvent, heartbeats excluded),
 * `connected`, `disconnected` (reason), `dead` (no heartbeat).
 */
export class PhapClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private lastSeq: number | null = null;
  private instanceId: string | undefined;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private helloId = -1;

  constructor(private readonly opts: PhapClientOptions) { super(); }

  isConnected(): boolean { return this.ready; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket('stopped');
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ready || !this.ws) throw new PhapError(1002, 'no_link', { detail: 'PhAP not connected' });
    return this.send<T>(this.ws, method, params);
  }

  private send<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PhapError(-32603, 'timeout', { detail: `${method} timed out` }));
      }, this.opts.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private open(): void {
    if (!this.running) return;
    const ws = new WebSocket(this.opts.uri, ['phap']);
    this.ws = ws;
    ws.on('open', () => { void this.handshake(ws); });
    ws.on('message', (raw) => this.onFrame(ws, raw.toString()));
    ws.on('close', (code) => this.onClosed(ws, `closed ${code}`));
    ws.on('error', (err) => this.opts.log?.(`phap socket error: ${err.message}`));
  }

  private async handshake(ws: WebSocket): Promise<void> {
    try {
      this.helloId = this.nextId + 1;
      const welcome = await this.send<PhapWelcome>(ws, 'hello', {
        protocolVersion: PHAP_VERSION,
        token: this.opts.token,
        role: 'controller',
        clientInfo: { name: 'helm', version: this.opts.clientVersion },
        ...(this.lastSeq !== null ? { resumeFrom: this.lastSeq } : {}),
      });
      if (welcome.role !== 'controller') throw new PhapError(1004, 'busy', { detail: 'another controller holds the line' });
      this.ready = true;
      this.attempt = 0;
      this.armSilence();
      this.emit('welcome', welcome);
      this.emit('connected');
    } catch (err) {
      this.opts.log?.(`phap hello failed: ${(err as Error).message}`);
      ws.close();
    }
  }

  private onFrame(ws: WebSocket, raw: string): void {
    if (ws !== this.ws) return;
    let frame: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: PhapEvent };
    try { frame = JSON.parse(raw); } catch { return; }
    this.armSilence();
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      if (frame.id === this.helloId && frame.result) this.adoptCursor(frame.result as PhapWelcome);
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) p.reject(new PhapError(frame.error.code, frame.error.message, frame.error.data));
      else p.resolve(frame.result);
      return;
    }
    if (frame.method !== 'event' || !frame.params) return;
    const ev = frame.params;
    if (this.lastSeq !== null && ev.seq <= this.lastSeq) return;
    this.lastSeq = ev.seq;
    if (ev.type !== 'heartbeat') this.emit('event', ev);
  }

  /**
   * Runs as the welcome frame is read — before the replayed events that follow
   * it in the same read — so a restarted server's low seq numbers are not
   * mistaken for duplicates.
   */
  private adoptCursor(welcome: PhapWelcome): void {
    const restarted = welcome.serverInfo?.instanceId !== undefined && welcome.serverInfo.instanceId !== this.instanceId;
    this.instanceId = welcome.serverInfo?.instanceId;
    if (welcome.gap || restarted || this.lastSeq === null) this.lastSeq = welcome.lastSeq;
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (!this.ready) return;
    this.silenceTimer = setTimeout(() => {
      this.opts.log?.('phap: no heartbeat, dropping the socket');
      this.emit('dead');
      this.dropSocket('no heartbeat');
    }, 3 * (this.opts.heartbeatS ?? 10) * 1000);
  }

  private dropSocket(reason: string): void {
    const ws = this.ws;
    if (ws) {
      ws.removeAllListeners('message');
      try { ws.terminate(); } catch { /* already gone */ }
      this.onClosed(ws, reason);
    }
  }

  private onClosed(ws: WebSocket, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new PhapError(1002, 'no_link', { detail: reason })); }
    this.pending.clear();
    const was = this.ready;
    this.ready = false;
    if (was) this.emit('disconnected', reason);
    if (!this.running) return;
    const delay = Math.min((this.opts.baseDelayMs ?? 1000) * 2 ** this.attempt, this.opts.maxDelayMs ?? 30_000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
