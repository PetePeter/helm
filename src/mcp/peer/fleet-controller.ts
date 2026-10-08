/**
 * FleetController — owns the LIVE cross-machine fleet runtime (the peer
 * TRANSPORT + the mDNS DISCOVERY/PAIRING coordinator) and turns it on/off from an
 * in-app config toggle WITHOUT an app restart (P-0658). This mirrors exactly how
 * LocalhostMcpServer.applyConfig hot-applies the localhost MCP server.
 *
 * WHY a controller rather than re-running the IPC setup: `ipcMain.handle` throws
 * if a channel is registered twice, so the pairing / peer-management IPC handlers
 * must be registered EXACTLY ONCE for the app lifetime. Those handlers read live
 * state through closures (isEnabled(), getLinkManager(), getPairingRuntime()); the
 * controller only ever starts/stops the transport + discovery, never IPC.
 *
 * The shared trust stores (pins/secrets/peer registry) are INJECTED and created
 * once by the caller, so they persist across every toggle — enable → disable →
 * enable never loses a pairing.
 */

import { hostname } from 'node:os';
import { logger } from '../../utils/logger.js';
import { getOrCreateMachineIdentity, getOrCreateSelfSignedCert } from './peer-crypto.js';
import { PeerDiscovery, type DiscoveredPeer } from './peer-discovery.js';
import { PairingCoordinator } from './pairing-coordinator.js';
import { PeerPairing, type PairingPeerInfo, type PairingChannel } from './peer-pairing.js';
import {
  OutboundPairingChannel,
  connectPairingSocket,
  bindPairingSocket,
  type PairingSocket,
  type PairingHello,
  type ConnectPairingSocketOptions,
} from './pairing-socket.js';
import { startFleetIfEnabled } from './fleet-startup.js';
import { reachableAddresses } from './reachable-addresses.js';
import { normalizePeerAddress, planAddressRefresh } from './peer-address.js';
import type { PinnedCertStore } from './pinned-cert-store.js';
import type { SecretStore } from './secret-store.js';
import type { PeerConfigManager } from '../../session/peer-config-manager.js';
import type { PeerLinkManager } from './peer-link-manager.js';
import type { OnCall } from './peer-link.js';

export interface FleetConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/** Live state of the fleet stack, for display. */
export interface FleetStatus {
  enabled: boolean;
  running: boolean;
  /** Why the stack is not running, when it should be. Null while healthy. */
  error: string | null;
  /** Addresses another machine can pair against (wildcard binds are expanded). */
  addresses: string[];
  allInterfaces: boolean;
}

/**
 * The live pairing runtime the pairing IPC handlers reach into when fleet is
 * running: the map of currently-discovered peers + the coordinator that drives a
 * SAS session. Null when fleet is off.
 */
export interface PairingRuntime {
  discovered: Map<string, DiscoveredPeer>;
  coordinator: PairingCoordinator;
}

/**
 * A discovery unit the controller can start/stop. Wraps a PeerDiscovery + a
 * PairingCoordinator and exposes the runtime the pairing handlers consume.
 */
export interface FleetDiscovery {
  start(): void;
  stop(): void;
  runtime(): PairingRuntime;
}

type StartTransport = (
  cfg: FleetConfig,
  onCall: OnCall,
  stores: { pinnedCertStore: PinnedCertStore; secretStore: SecretStore },
  onPairingConnection?: (socket: PairingSocket) => void,
) => Promise<PeerLinkManager | null>;

export interface FleetControllerDeps {
  getConfig: () => FleetConfig;
  onCall: OnCall;
  pinnedCertStore: PinnedCertStore;
  secretStore: SecretStore;
  peerConfigManager: PeerConfigManager;
  /** Wire (or clear, with null) the live transport into the peer_* MCP tools. */
  setLinkManager: (mgr: PeerLinkManager | null) => void;
  /** Injectable for tests. Defaults to the real startFleetIfEnabled. */
  startTransport?: StartTransport;
  /** Injectable for tests. Defaults to the real PeerDiscovery + coordinator wiring. */
  makeDiscovery?: (cfg: FleetConfig) => FleetDiscovery | null;
  /** Override the whole outbound channel (tests only; production builds the real one). */
  createChannel?: (peer: PairingPeerInfo, sessionId: string) => PairingChannel;
  /** Override just the dial step (tests only). */
  connectPairing?: (opts: ConnectPairingSocketOptions) => Promise<PairingSocket>;
  /** mDNS advertise alias. */
  alias?: string;
  /** Broadcast a pairing/discovery event to every renderer. */
  broadcast?: (channel: string, payload: unknown) => void;
}

export class FleetController {
  private currentManager: PeerLinkManager | null = null;
  private currentDiscovery: FleetDiscovery | null = null;
  /** Adopts inbound pairing sockets while fleet is live; null when off. */
  private inboundPairingSink: ((socket: PairingSocket) => void) | null = null;
  private readonly startTransport: StartTransport;
  private readonly makeDiscovery: (cfg: FleetConfig) => FleetDiscovery | null;
  /** Serializes applyConfig so two quick toggles can't interleave teardown/startup. */
  private applyChain: Promise<void> = Promise.resolve();
  /** Last startup failure, surfaced to the UI rather than buried in a log file. */
  private lastError: string | null = null;

  constructor(private readonly deps: FleetControllerDeps) {
    this.startTransport = deps.startTransport ?? startFleetIfEnabled;
    this.makeDiscovery = deps.makeDiscovery ?? ((cfg) => this.buildRealDiscovery(cfg));
  }

  /**
   * Reconcile the live runtime with the current config. FIRST tears the current
   * runtime down, THEN (if enabled) starts a fresh transport + discovery. Idempotent
   * and safe to call repeatedly; concurrent calls are serialized.
   */
  applyConfig(): Promise<void> {
    const run = this.applyChain.then(() => this.doApply());
    // Keep the chain alive even if this apply rejects, so the next call still runs.
    this.applyChain = run.catch(() => { /* swallow — surfaced to the caller of run */ });
    return run;
  }

  private async doApply(): Promise<void> {
    // Tear down whatever is live now (transport + discovery + link wiring).
    await this.teardown();
    this.lastError = null;

    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      logger.info('[fleet] Disabled — no transport, no discovery');
      return;
    }

    try {
      await this.startStack(cfg);
    } catch (err) {
      this.lastError = (err as Error)?.message ?? String(err);
      logger.error(`[fleet] Failed to start: ${this.lastError}`);
      throw err;
    }
  }

  /** Bring up discovery + transport for an enabled config. */
  private async startStack(cfg: FleetConfig): Promise<void> {

    // Discovery is built BEFORE the transport: the transport's listener starts
    // accepting inbound pairing sockets the moment it binds, and those need a live
    // coordinator to hand them to. Building the other way round drops the first
    // pairing attempt of every session.
    this.currentDiscovery = this.makeDiscovery(cfg);

    this.currentManager = await this.startTransport(
      cfg,
      this.deps.onCall,
      { pinnedCertStore: this.deps.pinnedCertStore, secretStore: this.deps.secretStore },
      (socket) => this.inboundPairingSink?.(socket),
    );
    this.deps.setLinkManager(this.currentManager);

    // A successful SAS pairing writes the new peer into the registry — but nothing
    // dialled it, so a freshly-paired fleet sat at "offline" until the app was
    // restarted. Reconciling on 'peer-config:changed' covers pairing, a manual
    // edit, and a discovered address change through ONE path.
    this.deps.peerConfigManager.on('peer-config:changed', this.onPeerConfigChanged);

    this.currentDiscovery?.start();
    logger.info(`[fleet] Started transport + discovery on ${cfg.host}:${cfg.port}`);
  }

  /** Stop the live transport + discovery and clear the link wiring. */
  private async teardown(): Promise<void> {
    // Unsubscribe FIRST: a registry write during teardown must not reach a
    // transport that is already closing.
    this.deps.peerConfigManager.off('peer-config:changed', this.onPeerConfigChanged);
    if (this.currentDiscovery) {
      try { this.currentDiscovery.stop(); } catch (err) { logger.warn(`[fleet] discovery stop failed: ${err}`); }
      this.currentDiscovery = null;
    }
    // Clear the peer_* tool wiring BEFORE awaiting stop(): during the (async) close
    // the transport is half-shut, so any peer_list/peer_call in that window must
    // immediately report "Fleet is not enabled" rather than hit a closing
    // socket. Null currentManager first so currentLinkManager() also returns null.
    const closing = this.currentManager;
    this.currentManager = null;
    this.deps.setLinkManager(null);
    if (closing) {
      try { await closing.stop(); } catch (err) { logger.warn(`[fleet] transport stop failed: ${err}`); }
    }
  }

  /**
   * Bound so the SAME reference can be removed in teardown — an arrow property,
   * not a method, because `off` matches listeners by identity.
   */
  /**
   * A peer on DHCP comes back at a new IP: mDNS sees it, but the registry keeps
   * the stale address and the client dials into the void. Rewrite the address when
   * (and only when) a KNOWN machine has actually moved — the write emits
   * 'peer-config:changed', which re-dials it through the normal reconcile path.
   */
  private refreshPeerAddress(peer: DiscoveredPeer): void {
    const plan = planAddressRefresh(this.deps.peerConfigManager.list(), peer);
    if (!plan) return;
    this.deps.peerConfigManager.update(plan.peerId, { address: plan.address });
    logger.info(`[fleet] Peer ${plan.peerId} moved to ${plan.address}`);
  }

  private readonly onPeerConfigChanged = (): void => {
    this.currentManager?.syncPeers();
  };

  /** The live transport, or null when fleet is off (for getLinkManager closures). */
  currentLinkManager(): PeerLinkManager | null {
    return this.currentManager;
  }

  /** The live pairing runtime (discovered peers + coordinator), or null when off. */
  currentPairingRuntime(): PairingRuntime | null {
    return this.currentDiscovery ? this.currentDiscovery.runtime() : null;
  }

  /**
   * What the UI shows instead of guessing. The bug that made this necessary: the
   * mDNS backend threw at startup, the error went only to a log file, and the
   * Peers tab calmly reported "No nearby peers found" — indistinguishable from an
   * empty LAN. Anything that stops the stack must be visible in the app.
   */
  status(): FleetStatus {
    const cfg = this.deps.getConfig();
    const { addresses, allInterfaces } = reachableAddresses(cfg.host, cfg.port);
    return {
      enabled: cfg.enabled,
      running: this.isRunning(),
      error: this.lastError,
      addresses,
      allInterfaces,
    };
  }

  isRunning(): boolean {
    return this.currentManager !== null || this.currentDiscovery !== null;
  }

  /** Apply the current persisted config (start if enabled). */
  start(): Promise<void> {
    return this.applyConfig();
  }

  /** Tear everything down (app cleanup). Serialized like applyConfig. */
  stop(): Promise<void> {
    const run = this.applyChain.then(() => this.teardown());
    this.applyChain = run.catch(() => { /* swallow */ });
    return run;
  }

  /**
   * Build the real discovery unit: a PeerDiscovery advertising this instance +
   * browsing the LAN, and a PairingCoordinator that spins up a PeerPairing per SAS
   * session. Discovery events + SAS/paired/failed events are broadcast to renderers.
   * This is the code that previously lived inline in setupPairingHandlers; moving it
   * here lets the controller own the discovery lifecycle while the pairing IPC
   * handlers stay registered once and delegate through currentPairingRuntime().
   */
  private buildRealDiscovery(cfg: FleetConfig): FleetDiscovery {
    const identity = getOrCreateMachineIdentity();
    const discovered = new Map<string, DiscoveredPeer>();
    const broadcast = this.deps.broadcast ?? (() => { /* no renderers in tests */ });
    const alias = this.deps.alias ?? hostname();

    const discovery = new PeerDiscovery({ machineId: identity.machineId });
    discovery.on('peer-discovered', (peer: DiscoveredPeer) => {
      discovered.set(peer.machineId, peer);
      broadcast('peer:discovered', peer);
      this.refreshPeerAddress(peer);
    });
    discovery.on('peer-lost', ({ machineId }: { machineId: string }) => {
      discovered.delete(machineId);
      broadcast('peer:lost', { machineId });
    });

    // Resolve our cert fingerprint up-front (async) so PeerPairing can use it sync.
    let currentCertFp = '';
    void getOrCreateSelfSignedCert().then((c) => { currentCertFp = c.fingerprint; });

    /** Broadcast a pairing's lifecycle to every renderer, for both directions. */
    const wireEvents = (pairing: PeerPairing, sessionId: string): void => {
      pairing.on('sas', (sas: string) => broadcast('peer:sas', { sessionId, sas }));
      pairing.on('paired', (info) => broadcast('peer:paired', { sessionId, ...info }));
      pairing.on('failed', (info) => broadcast('peer:failed', { sessionId, ...info }));
    };

    const coordinator = new PairingCoordinator({
      createPairing: (sessionId, peer) => {
        // The peer's cert fingerprint is not known until TLS completes, so the
        // channel fills it in on this very object before any frame can be sent.
        // PeerPairing reads peer.certFp lazily (at transcript time), which is
        // strictly after the connection is up.
        const channel = this.deps.createChannel
          ? this.deps.createChannel(peer, sessionId)
          : new OutboundPairingChannel({
            peer,
            sessionId,
            self: { machineId: identity.machineId, alias, port: cfg.port },
            connect: this.deps.connectPairing ?? connectPairingSocket,
            getCertKey: async () => {
              const c = await getOrCreateSelfSignedCert();
              return { certPem: c.certPem, keyPem: c.privateKeyPem };
            },
          });
        const pairing = new PeerPairing({
          role: 'initiator',
          sessionId,
          channel,
          pinnedCertStore: this.deps.pinnedCertStore,
          secretStore: this.deps.secretStore,
          peerConfigManager: this.deps.peerConfigManager,
          self: { machineId: identity.machineId, certFp: currentCertFp },
          peer,
        });
        if (channel instanceof OutboundPairingChannel) channel.attach(pairing);
        wireEvents(pairing, sessionId);
        return pairing;
      },
    });

    /**
     * A peer dialled US. Build the responder half and let the user compare codes.
     * Everything is discarded unless the local user accepts a matching SAS.
     */
    const adoptInbound = (socket: PairingSocket): void => {
      socket.once('hello', (hello: PairingHello) => {
        const peer: PairingPeerInfo = {
          machineId: hello.machineId,
          alias: hello.alias,
          certFp: socket.peerCertFp,
          // tls.remoteAddress is IPv4-MAPPED on a dual-stack listener
          // (`::ffff:10.0.0.2`); stored raw it produces an undialable host.
          address: socket.peerHost ? normalizePeerAddress(`${socket.peerHost}:${hello.port}`) : '',
        };
        const pairing = new PeerPairing({
          role: 'responder',
          sessionId: hello.sessionId,
          channel: socket,
          pinnedCertStore: this.deps.pinnedCertStore,
          secretStore: this.deps.secretStore,
          peerConfigManager: this.deps.peerConfigManager,
          self: { machineId: identity.machineId, certFp: currentCertFp },
          peer,
        });
        const verdict = coordinator.startInbound(peer, hello.sessionId, pairing);
        if (!verdict.ok) {
          logger.warn(`[fleet] Refused inbound pairing: ${verdict.reason}`);
          socket.close();
          return;
        }
        // Announce ourselves back, so a caller that reached us by typed-in address
        // (no mDNS, hence no machineId) can complete the SAS transcript.
        socket.sendHello({
          sessionId: hello.sessionId,
          machineId: identity.machineId,
          alias,
          port: cfg.port,
        });
        bindPairingSocket(socket, pairing);
        wireEvents(pairing, hello.sessionId);
        // Tell the renderers to surface the confirm dialog — without this the
        // remote user has nothing to accept and pairing stalls forever.
        broadcast('peer:incoming', {
          sessionId: hello.sessionId,
          machineId: hello.machineId,
          alias: hello.alias,
          address: peer.address,
        });
      });
    };

    return {
      start: () => {
        this.inboundPairingSink = adoptInbound;
        discovery.start();
        discovery.advertise({ machineId: identity.machineId, alias, port: cfg.port });
        logger.info('[fleet] Discovery started + advertising');
      },
      stop: () => {
        this.inboundPairingSink = null;
        try { discovery.stop(); } catch { /* ignore */ }
      },
      runtime: () => ({ discovered, coordinator }),
    };
  }
}
