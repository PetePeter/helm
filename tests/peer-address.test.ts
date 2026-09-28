/**
 * peer-address — the pure address rules behind two real failures:
 *
 *  1. A responder records the pairing peer's address from `tls.remoteAddress`,
 *     which on a dual-stack listener is the IPv4-MAPPED form `::ffff:10.0.0.2`.
 *     Stored raw, the outbound dial later splits it at the LAST colon and tries
 *     to connect to the host `::ffff:10.0.0.2` — so the peer that just paired is
 *     never reachable.
 *  2. A peer on DHCP comes back at a new IP. mDNS sees the new address, but the
 *     registry keeps the stale one and the client dials into the void.
 *
 * The planner is deliberately pure: mDNS re-announces continuously, so deciding
 * "has this actually moved?" must be cheap, deterministic, and testable without
 * a network.
 */

import { describe, it, expect } from 'vitest';
import { normalizePeerAddress, planAddressRefresh } from '../src/mcp/peer/peer-address.js';
import type { PeerConfig } from '../src/types/peer.js';

function peer(over: Partial<PeerConfig> = {}): PeerConfig {
  return {
    id: 'p1', alias: 'the Mac', address: '10.0.0.2:47474', pskRef: 'r',
    inbound: false, direction: 'bidirectional', createdAt: 0, machineId: 'MID-REMOTE',
    ...over,
  };
}

describe('normalizePeerAddress', () => {
  it('unwraps an IPv4-mapped IPv6 host so the dial actually resolves', () => {
    expect(normalizePeerAddress('::ffff:10.0.0.2:47474')).toBe('10.0.0.2:47474');
  });

  it('leaves a real IPv6 address intact', () => {
    // Mangling this would break the very connections normalization exists to fix.
    expect(normalizePeerAddress('[fe80::1]:47474')).toBe('[fe80::1]:47474');
  });
});

describe('planAddressRefresh', () => {
  it('moves a known peer to its newly-discovered address', () => {
    const plan = planAddressRefresh([peer()], {
      machineId: 'MID-REMOTE', alias: 'the Mac', address: '10.0.0.99:47474',
    });
    expect(plan).toEqual({ peerId: 'p1', address: '10.0.0.99:47474' });
  });

  it('returns null when nothing moved, so a re-announce cannot churn a healthy link', () => {
    expect(planAddressRefresh([peer()], {
      machineId: 'MID-REMOTE', alias: 'the Mac', address: '::ffff:10.0.0.2:47474',
    })).toBeNull();
  });

  it('returns null for an unknown machine — discovery must never invent a peer', () => {
    expect(planAddressRefresh([peer()], {
      machineId: 'MID-STRANGER', alias: 'nope', address: '10.0.0.7:47474',
    })).toBeNull();
  });
});
