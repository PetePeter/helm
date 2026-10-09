/**
 * PeerLinkManager — orchestrates the fleet transport for every configured
 * peer. It owns ONE RemoteLinkServer (accepts inbound from all peers) plus ONE
 * RemoteLinkClient per outbound/bidirectional peer (dials that peer), and keeps
 * exactly ONE authenticated full-duplex link per peer.
 *
 * DEDUP (the hard part): two Helms that both dial each other can momentarily hold
 * TWO links for the same unordered machine pair. We keep the link whose
 * authenticated initiatorId === min(machineIdLocal, machineIdPeer) and drop the
 * other. Because an OUTBOUND link is one WE initiated (initiatorId = local) and
 * an INBOUND link is one the PEER initiated (initiatorId = peer), the rule
 * reduces to: local is the min ⇒ prefer OUTBOUND; else prefer INBOUND. The
 * preferred arrival always replaces a non-preferred incumbent; a non-preferred
 * arrival loses immediately. A duplicate close must NOT trigger a reconnect while
 * another active link for that peer still exists (the client's hasActiveLink
 * hook enforces this).
 *
 * The server/client constructors are INJECTABLE so the dedup + routing logic is
 * unit-testable with fakes; production wires the real Remote* classes.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../../utils/logger.js';
import type { PeerConfig } from '../../types/peer.js';
import type { PinnedCertStore } from './pinned-cert-store.js';
import type { OnCall, PeerLink } from './peer-link.js';
import { RemoteLinkServer, type RemoteLinkServerOptions } from './remote-link-server.js';
import { RemoteLinkClient, type RemoteLinkClientOptions } from './remote-link-client.js';
import { normalizePeerAddress, splitHostPort } from './peer-address.js';
import { FLEET_SESSIONS_METHOD } from './fleet-sessions.js';

/** The minimal PeerLink surface the manager depends on (real PeerLink satisfies). */
export interface ManagedLink {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  isOnline(): boolean;
  dispose(reason: string): void;
  on(event: 'offline' | 'notification', listener: (...args: any[]) => void): unknown;
  once(event: 'offline', listener: (...args: any[]) => void): unknown;
}

export interface ManagedServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ManagedClient {
  connect(): void;
  dispose(reason?: string): void;
  isConnected(): boolean;
}

export interface PeerLinkManagerOptions {
  machineId: string;
  listPeers: () => PeerConfig[];
  resolvePsk: (peerId?: string) => Buffer | undefined;
  getCertKey: () => Promise<{ certPem: string; keyPem: string }>;
  pinnedCertStore: PinnedCertStore;
  onCall: OnCall;
  /**
   * Inbound SAS pairing on the server's PAIRING_PATH. Passed straight through —
   * the manager never touches pairing sockets, they become no link and no client.
   */
  onPairingConnection?: RemoteLinkServerOptions['onPairingConnection'];
  host?: string;
  port?: number;
  /** Factories (injected in tests; default to the real Remote* classes). */
  createServer?: (opts: RemoteLinkServerOptions) => ManagedServer;
  createClient?: (opts: RemoteLinkClientOptions) => ManagedClient;
}

/** One peer as `peer_list` shows it: identity, link state and both access halves. */
export interface PeerSummary {
  id: string;
  alias: string;
  direction: PeerConfig['direction'];
  online: boolean;
  /** My grant: this peer may call me. */
  mayCallMe: boolean;
  /** The peer's grant as it last reported: I may call it (spawn/attach there). */
  mayCallThem: boolean;
}

type Origin = 'inbound' | 'outbound';

interface LinkEntry {
  link: ManagedLink;
  origin: Origin;
}

export class PeerLinkManager extends EventEmitter {
  private server: ManagedServer | null = null;
  private readonly clients = new Map<string, ManagedClient>();
  /** The address each client was dialled at, so syncPeers can spot a move. */
  private readonly dialledAddresses = new Map<string, string>();
  /** The single authenticated link per peerId (post-dedup). */
  private readonly links = new Map<string, LinkEntry>();
  private onCall: OnCall;
  private stopped = true;

  constructor(private readonly opts: PeerLinkManagerOptions) {
    super();
    this.onCall = opts.onCall;
  }

  /** Bind the inbound server and dial every outbound/bidirectional peer. */
  async start(): Promise<void> {
    this.stopped = false;
    const createServer = this.opts.createServer ?? ((o) => new RemoteLinkServer(o));
    const createClient = this.opts.createClient ?? ((o) => new RemoteLinkClient(o));

    this.server = createServer({
      host: this.opts.host,
      port: this.opts.port,
      machineId: this.opts.machineId,
      getCertKey: this.opts.getCertKey,
      resolvePsk: this.opts.resolvePsk,
      pinnedCertStore: this.opts.pinnedCertStore,
      onCall: (peerId, method, params) => this.onCall(peerId, method, params),
      onPairingConnection: this.opts.onPairingConnection,
      // An inbound connection presents a cert before claiming any identity, so its
      // PIN is the only thing that can name the peer — and therefore the only way
      // to pick the PSK its handshake must run with. Omitting this resolver made
      // the server resolve `undefined`, find no PSK, and reject EVERY inbound
      // peer: a fully-paired fleet that permanently displayed "offline".
      resolveExpectedPeer: (certFp) => this.opts.pinnedCertStore.findPeerIdByFingerprint(certFp),
      onLink: (link, peerId, peerMachineId) =>
        this.acceptLink(link as unknown as ManagedLink, peerId, 'inbound', peerMachineId),
    });
    await this.server.start();

    this.syncPeers();
  }

  /**
   * Reconcile the dialled clients against the CURRENT registry. This is the single
   * entry point for every runtime change — a fresh pairing, a manual edit, a
   * discovered address change — so the transport converges without an app restart:
   *
   *   - a peer with no client is dialled (the just-paired case)
   *   - a peer whose address moved is re-dialled at the new one
   *   - a peer that is gone, disabled, or inbound-only is dropped
   *   - anything unchanged is left strictly alone, because mDNS re-announces
   *     constantly and churning a healthy link on every announcement is worse
   *     than a stale address
   */
  syncPeers(): void {
    if (this.stopped || !this.server) return; // not running yet
    const peers = this.opts.listPeers();
    const wanted = new Map<string, PeerConfig>();
    for (const peer of peers) {
      if (peer.direction === 'inbound') continue; // no outbound dial
      if (!isPeerEnabled(peer)) continue;         // disabled peers are never dialled
      wanted.set(peer.id, peer);
    }

    for (const peerId of [...this.clients.keys()]) {
      const peer = wanted.get(peerId);
      if (!peer) { this.dropClient(peerId, 'peer-removed'); continue; }
      if (this.dialledAddresses.get(peerId) !== normalizePeerAddress(peer.address)) {
        this.dropClient(peerId, 'peer-address-changed');
      }
    }

    for (const peer of wanted.values()) {
      if (this.clients.has(peer.id)) continue; // already dialling at this address
      this.dial(peer);
    }
  }

  /**
   * Dial a peer that was JUST paired at runtime, without a full restart. Thin
   * wrapper over syncPeers so a single new pin does not force a global reconnect
   * to be reasoned about separately.
   */
  addPeer(peer: PeerConfig): void {
    if (this.stopped || !this.server) return; // not running yet
    if (peer.direction === 'inbound') return; // no outbound dial
    if (!isPeerEnabled(peer)) return;         // disabled peers are never dialled
    if (this.clients.has(peer.id)) return;    // already dialling
    this.dial(peer);
  }

  /** Tear everything down. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const client of this.clients.values()) client.dispose('manager-stop');
    this.clients.clear();
    this.dialledAddresses.clear();
    for (const entry of this.links.values()) entry.link.dispose('manager-stop');
    this.links.clear();
    if (this.server) { await this.server.stop(); this.server = null; }
  }

  /**
   * Tear down a SINGLE peer's live transport without touching its config: dispose
   * any authenticated link (inbound or outbound) and stop dialling it. Used when a
   * peer is disabled at runtime so "Off" drops the live link immediately in both
   * directions. Removing the outbound client also frees a later addPeer() to
   * re-dial the same peer once it is re-enabled (addPeer is a no-op while a client
   * already exists). Idempotent.
   */
  disposePeer(peerId: string): void {
    this.dropClient(peerId, 'peer-disabled');
    const entry = this.links.get(peerId);
    if (entry) {
      // dispose → 'offline' → onLinkOffline deletes the map entry + emits offline.
      entry.link.dispose('peer-disabled');
      this.links.delete(peerId);
    }
    logger.info(`[PeerLinkManager] Disposed live transport for peer ${peerId}`);
  }

  /** Replace the inbound-call sink (used by links created AFTER this call). */
  setOnCall(sink: OnCall): void {
    this.onCall = sink;
  }

  /** 'online' iff an authenticated link for `peerId` is currently up. */
  status(peerRef: string): 'online' | 'offline' {
    const entry = this.links.get(this.resolvePeerRef(peerRef));
    return entry && entry.link.isOnline() ? 'online' : 'offline';
  }

  /**
   * Map a peer reference to its config id. Callers legitimately hold either —
   * `peer_list` surfaces both, and an alias is what a human or an AI reaches for.
   * Live links are keyed by ID ONLY, so without this an alias produced a
   * "No live link" error for a perfectly healthy peer.
   *
   * An exact id always wins, so one peer aliasing another's id can never hijack
   * a call. An alias shared by several peers is NOT guessed at — the reference is
   * returned unresolved and `call()` raises an explicit ambiguity error.
   */
  private resolvePeerRef(peerRef: string): string {
    const peers = this.opts.listPeers();
    if (peers.some((p) => p.id === peerRef)) return peerRef;
    const needle = peerRef.trim().toLowerCase();
    const matches = peers.filter((p) => (p.alias ?? '').trim().toLowerCase() === needle);
    return matches.length === 1 ? matches[0].id : peerRef;
  }

  /** The configured peer id `peerRef` names (id or unique alias), or undefined. */
  peerIdFor(peerRef: string): string | undefined {
    const peerId = this.resolvePeerRef(peerRef);
    return this.opts.listPeers().some((p) => p.id === peerId) ? peerId : undefined;
  }

  /** Peers sharing `peerRef` as an alias — used to reject an ambiguous call. */
  private aliasMatches(peerRef: string): PeerConfig[] {
    const needle = peerRef.trim().toLowerCase();
    return this.opts.listPeers().filter((p) => (p.alias ?? '').trim().toLowerCase() === needle);
  }

  /**
   * A snapshot of every configured peer with its current link status. Combines
   * the injected config source (identity/direction) with the live per-peer
   * `status()`. Latency is intentionally omitted — no link tracks pong RTT yet.
   */
  list(): PeerSummary[] {
    return this.opts.listPeers().map((peer) => ({
      id: peer.id,
      alias: peer.alias,
      direction: peer.direction,
      online: this.status(peer.id) === 'online',
      mayCallMe: peer.inbound,
      mayCallThem: peer.peerAllowsMe === true,
    }));
  }

  /** Ids of every peer with a live authenticated link. */
  onlinePeerIds(): string[] {
    return [...this.links].filter(([, e]) => e.link.isOnline()).map(([id]) => id);
  }

  /**
   * Invoke `method` on a peer over its live link. `peerRef` is the peer's id or
   * its alias. Rejects if the reference is ambiguous or no live link exists.
   */
  call(peerRef: string, method: string, params: unknown): Promise<unknown> {
    const peerId = this.resolvePeerRef(peerRef);
    const entry = this.links.get(peerId);
    if (!entry || !entry.link.isOnline()) {
      // Distinguish "you named several peers" from "the peer is down" — they need
      // completely different responses from the caller.
      const ambiguous = this.aliasMatches(peerRef);
      if (ambiguous.length > 1 && !this.links.has(peerRef)) {
        return Promise.reject(new Error(
          `Ambiguous peer "${peerRef}" — ${ambiguous.length} peers share that alias; use an id: ${ambiguous.map((p) => p.id).join(', ')}`,
        ));
      }
      return Promise.reject(new Error(`No live link to peer ${peerRef}`));
    }
    return entry.link.request(method, params);
  }

  /**
   * Fire-and-forget notification to a peer's live link. Returns false when no
   * live link exists — streams treat that as "peer gone", never as an error.
   */
  notify(peerRef: string, method: string, params: unknown): boolean {
    const entry = this.links.get(this.resolvePeerRef(peerRef));
    if (!entry || !entry.link.isOnline()) return false;
    entry.link.notify(method, params);
    return true;
  }

  // ---------------------------------------------------------------- internals

  /** Create + connect the outbound client for `peer`, recording its address. */
  private dial(peer: PeerConfig): void {
    const createClient = this.opts.createClient ?? ((o) => new RemoteLinkClient(o));
    const address = normalizePeerAddress(peer.address);
    const [host, portStr] = splitHostPort(address);
    const client = createClient({
      peerId: peer.id,
      host,
      port: Number(portStr) || (this.opts.port ?? 47474),
      machineId: this.opts.machineId,
      getCertKey: this.opts.getCertKey,
      resolvePsk: (id) => this.opts.resolvePsk(id),
      pinnedCertStore: this.opts.pinnedCertStore,
      onCall: (pid, method, params) => this.onCall(pid, method, params),
      onLink: (link, peerId, peerMachineId) =>
        this.acceptLink(link as unknown as ManagedLink, peerId, 'outbound', peerMachineId),
      hasActiveLink: () => this.links.has(peer.id) && this.links.get(peer.id)!.link.isOnline(),
    });
    this.clients.set(peer.id, client);
    this.dialledAddresses.set(peer.id, address);
    client.connect();
    logger.info(`[PeerLinkManager] Dialing peer ${peer.id} at ${address}`);
  }

  /** Stop dialling a peer and forget the address we were dialling it at. */
  private dropClient(peerId: string, reason: string): void {
    this.clients.get(peerId)?.dispose(reason);
    this.clients.delete(peerId);
    this.dialledAddresses.delete(peerId);
  }

  /**
   * Register a newly-authenticated link, resolving the dedup contest against any
   * incumbent for the same peer. Returns nothing; the loser is disposed.
   */
  private acceptLink(link: ManagedLink, peerId: string, origin: Origin, peerMachineId?: string): void {
    const incumbent = this.links.get(peerId);
    if (incumbent && incumbent.link.isOnline()) {
      const preferNew = this.isPreferred(peerId, origin, peerMachineId);
      if (!preferNew) {
        // The arriving link loses — drop it, keep the incumbent.
        link.dispose('dedup-lost');
        logger.info(`[PeerLinkManager] Dropped non-preferred ${origin} link to ${peerId}`);
        return;
      }
      // The arriving link wins — replace the incumbent.
      logger.info(`[PeerLinkManager] Preferred ${origin} link to ${peerId} replaces incumbent`);
      this.detach(peerId, incumbent);
      incumbent.link.dispose('dedup-replaced');
    }

    this.links.set(peerId, { link, origin });
    link.once('offline', () => this.onLinkOffline(peerId, link));
    // Notifications normally use their owning stream's authorization. The
    // fleet.sessions snapshot is the state-bearing exception and goes through
    // the configured gate callback's notification path.
    link.on('notification', (method: string, params: unknown) => {
      if (this.links.get(peerId)?.link !== link) return;
      // Fleet snapshots must pass pairing, enabled-peer, and inbound-grant
      // checks. The gate treats them as coalesced state, not tool calls.
      if (method === FLEET_SESSIONS_METHOD) {
        void Promise.resolve().then(() => this.onCall(peerId, method, params)).catch(() => undefined);
        return;
      }
      this.emit('peer-notification', { peerId, method, params });
    });
    this.emit('peer-link:online', { peerId });
  }

  /**
   * Whether an arriving link of `origin` is preferred over the incumbent. The
   * preferred initiator is min(localMachineId, peerMachineId): local-min ⇒ the
   * OUTBOUND link (we initiated) wins, peer-min ⇒ the INBOUND link (peer
   * initiated) wins.
   *
   * `peerMachineId` is the identity the peer PROVED in the handshake. It is the
   * authoritative comparison key; we only fall back to the config/registry
   * `peerId` string if the wire machineId is unavailable (older callers / tests).
   */
  private isPreferred(peerId: string, origin: Origin, peerMachineId?: string): boolean {
    const peerKey = peerMachineId && peerMachineId.length > 0 ? peerMachineId : peerId;
    const localIsMin = this.opts.machineId < peerKey;
    const preferredOrigin: Origin = localIsMin ? 'outbound' : 'inbound';
    return origin === preferredOrigin;
  }

  private onLinkOffline(peerId: string, link: ManagedLink): void {
    const entry = this.links.get(peerId);
    // Only clear if THIS link is still the registered one (a replaced link's
    // late offline must not evict its successor).
    if (entry && entry.link === link) {
      this.links.delete(peerId);
      this.emit('peer-link:offline', { peerId });
    }
  }

  private detach(peerId: string, entry: LinkEntry): void {
    if (this.links.get(peerId) === entry) this.links.delete(peerId);
  }
}

/** Default-true enabled check: `undefined` counts as enabled, only `false` disables. */
function isPeerEnabled(peer: PeerConfig): boolean {
  return peer.enabled !== false;
}
