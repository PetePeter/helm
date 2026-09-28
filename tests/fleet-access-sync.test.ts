/**
 * FleetAccessSync — each machine reports its own "may you call me" flag to the
 * peer, which records it for display only. Two real PeerConfigManagers joined by
 * an in-memory link; nothing else faked.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';
import { FleetAccessSync, ACCESS_METHOD, type AccessLinks } from '../src/mcp/peer/fleet-access-sync.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/** A's link to B: notify on A surfaces on B as a notification from A's peer id there. */
class LoopLinks extends EventEmitter implements AccessLinks {
  other!: LoopLinks;
  online = true;
  constructor(private readonly idOfMeAtOther: string, private readonly onlinePeers: () => string[]) { super(); }
  status(): 'online' | 'offline' { return this.online ? 'online' : 'offline'; }
  onlinePeerIds(): string[] { return this.online ? this.onlinePeers() : []; }
  notify(_peerId: string, method: string, params: unknown): boolean {
    if (!this.online) return false;
    this.other.emit('peer-notification', { peerId: this.idOfMeAtOther, method, params });
    return true;
  }
}

function pair() {
  const a = new PeerConfigManager();
  const b = new PeerConfigManager();
  const bAtA = a.add({ alias: 'B', address: 'b:1', pskRef: 'r' }).id;
  const aAtB = b.add({ alias: 'A', address: 'a:1', pskRef: 'r' }).id;
  const linkA = new LoopLinks(aAtB, () => [bAtA]);
  const linkB = new LoopLinks(bAtA, () => [aAtB]);
  linkA.other = linkB; linkB.other = linkA;
  const syncA = new FleetAccessSync(a); syncA.setLinks(linkA);
  const syncB = new FleetAccessSync(b); syncB.setLinks(linkB);
  return { a, b, bAtA, aAtB, linkA, linkB, syncA, syncB };
}

describe('FleetAccessSync', () => {
  it('S1 changing my grant is reported to the peer as peerAllowsMe', () => {
    const { a, b, bAtA, aAtB } = pair();
    a.update(bAtA, { inbound: true });
    expect(b.get(aAtB)!.peerAllowsMe).toBe(true);
    a.update(bAtA, { inbound: false });
    expect(b.get(aAtB)!.peerAllowsMe).toBe(false);
  });

  it('S2 a report never changes the receiver own grant', () => {
    const { a, b, bAtA, aAtB } = pair();
    a.update(bAtA, { inbound: true });
    expect(b.isInboundAllowed(aAtB)).toBe(false);
  });

  it('S3 coming online reports the current grant', () => {
    const { a, b, bAtA, aAtB, linkA } = pair();
    linkA.online = false; linkA.other.online = false;
    a.update(bAtA, { inbound: true });
    expect(b.get(aAtB)!.peerAllowsMe).toBeUndefined();
    linkA.online = true; linkA.other.online = true;
    linkA.emit('peer-link:online', { peerId: bAtA });
    expect(b.get(aAtB)!.peerAllowsMe).toBe(true);
  });

  it('S4 a malformed report is ignored', () => {
    const { b, aAtB, linkB } = pair();
    linkB.emit('peer-notification', { peerId: aAtB, method: ACCESS_METHOD, params: { allowsYou: 'yes' } });
    expect(b.get(aAtB)!.peerAllowsMe).toBeUndefined();
  });

  it('S5 after setLinks(null) nothing is sent or received', () => {
    const { a, b, bAtA, aAtB, syncA } = pair();
    syncA.setLinks(null);
    a.update(bAtA, { inbound: true });
    expect(b.get(aAtB)!.peerAllowsMe).toBeUndefined();
  });
});
