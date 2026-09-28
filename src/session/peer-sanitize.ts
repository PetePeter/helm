/**
 * The ONE sanitizer for persisted peer entries.
 *
 * Both the YAML loader and PeerConfigManager.importAll rebuild peers field by
 * field so a hand-edited or corrupt file can never crash startup. They used to do
 * it twice, independently — and drifted: the loader silently dropped `machineId`
 * and `enabled`. A peer that lost its machineId could no longer be found by
 * machineId after a restart, so re-pairing forked a duplicate registry entry and
 * orphaned the original pin + PSK. Sharing one implementation makes that class of
 * drift structurally impossible.
 */

import type { PeerConfig } from '../types/peer.js';

const DIRECTIONS = new Set(['inbound', 'outbound', 'bidirectional']);

/**
 * Coerce arbitrary parsed data into valid PeerConfigs, dropping entries that are
 * not structurally sound. `now` supplies a fallback `createdAt` (injectable so
 * tests stay deterministic).
 */
export function sanitizePeers(peers: unknown, now: () => number = Date.now): PeerConfig[] {
  if (!Array.isArray(peers)) return [];
  return peers
    .filter((p): p is Record<string, unknown> =>
      isRecord(p) &&
      isNonEmptyString(p.id) &&
      typeof p.alias === 'string' &&
      typeof p.address === 'string' &&
      typeof p.direction === 'string' && DIRECTIONS.has(p.direction))
    .map((p): PeerConfig => ({
      id: p.id as string,
      alias: p.alias as string,
      address: p.address as string,
      pskRef: typeof p.pskRef === 'string' ? p.pskRef : '',
      inbound: migrateInbound(p),
      direction: p.direction as PeerConfig['direction'],
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : now(),
      ...(isNonEmptyString(p.machineId) ? { machineId: p.machineId } : {}),
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      ...(typeof p.peerAllowsMe === 'boolean' ? { peerAllowsMe: p.peerAllowsMe } : {}),
    }));
}

/**
 * `inbound` replaced the per-tool `allow` glob list. A legacy peer that was
 * granted anything keeps working (→ allowed); one granted nothing stays off.
 */
function migrateInbound(p: Record<string, unknown>): boolean {
  if (typeof p.inbound === 'boolean') return p.inbound;
  return Array.isArray(p.allow) && p.allow.some((a) => typeof a === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
