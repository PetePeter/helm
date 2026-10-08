/**
 * PeerDiscovery — LAN presence via mDNS (`_helm._tcp`), nothing more.
 *
 * SECURITY BOUNDARY: discovery reveals only that a Helm instance is present on
 * the network (machineId + alias + address). It grants NO access whatsoever —
 * access requires a completed SAS pairing. A discovered peer is merely a
 * candidate the user may choose to pair with.
 *
 * The bonjour backend is INJECTED (default = real bonjour-service) so the parse,
 * self-filter, and lifecycle logic is unit-testable against a fake with no real
 * network. Our own machineId is filtered out on both browse directions so we
 * never present ourselves as a pairing candidate.
 */

import { EventEmitter } from 'node:events';
import { isIPv4 } from 'node:net';
import { Bonjour } from 'bonjour-service';
import { logger } from '../../utils/logger.js';

/** The mDNS service type Helm advertises/browses. */
export const HELM_SERVICE_TYPE = 'helm';

/** A peer seen on the LAN. Presence only — never an authorisation. */
export interface DiscoveredPeer {
  machineId: string;
  alias: string;
  /** host:port — the best candidate, i.e. `addresses[0]`. */
  address: string;
  /**
   * Every host:port the peer may answer on, best first. A peer with several
   * adapters advertises them all and not every one is routable from here, so the
   * dialler needs the whole list rather than a single guess.
   */
  addresses: string[];
}

export interface AdvertiseOptions {
  machineId: string;
  alias: string;
  port: number;
}

/** The minimal bonjour surface we depend on (real bonjour-service satisfies it). */
export interface BonjourBackend {
  publish(opts: {
    name: string;
    type: string;
    port: number;
    txt?: Record<string, string>;
    protocol?: 'tcp' | 'udp';
  }): { stop?: (cb?: () => void) => void };
  find(opts: { type: string; protocol?: 'tcp' | 'udp' } | null): BonjourBrowser;
  unpublishAll(cb?: () => void): void;
  destroy(cb?: () => void): void;
}

export interface BonjourBrowser {
  start(): void;
  stop(): void;
  on(event: 'up' | 'down', listener: (service: unknown) => void): unknown;
}

export interface PeerDiscoveryOptions {
  /** Our own machineId — filtered out of results (no self-pairing). */
  machineId: string;
  /** Injected backend factory; defaults to the real bonjour-service. */
  createBackend?: () => BonjourBackend;
}

export class PeerDiscovery extends EventEmitter {
  private readonly ownMachineId: string;
  private readonly createBackend: () => BonjourBackend;
  private backend: BonjourBackend | null = null;
  private browser: BonjourBrowser | null = null;

  constructor(opts: PeerDiscoveryOptions) {
    super();
    this.ownMachineId = opts.machineId;
    this.createBackend = opts.createBackend ?? defaultBackendFactory;
  }

  /** Bring up the backend + browser. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.backend) return;
    this.backend = this.createBackend();
    this.browser = this.backend.find({ type: HELM_SERVICE_TYPE, protocol: 'tcp' });
    this.browser.on('up', (service) => this.onServiceUp(service));
    this.browser.on('down', (service) => this.onServiceDown(service));
    this.browser.start();
    logger.info('[PeerDiscovery] Started browsing for _helm._tcp peers');
  }

  /** Advertise this instance as a `_helm._tcp` service with identity TXT. */
  advertise(opts: AdvertiseOptions): void {
    if (!this.backend) this.start();
    this.backend!.publish({
      name: `helm-${opts.machineId}`,
      type: HELM_SERVICE_TYPE,
      protocol: 'tcp',
      port: opts.port,
      txt: { machineId: opts.machineId, alias: opts.alias },
    });
    logger.info(`[PeerDiscovery] Advertising _helm._tcp as "${opts.alias}" on :${opts.port}`);
  }

  /** Tear down advertising + browsing. */
  stop(): void {
    if (this.browser) { try { this.browser.stop(); } catch { /* ignore */ } this.browser = null; }
    if (this.backend) {
      try { this.backend.unpublishAll(); } catch { /* ignore */ }
      try { this.backend.destroy(); } catch { /* ignore */ }
      this.backend = null;
    }
    logger.info('[PeerDiscovery] Stopped');
  }

  // ------------------------------------------------------------- internals

  private onServiceUp(service: unknown): void {
    const parsed = parseService(service);
    if (!parsed) return;
    if (parsed.machineId === this.ownMachineId) return; // never self-pair
    this.emit('peer-discovered', parsed);
  }

  private onServiceDown(service: unknown): void {
    const machineId = readTxtMachineId(service);
    if (!machineId || machineId === this.ownMachineId) return;
    this.emit('peer-lost', { machineId });
  }
}

/** Extract machineId/alias/address from a bonjour Service; null if incomplete. */
function parseService(service: unknown): DiscoveredPeer | null {
  if (!service || typeof service !== 'object') return null;
  const s = service as Record<string, any>;
  const txt = (s.txt && typeof s.txt === 'object') ? s.txt as Record<string, unknown> : {};
  const machineId = typeof txt.machineId === 'string' ? txt.machineId : '';
  if (!machineId) return null;
  const alias = typeof txt.alias === 'string' ? txt.alias : machineId;

  const hosts = pickHosts(s);
  const port = typeof s.port === 'number' ? s.port : Number(s.port) || 0;
  if (hosts.length === 0 || !port) return null;

  const addresses = hosts.map((host) => `${host}:${port}`);
  return { machineId, alias, address: addresses[0], addresses };
}

/**
 * Candidate hosts, best first. The referer is where the announcement actually
 * came FROM, so it is the one address proven to reach us; the rest are whatever
 * else the peer advertises. IPv6 is dropped — link-local needs a scope suffix
 * that does not survive as a bare host. The mDNS hostname is the last resort.
 */
function pickHosts(s: Record<string, any>): string[] {
  const advertised: unknown[] = [s.referer?.address, ...(Array.isArray(s.addresses) ? s.addresses : [])];
  const ipv4 = advertised.filter((host): host is string => typeof host === 'string' && isIPv4(host));
  if (ipv4.length > 0) return [...new Set(ipv4)];
  return typeof s.host === 'string' && s.host ? [s.host] : [];
}

function readTxtMachineId(service: unknown): string {
  if (!service || typeof service !== 'object') return '';
  const txt = (service as any).txt;
  return txt && typeof txt.machineId === 'string' ? txt.machineId : '';
}

/**
 * Construct the real bonjour-service backend (tests inject a fake instead).
 * Imported STATICALLY: the main process is bundled as ESM, where esbuild rewrites
 * a bare CommonJS import into a shim that throws at runtime. bonjour-service is pure JS
 * (no native build), so a static import is safe on Windows, macOS and Linux alike.
 */
function defaultBackendFactory(): BonjourBackend {
  return new Bonjour() as unknown as BonjourBackend;
}
