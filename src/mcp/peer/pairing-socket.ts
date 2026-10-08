/**
 * PairingSocket — the transport SAS pairing runs over. This is the piece that was
 * missing: PeerPairing was channel-agnostic and production wired it to a channel
 * that dropped every frame, so two machines could never actually pair.
 *
 * WHY a separate path on the SAME listener: the steady-state peer link authenticates
 * with a PSK, but the PSK is precisely what pairing DERIVES — it cannot exist yet.
 * So pairing connects to `wss://host:47474/pair`, which skips the PSK handshake.
 * Reusing port 47474 means ONE firewall rule on Windows and one local-network
 * permission on macOS, rather than a second listener the user must also unblock.
 *
 * WHAT KEEPS IT SAFE without a PSK:
 *   - Each side reads the peer's cert fingerprint off ITS OWN TLS socket, and that
 *     fingerprint goes into the SAS transcript. The SAS therefore commits to the
 *     exact certificate that will later be pinned — a MITM terminating TLS presents
 *     a different cert, so the two 6-digit codes DIVERGE and the user rejects.
 *   - The `hello` frame (machineId + alias) is unauthenticated by necessity — the
 *     responder has no idea who is calling until told. It is also folded into the
 *     transcript, so tampering with it changes the SAS. Nothing is persisted until
 *     BOTH users accept a matching code.
 *   - A `/pair` socket is never upgraded to a PeerLink and can call no MCP tool.
 *     Its only capability is running the pairing state machine.
 */

import { EventEmitter } from 'node:events';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import type { ClientRequest } from 'node:http';
import { logger } from '../../utils/logger.js';
import { peerCertFpFromSocket } from './peer-crypto.js';
import type { PairingChannel, PairingMessage } from './peer-pairing.js';

/** The URL path that marks a connection as a pairing attempt, not a peer link. */
export const PAIRING_PATH = '/pair';

/** The standard peer port, used when an address or hello omits one. */
export const DEFAULT_PEER_PORT = 47474;

/** Default connect budget — a pairing dial should fail fast and visibly. */
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/**
 * Per-address budget when a peer offers several. A multi-homed peer advertises
 * adapters that are unreachable from here (vEthernet, host-only), and each dead
 * one costs its full timeout before the next is tried.
 */
const CANDIDATE_CONNECT_TIMEOUT_MS = 3000;

/** Identity announcement: who is calling. Tamper-evident via the SAS transcript. */
export interface PairingHello {
  t: 'hello';
  sessionId: string;
  machineId: string;
  alias: string;
  /**
   * The port the caller LISTENS on. Required because the socket's remote port is
   * an ephemeral source port — recording that as the peer's address would produce
   * a peer entry that can never be dialled back.
   */
  port: number;
}

/** Everything that crosses a pairing socket. */
export type PairingFrame = PairingHello | PairingMessage;

/**
 * A live pairing connection. Implements PairingChannel so a PeerPairing can write
 * straight to it; inbound frames surface as 'hello' / 'message' events.
 */
export class PairingSocket extends EventEmitter implements PairingChannel {
  constructor(
    private readonly ws: WebSocket,
    /** Fingerprint of the cert the OTHER side presented on this TLS connection. */
    readonly peerCertFp: string,
    /** Observed source host of the caller — set for inbound sockets only. */
    readonly peerHost?: string,
  ) {
    super();
    this.ws.on('message', (data) => this.onData(data));
    this.ws.on('close', () => this.emit('closed'));
    this.ws.on('error', (err: Error) => {
      logger.warn(`[PairingSocket] socket error: ${err.message}`);
      this.emit('closed');
    });
  }

  /** PairingChannel — write a pairing control frame. */
  send(msg: PairingMessage): void {
    this.write(msg);
  }

  /** Announce who we are. Sent once by the initiator before the first commit. */
  sendHello(hello: Omit<PairingHello, 't'>): void {
    this.write({ t: 'hello', ...hello });
  }

  close(): void {
    try { this.ws.close(); } catch { /* already gone */ }
  }

  private write(frame: PairingFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn(`[PairingSocket] send failed: ${(err as Error).message}`);
    }
  }

  /** Parse an inbound frame. Malformed input is dropped, never thrown. */
  private onData(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.t === 'hello') this.emit('hello', frame);
    else this.emit('message', frame);
  }
}

/** Decode a wire frame; null when it is not a well-formed pairing frame. */
function parseFrame(data: unknown): PairingFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.t === 'hello') {
    if (typeof frame.sessionId !== 'string' || typeof frame.machineId !== 'string') return null;
    return {
      t: 'hello',
      sessionId: frame.sessionId,
      machineId: frame.machineId,
      alias: typeof frame.alias === 'string' ? frame.alias : frame.machineId,
      port: typeof frame.port === 'number' && frame.port > 0 ? frame.port : DEFAULT_PEER_PORT,
    };
  }
  if (frame.t === 'pair' && typeof frame.sessionId === 'string' && typeof frame.step === 'string') {
    return parsed as PairingMessage;
  }
  return null;
}

export interface ConnectPairingSocketOptions {
  /** `host:port` as advertised by mDNS, or typed in by the user. */
  address: string;
  getCertKey: () => Promise<{ certPem: string; keyPem: string }>;
  connectTimeoutMs?: number;
}

/**
 * Dial a peer's `/pair` endpoint. Deliberately does NOT verify a pin: on a first
 * pairing there is nothing pinned yet, and the cert we observe here is bound into
 * the SAS the user compares. Re-pairing an already-pinned peer is likewise allowed —
 * the pin is checked at finalize, where a mismatch aborts with nothing persisted.
 */
export async function connectPairingSocket(opts: ConnectPairingSocketOptions): Promise<PairingSocket> {
  const { host, port } = splitAddress(opts.address);
  const cert = await opts.getCertKey();

  let capturedTls: TLSSocket | null = null;
  const ws = new WebSocket(`wss://${host}:${port}${PAIRING_PATH}`, {
    cert: cert.certPem,
    key: cert.keyPem,
    rejectUnauthorized: false,
    finishRequest: (request: ClientRequest) => {
      request.on('socket', (socket) => {
        const tls = socket as TLSSocket;
        const capture = (): void => { capturedTls = tls; request.end(); };
        if ((tls as unknown as { _secureEstablished?: boolean })._secureEstablished) capture();
        else tls.once('secureConnect', capture);
      });
    },
  });

  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } }, timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('close', () => reject(new Error(`pairing connect to ${opts.address} closed before open`)));
      ws.once('error', (err) => reject(err));
    });
  } finally {
    clearTimeout(timer);
  }

  if (!capturedTls) {
    try { ws.terminate(); } catch { /* */ }
    throw new Error('no TLS socket captured for pairing connection');
  }

  return new PairingSocket(ws, peerCertFpFromSocket(capturedTls));
}

/** The half of a pairing a transport drives: frames in, teardown on disconnect. */
interface SocketDrivenPairing {
  handleMessage(msg: PairingMessage): void;
  cancel(reason?: string): void;
}

/**
 * Route a socket into its pairing. The `closed` half is what makes cancel and
 * reject reliable: the side that aborts closes its socket, and this turns that
 * into an immediate failure here rather than a session that waits out its TTL.
 */
export function bindPairingSocket(socket: PairingSocket, pairing: SocketDrivenPairing): void {
  socket.on('message', (msg: PairingMessage) => pairing.handleMessage(msg));
  socket.once('closed', () => pairing.cancel('peer-disconnected'));
}

export interface OutboundPairingChannelOptions {
  /** Mutated in place: cert fingerprint and the address that actually answered. */
  peer: { machineId: string; alias: string; certFp: string; address: string; candidateAddresses?: string[] };
  sessionId: string;
  self: { machineId: string; alias: string; port: number };
  connect: (opts: ConnectPairingSocketOptions) => Promise<PairingSocket>;
  getCertKey: () => Promise<{ certPem: string; keyPem: string }>;
  /** Notified when an address-only peer reveals who it is (for the UI). */
  onPeerIdentified?: (hello: PairingHello) => void;
}

/**
 * The initiator's channel. PeerPairing is synchronous but dialling is not, so
 * frames written before the socket opens are QUEUED and flushed on connect —
 * `begin()` fires its commit immediately after construction and must not be lost.
 *
 * On connect it fills in `peer.certFp` from the observed TLS certificate. That is
 * the whole point: the SAS then commits to the cert we actually talked to, so a
 * MITM shows up as a mismatched code rather than a silent interception.
 */
export class OutboundPairingChannel implements PairingChannel {
  private socket: PairingSocket | null = null;
  private queue: PairingMessage[] = [];
  private failed = false;
  private closed = false;
  private pairing: SocketDrivenPairing | null = null;

  constructor(private readonly opts: OutboundPairingChannelOptions) {
    void this.open();
  }

  /** Route inbound frames into the pairing once it exists (built after us). */
  attach(pairing: SocketDrivenPairing): void {
    this.pairing = pairing;
    if (this.failed) pairing.cancel('connect-failed');
  }

  send(msg: PairingMessage): void {
    if (this.failed) return;
    if (this.socket) this.socket.send(msg);
    else this.queue.push(msg);
  }

  /** Safe mid-dial: the socket is closed the moment it opens, and no further address is tried. */
  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  /** Dial each candidate in order; the first that answers wins. */
  private async dial(): Promise<PairingSocket> {
    const { peer } = this.opts;
    const candidates = peer.candidateAddresses?.length ? peer.candidateAddresses : [peer.address];
    let lastError: unknown = new Error('no address to dial');
    for (const address of candidates) {
      if (this.closed) break;
      try {
        const socket = await this.opts.connect({
          address,
          getCertKey: this.opts.getCertKey,
          connectTimeoutMs: candidates.length > 1 ? CANDIDATE_CONNECT_TIMEOUT_MS : undefined,
        });
        peer.address = address;
        return socket;
      } catch (err) {
        lastError = err;
        logger.warn(`[PairingChannel] Could not reach ${address}: ${(err as Error).message}`);
      }
    }
    throw lastError;
  }

  private async open(): Promise<void> {
    try {
      const socket = await this.dial();
      if (this.closed) {
        socket.close();
        return;
      }
      // Bind the SAS to the certificate actually presented on this connection.
      this.opts.peer.certFp = socket.peerCertFp;
      // A peer added by typed-in address has no known machineId (mDNS is how we
      // normally learn it), so adopt the one it announces. Never overwrite a
      // machineId we already knew — that would let a responder redirect a pairing
      // the user started against a specific discovered machine.
      socket.once('hello', (hello: PairingHello) => {
        if (!this.opts.peer.machineId) {
          this.opts.peer.machineId = hello.machineId;
          if (!this.opts.peer.alias) this.opts.peer.alias = hello.alias;
          this.opts.onPeerIdentified?.(hello);
        }
      });
      bindPairingSocket(socket, {
        handleMessage: (msg) => this.pairing?.handleMessage(msg),
        cancel: (reason) => this.pairing?.cancel(reason),
      });
      socket.sendHello({
        sessionId: this.opts.sessionId,
        machineId: this.opts.self.machineId,
        alias: this.opts.self.alias,
        port: this.opts.self.port,
      });
      this.socket = socket;
      for (const queued of this.queue.splice(0)) socket.send(queued);
    } catch {
      this.failed = true;
      this.queue = [];
      this.pairing?.cancel('connect-failed');
    }
  }
}

/** Split `host:port`, defaulting to the standard peer port when none is given. */
export function splitAddress(address: string, defaultPort = DEFAULT_PEER_PORT): { host: string; port: number } {
  const trimmed = address.trim();
  // IPv6 literal form: [::1]:47474
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: defaultPort };
  const port = Number(trimmed.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0) return { host: trimmed, port: defaultPort };
  return { host: trimmed.slice(0, idx), port };
}
