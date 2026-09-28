/**
 * PeerConfigManager — in-memory owner of the peer registry.
 *
 * A peer records who this hub may exchange control traffic with and, crucially,
 * whether that peer may call this hub at all (`inbound` — deny-by-default).
 * This manager is pure model + authorisation: no networking, no crypto, and it
 * never holds secret material (only `pskRef` references).
 *
 * Like RuntimeGroupManager it does NOT read from disk in its constructor: the
 * orchestrator hydrates it via `importAll(loadPeers())` and supplies the
 * `persist` callback. The clock is injectable so `createdAt` is deterministic
 * in tests.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { PeerConfig } from '../types/peer.js';
import { sanitizePeers } from './peer-sanitize.js';

const DIRECTIONS = new Set(['inbound', 'outbound', 'bidirectional']);

interface AddPeerInput {
  alias: string;
  address: string;
  pskRef: string;
  inbound?: boolean;
  direction?: PeerConfig['direction'];
  machineId?: string;
  enabled?: boolean;
}

interface UpsertByMachineIdInput extends AddPeerInput {
  machineId: string;
}

export class PeerConfigManager extends EventEmitter {
  private peers: PeerConfig[] = [];

  constructor(
    private readonly persist?: (peers: PeerConfig[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /** Register a new peer and return a COPY of it. */
  add(input: AddPeerInput): PeerConfig {
    const peer: PeerConfig = {
      id: randomUUID(),
      alias: input.alias,
      address: input.address,
      pskRef: input.pskRef,
      inbound: input.inbound ?? false,
      direction: input.direction ?? 'bidirectional',
      createdAt: this.now(),
      ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    this.peers.push(peer);
    this.markChanged();
    logger.info(`[PeerConfigManager] Added peer "${peer.alias}" (${peer.id})`);
    return this.copy(peer);
  }

  /** Get a peer by its stable machineId (copy), or undefined. */
  getByMachineId(machineId: string): PeerConfig | undefined {
    const peer = this.peers.find(p => p.machineId === machineId);
    return peer ? this.copy(peer) : undefined;
  }

  /**
   * Upsert keyed by machineId: if a peer with this machineId already exists it is
   * updated IN PLACE (same id + createdAt preserved) so re-pairing a known peer
   * never creates a duplicate; otherwise a fresh peer is added. Returns a copy.
   */
  upsertByMachineId(input: UpsertByMachineIdInput): PeerConfig {
    const existing = this.peers.find(p => p.machineId === input.machineId);
    if (existing) {
      existing.alias = input.alias;
      existing.address = input.address;
      existing.pskRef = input.pskRef;
      if (input.inbound !== undefined) existing.inbound = input.inbound;
      if (input.direction !== undefined && DIRECTIONS.has(input.direction)) existing.direction = input.direction;
      if (input.enabled !== undefined) existing.enabled = input.enabled;
      this.markChanged();
      logger.info(`[PeerConfigManager] Updated peer by machineId "${existing.alias}" (${existing.id})`);
      return this.copy(existing);
    }
    return this.add(input);
  }

  /** All peers as independent copies. */
  list(): PeerConfig[] {
    return this.peers.map(p => this.copy(p));
  }

  /** Get a peer by id (copy), or undefined. */
  get(id: string): PeerConfig | undefined {
    const peer = this.peers.find(p => p.id === id);
    return peer ? this.copy(peer) : undefined;
  }

  /** Get a peer by alias (copy), or undefined. */
  getByAlias(alias: string): PeerConfig | undefined {
    const peer = this.peers.find(p => p.alias === alias);
    return peer ? this.copy(peer) : undefined;
  }

  /**
   * Merge `patch` into the peer with `id` (id/createdAt are immutable).
   * Returns a copy of the updated peer, or undefined if not found.
   */
  update(id: string, patch: Partial<Omit<PeerConfig, 'id' | 'createdAt'>>): PeerConfig | undefined {
    const peer = this.peers.find(p => p.id === id);
    if (!peer) return undefined;
    if (patch.alias !== undefined) peer.alias = patch.alias;
    if (patch.address !== undefined) peer.address = patch.address;
    if (patch.pskRef !== undefined) peer.pskRef = patch.pskRef;
    if (patch.inbound !== undefined) peer.inbound = patch.inbound;
    if (patch.direction !== undefined && DIRECTIONS.has(patch.direction)) peer.direction = patch.direction;
    if (patch.enabled !== undefined) peer.enabled = patch.enabled;
    this.markChanged();
    return this.copy(peer);
  }

  /** Delete a peer. Returns whether one was removed. */
  remove(id: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter(p => p.id !== id);
    const removed = this.peers.length !== before;
    if (removed) this.markChanged();
    return removed;
  }

  /** Whether `peerId` may call this hub. Unknown peer → false. */
  isInboundAllowed(peerId: string): boolean {
    return this.peers.find(p => p.id === peerId)?.inbound === true;
  }

  /**
   * Record the peer's own grant for me, as it reported over the link. Display
   * only — never touches `inbound`. Persists only on change (reports repeat on
   * every reconnect).
   */
  setPeerAllowsMe(peerId: string, allowed: boolean): void {
    const peer = this.peers.find(p => p.id === peerId);
    if (!peer || peer.peerAllowsMe === allowed) return;
    peer.peerAllowsMe = allowed;
    this.markChanged();
  }

  /** Snapshot of all peers for persistence (independent copies). */
  exportAll(): PeerConfig[] {
    return this.peers.map(p => this.copy(p));
  }

  /**
   * Replace internal state from persisted data, sanitising each entry: only
   * objects with a string id/alias/address and a valid direction are accepted;
   * a legacy `allow` list migrates to `inbound` (see peer-sanitize).
   */
  importAll(peers: PeerConfig[]): void {
    this.peers = sanitizePeers(peers, this.now);
    logger.info(`[PeerConfigManager] Imported ${this.peers.length} peer(s)`);
  }

  private copy(peer: PeerConfig): PeerConfig {
    return { ...peer };
  }

  private markChanged(): void {
    this.persist?.(this.exportAll());
    this.emit('peer-config:changed');
  }
}
