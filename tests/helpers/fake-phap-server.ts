/**
 * A small PhAP server over a real WebSocket, standing in for telefony-app:
 * token check, one controller, a seq'd event log with resume replay,
 * heartbeats, and scripted method results. Every request is recorded.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

type Handler = (params: Record<string, unknown>) => unknown;

export class FakePhapServer {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly handlers = new Map<string, Handler>();
  private wss!: WebSocketServer;
  private log: Array<Record<string, unknown>> = [];
  private seq = 0;
  private sockets = new Set<WebSocket>();
  private hb: NodeJS.Timeout | null = null;
  heartbeats = true;
  calls: Array<{ callId: string; number: string; state: string; direction: string }> = [];

  constructor(readonly token = 'tok', readonly instanceId = 'i1', private readonly heartbeatMs = 50) {}

  get uri(): string { return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/phap`; }

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has('phap') ? 'phap' : false) });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.wss.on('connection', (ws) => this.accept(ws));
    this.hb = setInterval(() => { if (this.heartbeats) this.emit('heartbeat', {}); }, this.heartbeatMs);
  }

  async close(): Promise<void> {
    if (this.hb) clearInterval(this.hb);
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  /** Drop every socket without closing the server (simulates a network blip). */
  dropAll(): void { for (const s of this.sockets) s.terminate(); }

  emit(type: string, fields: Record<string, unknown>): void {
    const ev = { seq: ++this.seq, ts: new Date().toISOString(), type, ...fields };
    this.log.push(ev);
    for (const s of this.sockets) s.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev }));
  }

  /** Resolve when a request for `method` has been recorded. */
  async waitFor(method: string, n = 1, ms = 3000): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      const hits = this.requests.filter((r) => r.method === method);
      if (hits.length >= n) return hits[n - 1].params;
      if (Date.now() - start > ms) throw new Error(`no ${method} (#${n}); saw ${this.requests.map((r) => r.method).join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private accept(ws: WebSocket): void {
    let authed = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
      this.requests.push({ method: msg.method, params: msg.params });
      const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
      if (!authed) {
        if (msg.method !== 'hello' || msg.params.token !== this.token) {
          reply({ error: { code: -32001, message: 'unauthorized' } });
          ws.close(4401);
          return;
        }
        authed = true;
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
        const from = msg.params.resumeFrom as number | undefined;
        const gap = from !== undefined && (from > this.seq || !this.log.some((e) => e.seq === from + 1) && from < this.seq);
        reply({ result: {
          protocolVersion: '2026-10-27', serverInfo: { name: 'fake', version: '0', instanceId: this.instanceId },
          capabilities: { calls: {}, conference: {}, sms: {}, voice: { tts: true, stt: true } }, role: 'controller',
          state: { link: 'up', engine: 'ready', calls: this.calls }, lastSeq: this.seq, gap,
        } });
        if (from !== undefined && !gap) {
          for (const ev of this.log.filter((e) => (e.seq as number) > from)) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev }));
        }
        return;
      }
      const h = this.handlers.get(msg.method);
      try {
        reply({ result: h ? h(msg.params) ?? {} : {} });
      } catch (err) {
        const e = err as { code?: number; message: string };
        reply({ error: { code: e.code ?? -32603, message: e.message } });
      }
    });
  }
}
