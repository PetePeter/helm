/**
 * socket-link-transport — the LAN half of the phone link. The only file here
 * that touches a socket.
 *
 * DIRECTION IS INVERTED FROM BLE, deliberately. Over BLE, Helm is the central
 * and dials the phone. Over LAN, Helm LISTENS and the phone dials in — a phone's
 * address is a DHCP lease and a sleeping radio, while the desktop's is stable
 * enough to be worth knowing. That is also why no address is configured here:
 * Helm binds a port, and the phone is the end that holds an address.
 *
 * PAIRING NEVER HAPPENS HERE. Physical proximity is the trust anchor (P-0752),
 * so a socket may only ever carry a handshake against an ALREADY stored PSK.
 * This file cannot enforce that by itself — `MobileLinkManager` offers a link to
 * the pairing coordinator only while pairing is armed, and pairing is armed only
 * over BLE — but anything added here that would let a stranger pair is a bug.
 *
 * What escapes this file is a `MobileLink`, exactly as `BleLinkClient` produces.
 * SecureChannel does its own length-prefixed framing and tolerates partial
 * frames, so a TCP stream needs no chunker: this is a genuinely thin wrapper,
 * and if it ever stops being one, the abstraction has leaked.
 *
 * Per invariant 7's spirit, socket errors are logged and surfaced as a closed
 * link, never thrown into the session layer.
 */

import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { logger } from '../../utils/logger.js';
import { normalizeHost } from '../../mcp/peer/peer-address.js';
import { RANK_LAN, type MobileLink } from '../mobile-link.js';
import type { BytePipe } from '../secure-channel.js';

/**
 * The port Helm listens on for phones. Distinct from the fleet listener's
 * 47474: they carry different protocols to different kinds of peer, and sharing
 * a port would make a firewall rule mean two things at once.
 */
export const DEFAULT_MOBILE_LAN_PORT = 47475;

/** Bind every interface: which one the phone arrives on is not ours to guess. */
const DEFAULT_HOST = '0.0.0.0';

export interface SocketLinkTransportOptions {
  /** 0 binds an ephemeral port — used by tests, never in production. */
  port?: number;
  host?: string;
  /** Off binds nothing at all. Defaults to on; the caller supplies the policy. */
  enabled?: boolean;
  logger?: (message: string, error?: unknown) => void;
}

/** The live half of the settings: what a user can change without a restart. */
export interface MobileLanTransportConfig {
  enabled: boolean;
  port: number;
}

/**
 * Accepts phone connections and emits a `MobileLink` per connection.
 *
 * Events: `link` (MobileLink), `disconnected` (deviceId).
 */
export class SocketLinkTransport extends EventEmitter {
  /** The fast transport: it displaces a live BLE link. See RANK_LAN. */
  readonly rank = RANK_LAN;

  /**
   * A TCP source port is ephemeral, so this address is worthless as a reconnect
   * hint — and worse than worthless if persisted, because it would evict the
   * BLE peripheral id that BLE candidate ranking depends on. One LAN connection
   * would then degrade every later BLE reconnect.
   */
  readonly persistsAddressHint = false;

  private port: number;
  private enabled: boolean;
  private readonly host: string;
  private readonly log: (message: string, error?: unknown) => void;

  private server: Server | null = null;
  /** Whether the manager wants this transport running, independent of config. */
  private wanted = false;
  /** Live sockets, so `stop` can close what `close` alone would leave hanging. */
  private readonly sockets = new Set<Socket>();

  constructor(options: SocketLinkTransportOptions = {}) {
    super();
    this.port = options.port ?? DEFAULT_MOBILE_LAN_PORT;
    this.enabled = options.enabled ?? true;
    this.host = options.host ?? DEFAULT_HOST;
    this.log = options.logger ?? ((message, error) => {
      if (error === undefined) logger.info(`[MobileLan] ${message}`);
      else logger.warn(`[MobileLan] ${message}: ${describe(error)}`);
    });
  }

  /** The port actually bound. Differs from `port` when 0 was requested. */
  get boundPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  /**
   * Apply a settings change without a restart.
   *
   * TWO conditions gate the port: the manager wants the transport running (there
   * is a phone to reach) and the user has enabled LAN. Either going false
   * unbinds; both true rebinds. A port change is an unbind and a rebind, because
   * there is no way to move a listening socket.
   */
  async configure(config: MobileLanTransportConfig): Promise<void> {
    if (config.enabled === this.enabled && config.port === this.port) return;
    this.enabled = config.enabled;
    this.port = config.port;
    await this.unbind();
    if (this.wanted) await this.start();
  }

  /** Bind and accept, if enabled. Idempotent — a second call does nothing. */
  async start(): Promise<void> {
    this.wanted = true;
    if (this.server) return;
    if (!this.enabled) {
      this.log('the LAN transport is disabled; binding nothing');
      return;
    }
    const server = createServer((socket) => this.accept(socket));
    // A listener that fails after binding must not take the process with it.
    server.on('error', (error) => this.log('the LAN listener failed', error));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        // A bind failure is the one error that must reach the caller, because
        // nothing will ever arrive on a port that was never taken.
        server.off('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.log(`listening for phones on ${this.host}:${this.boundPort}`);
  }

  /**
   * Unbind and drop every live connection. Idempotent.
   *
   * Closing the server alone only stops NEW connections; an established socket
   * would keep the process alive and keep a phone believing it had a link.
   */
  async stop(): Promise<void> {
    this.wanted = false;
    await this.unbind();
  }

  /** Release the port and every live connection, without forgetting intent. */
  private async unbind(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Disconnect a link the manager refused. */
  async reject(link: MobileLink, reason: string): Promise<void> {
    this.log(`refusing ${link.deviceId}: ${reason}`);
    link.pipe.close();
  }

  /** A retired socket is closed the same way a refused one is — no cooldown to skip. */
  async disconnect(link: MobileLink, reason: string): Promise<void> {
    this.reject(link, reason);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    // Terminal framing is the application's job; Nagle only adds latency to the
    // small, chatty frames a handshake is made of.
    socket.setNoDelay(true);
    const deviceId = describePeer(socket);
    const link = new SocketLink(deviceId, socket);

    socket.on('error', (error) => {
      // A reset peer is ordinary, not exceptional: it arrives as an error and
      // must land as a close, or an unhandled 'error' takes the process down.
      this.log(`the link to ${deviceId} failed`, error);
      socket.destroy();
    });
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.emit('disconnected', deviceId);
    });

    this.log(`accepted a phone connection from ${deviceId}`);
    this.emit('link', link);
  }
}

/**
 * One connected phone over TCP, presented as the `BytePipe` SecureChannel
 * consumes. No framing, no chunking, no buffering — the stream is the pipe.
 */
class SocketLink implements MobileLink {
  constructor(
    readonly deviceId: string,
    private readonly socket: Socket,
  ) {}

  get pipe(): BytePipe {
    return this;
  }

  write(data: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(data);
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.socket.on('data', handler);
  }

  onClose(handler: () => void): void {
    this.socket.once('close', handler);
  }

  close(): void {
    this.socket.destroy();
  }

  onFramingDrop(): void {
    // TCP does not lose bytes within a connection; it loses the whole
    // connection. There is no partial-delivery failure mode to report.
  }
}

/**
 * Name the peer for logs and refusals. The source port is included because two
 * connections from one phone are otherwise indistinguishable in a log — but
 * this string is NEVER an identity, and never persisted (persistsAddressHint).
 */
function describePeer(socket: Socket): string {
  const host = normalizeHost(socket.remoteAddress ?? 'unknown');
  return `${host}:${socket.remotePort ?? 0}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
