/**
 * PeerLinkManager tests — dedup + call routing + status, driven with FAKE
 * PeerLinks and injected server/client factories. No real sockets here (the
 * end-to-end TLS path is covered by remote-link-integration). We assert the
 * unordered-pair dedup rule: the link whose authenticated initiatorId ===
 * min(machineIdA, machineIdB) survives; the other is dropped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PeerLinkManager } from '../src/mcp/peer/peer-link-manager.js';
import { PinnedCertStore } from '../src/mcp/peer/pinned-cert-store.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/** A fake PeerLink good enough for the manager: request + dispose + events. */
class FakeLink extends EventEmitter {
  disposed = false;
  disposeReason = '';
  constructor(public readonly response: unknown = 'ok') { super(); }
  notified: Array<[string, unknown]> = [];
  request(method: string, _params?: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('closed'));
    return Promise.resolve(`${method}:${this.response}`);
  }
  notify(method: string, params: unknown): void { this.notified.push([method, params]); }
  isOnline(): boolean { return !this.disposed; }
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeReason = reason;
    this.emit('offline', reason);
  }
}

/** A fake config source listing the peers the manager should dial. */
const peerList = [
  { id: 'peerA', alias: 'A', address: '10.0.0.2:47474', pskRef: 'r', inbound: true, direction: 'bidirectional' as const, createdAt: 0 },
];

function makeManager(overrides: Partial<ConstructorParameters<typeof PeerLinkManager>[0]> = {}) {
  const created = { servers: [] as any[], clients: [] as any[] };
  const mgr = new PeerLinkManager({
    machineId: 'MID-LOCAL',
    listPeers: () => peerList,
    resolvePsk: () => Buffer.alloc(32, 1),
    getCertKey: async () => ({ certPem: 'c', keyPem: 'k' }),
    pinnedCertStore: {} as any,
    onCall: async (_p, m) => `called:${m}`,
    createServer: (opts) => { const s = new FakeServer(opts); created.servers.push(s); return s as any; },
    createClient: (opts) => { const c = new FakeClient(opts); created.clients.push(c); return c as any; },
    ...overrides,
  });
  return { mgr, created };
}

class FakeServer extends EventEmitter {
  started = false; stopped = false;
  constructor(public opts: any) { super(); }
  async start() { this.started = true; }
  async stop() { this.stopped = true; }
  /** Simulate an inbound authenticated link arriving (peerMachineId proved in HS). */
  emitLink(link: FakeLink, peerId: string, peerMachineId?: string) {
    this.opts.onLink(link, peerId, peerMachineId ?? peerId);
  }
}

class FakeClient extends EventEmitter {
  connected = false; disposed = false;
  constructor(public opts: any) { super(); }
  connect() { this.connected = true; }
  dispose() { this.disposed = true; }
  isConnected() { return this.connected && !this.disposed; }
  emitLink(link: FakeLink, peerId: string, peerMachineId?: string) {
    this.opts.onLink(link, peerId, peerMachineId ?? peerId);
  }
}

describe('PeerLinkManager', () => {
  it('start() creates + starts a server and connects a client per outbound peer', async () => {
    const { mgr, created } = makeManager();
    await mgr.start();
    expect(created.servers).toHaveLength(1);
    expect(created.servers[0].started).toBe(true);
    expect(created.clients).toHaveLength(1);
    expect(created.clients[0].connected).toBe(true);
    await mgr.stop();
    expect(created.servers[0].stopped).toBe(true);
    expect(created.clients[0].disposed).toBe(true);
  });

  it('call routes to the active link and returns its result', async () => {
    const { mgr, created } = makeManager();
    await mgr.start();
    const link = new FakeLink('R');
    created.clients[0].emitLink(link, 'peerA');
    await expect(mgr.call('peerA', 'ping', {})).resolves.toBe('ping:R');
    await mgr.stop();
  });

  it('notify routes a notification to the live link, and inbound ones surface with the peerId', async () => {
    const { mgr, created } = makeManager();
    const inbound: unknown[] = [];
    mgr.on('peer-notification', (e) => inbound.push(e));
    await mgr.start();
    const link = new FakeLink();
    created.clients[0].emitLink(link, 'peerA');

    expect(mgr.notify('A', 'remote.write', { d: 1 })).toBe(true);
    link.emit('notification', 'remote.data', { d: 2 });

    expect(link.notified).toEqual([['remote.write', { d: 1 }]]);
    expect(inbound).toEqual([{ peerId: 'peerA', method: 'remote.data', params: { d: 2 } }]);
    link.dispose('bye');
    expect(mgr.notify('peerA', 'remote.write', {})).toBe(false);
    await mgr.stop();
  });

  it('peerIdFor resolves an id or alias to the configured peer id, else undefined', () => {
    const { mgr } = makeManager();
    expect(mgr.peerIdFor('peerA')).toBe('peerA');
    expect(mgr.peerIdFor('a')).toBe('peerA');
    expect(mgr.peerIdFor('stranger')).toBeUndefined();
  });

  it('status reflects online/offline', async () => {
    const { mgr, created } = makeManager();
    await mgr.start();
    expect(mgr.status('peerA')).toBe('offline');
    const link = new FakeLink();
    created.clients[0].emitLink(link, 'peerA');
    expect(mgr.status('peerA')).toBe('online');
    link.dispose('bye');
    expect(mgr.status('peerA')).toBe('offline');
    await mgr.stop();
  });

  it('emits peer-link:online / offline with the peerId', async () => {
    const { mgr, created } = makeManager();
    const events: Array<[string, string]> = [];
    mgr.on('peer-link:online', (e: any) => events.push(['online', e.peerId]));
    mgr.on('peer-link:offline', (e: any) => events.push(['offline', e.peerId]));
    await mgr.start();
    const link = new FakeLink();
    created.clients[0].emitLink(link, 'peerA');
    link.dispose('x');
    expect(events).toEqual([['online', 'peerA'], ['offline', 'peerA']]);
    await mgr.stop();
  });

  it('setOnCall swaps the inbound sink used by new servers/clients', async () => {
    const sink = vi.fn(async () => 'sunk');
    const { mgr, created } = makeManager();
    mgr.setOnCall(sink as any);
    await mgr.start();
    // The factory received the CURRENT sink.
    await created.servers[0].opts.onCall('peerA', 'm', {});
    expect(sink).toHaveBeenCalled();
    await mgr.stop();
  });

  it('list() combines the configured peers with their live online status', async () => {
    const { mgr, created } = makeManager();
    await mgr.start();
    // No link yet → offline.
    expect(mgr.list()).toEqual([
      { id: 'peerA', alias: 'A', direction: 'bidirectional', online: false, mayCallMe: true, mayCallThem: false },
    ]);
    // Bring a link up → online flips true.
    created.clients[0].emitLink(new FakeLink(), 'peerA');
    expect(mgr.list()).toEqual([
      { id: 'peerA', alias: 'A', direction: 'bidirectional', online: true, mayCallMe: true, mayCallThem: false },
    ]);
    await mgr.stop();
  });

  describe('enabled gating (only enabled peers are dialled)', () => {
    it('start() does NOT dial a peer with enabled:false', async () => {
      const { mgr, created } = makeManager({
        listPeers: () => [
          { id: 'off', alias: 'Off', address: '10.0.0.9:47474', pskRef: 'r', inbound: true, direction: 'bidirectional', createdAt: 0, enabled: false },
        ],
      });
      await mgr.start();
      expect(created.clients).toHaveLength(0); // no outbound dial for disabled peer
      await mgr.stop();
    });

    it('start() DOES dial a peer with enabled undefined (default-true)', async () => {
      const { mgr, created } = makeManager({
        listPeers: () => [
          { id: 'dflt', alias: 'Dflt', address: '10.0.0.8:47474', pskRef: 'r', inbound: true, direction: 'bidirectional', createdAt: 0 },
        ],
      });
      await mgr.start();
      expect(created.clients).toHaveLength(1);
      await mgr.stop();
    });

    it('addPeer() is a no-op for a disabled peer', async () => {
      const { mgr, created } = makeManager({ listPeers: () => [] });
      await mgr.start();
      expect(created.clients).toHaveLength(0);
      mgr.addPeer({ id: 'off', alias: 'Off', address: '10.0.0.7:47474', pskRef: 'r', inbound: true, direction: 'bidirectional', createdAt: 0, enabled: false });
      expect(created.clients).toHaveLength(0);
      await mgr.stop();
    });
  });

  describe('dedup by min(machineId) initiator', () => {
    it('local is the min → our OUTBOUND (we initiated) link wins over an inbound', async () => {
      // localMachineId 'AAA' < peerMachineId 'ZZZ' → the link where WE are
      // initiator (outbound) wins.
      const { mgr, created } = makeManager({ machineId: 'AAA' });
      await mgr.start();

      // Inbound link (peer initiated) arrives first.
      const inbound = new FakeLink('inbound');
      created.servers[0].emitLink(inbound, 'peerA', 'ZZZ');
      expect(mgr.status('peerA')).toBe('online');

      // Our outbound link (we are initiator, and AAA is the min) arrives → it is
      // preferred; the inbound must be dropped.
      const outbound = new FakeLink('outbound');
      created.clients[0].emitLink(outbound, 'peerA', 'ZZZ');

      expect(inbound.disposed).toBe(true);
      expect(outbound.disposed).toBe(false);
      await expect(mgr.call('peerA', 'x', {})).resolves.toBe('x:outbound');
      await mgr.stop();
    });

    it('local is NOT the min → an inbound (peer-initiated) link wins over our outbound', async () => {
      // localMachineId 'ZZZ' > peerMachineId 'AAA' → the link where the PEER is
      // initiator (inbound) wins.
      const { mgr, created } = makeManager({ machineId: 'ZZZ' });
      await mgr.start();

      const outbound = new FakeLink('outbound');
      created.clients[0].emitLink(outbound, 'peerA', 'AAA');
      expect(mgr.status('peerA')).toBe('online');

      const inbound = new FakeLink('inbound');
      created.servers[0].emitLink(inbound, 'peerA', 'AAA');

      expect(outbound.disposed).toBe(true);
      expect(inbound.disposed).toBe(false);
      await mgr.stop();
    });

    it('dedup uses the AUTHENTICATED wire machineId, not the config peerId string', async () => {
      // Config peerId 'aaa-config-id' would order LATER than local 'MMM' (lower-
      // case > uppercase in ASCII), which — if the buggy code compared peerId —
      // would make local the min and prefer OUTBOUND. But the peer PROVED
      // machineId 'AAA' (< 'MMM'), so the peer is the true min and INBOUND must
      // win. This test fails if dedup regresses to comparing peerId.
      const { mgr, created } = makeManager({ machineId: 'MMM' });
      await mgr.start();

      const outbound = new FakeLink('outbound');
      created.clients[0].emitLink(outbound, 'aaa-config-id', 'AAA');
      expect(mgr.status('aaa-config-id')).toBe('online');

      const inbound = new FakeLink('inbound');
      created.servers[0].emitLink(inbound, 'aaa-config-id', 'AAA');

      expect(outbound.disposed).toBe(true);   // non-preferred → dropped
      expect(inbound.disposed).toBe(false);   // peer-min → inbound wins
      await mgr.stop();
    });

    it('a non-preferred duplicate arriving second loses immediately', async () => {
      const { mgr, created } = makeManager({ machineId: 'AAA' });
      await mgr.start();
      const winner = new FakeLink('win');
      created.clients[0].emitLink(winner, 'peerA', 'ZZZ'); // outbound, we are min → preferred
      const loser = new FakeLink('lose');
      created.servers[0].emitLink(loser, 'peerA', 'ZZZ'); // inbound, non-preferred
      expect(loser.disposed).toBe(true);
      expect(winner.disposed).toBe(false);
      await mgr.stop();
    });
  });

  describe('disposePeer (drop a single peer\'s live transport on disable)', () => {
    it('disposes the live link and marks the peer offline without stopping others', async () => {
      const { mgr, created } = makeManager();
      await mgr.start();
      const link = new FakeLink();
      created.clients[0].emitLink(link, 'peerA');
      expect(mgr.status('peerA')).toBe('online');

      mgr.disposePeer('peerA');

      expect(link.disposed).toBe(true);
      expect(link.disposeReason).toBe('peer-disabled');
      expect(mgr.status('peerA')).toBe('offline');
      await mgr.stop();
    });

    it('disposes the outbound client so a later addPeer can re-dial', async () => {
      const { mgr, created } = makeManager();
      await mgr.start();
      expect(created.clients).toHaveLength(1);

      mgr.disposePeer('peerA');
      expect(created.clients[0].disposed).toBe(true);

      // Re-enable path: addPeer creates a fresh client (no-op guard cleared).
      mgr.addPeer({ id: 'peerA', alias: 'A', address: '10.0.0.2:47474', pskRef: 'r', inbound: true, direction: 'bidirectional', createdAt: 0 });
      expect(created.clients).toHaveLength(2);
      expect(created.clients[1].connected).toBe(true);
      await mgr.stop();
    });

    it('emits peer-link:offline when a live link is disposed', async () => {
      const { mgr, created } = makeManager();
      const offline: string[] = [];
      mgr.on('peer-link:offline', (e: any) => offline.push(e.peerId));
      await mgr.start();
      created.clients[0].emitLink(new FakeLink(), 'peerA');

      mgr.disposePeer('peerA');
      expect(offline).toEqual(['peerA']);
      await mgr.stop();
    });

    it('is a no-op (no throw) for an unknown peer', async () => {
      const { mgr } = makeManager();
      await mgr.start();
      expect(() => mgr.disposePeer('ghost')).not.toThrow();
      await mgr.stop();
    });
  });
});

/**
 * Inbound authentication + runtime peer reconciliation.
 *
 * These two describes cover the bug that made a successfully-PAIRED fleet sit at
 * "offline" forever: the manager built a RemoteLinkServer WITHOUT a
 * `resolveExpectedPeer`, so every inbound connection resolved an undefined peerId,
 * got an undefined PSK, and was rejected before the handshake. The end-to-end test
 * missed it because it injected its OWN createServer that supplied the resolver.
 */
describe('PeerLinkManager inbound peer resolution', () => {
  it('gives the server a resolver mapping a PINNED cert fingerprint to its peerId', async () => {
    const pins = new PinnedCertStore();
    pins.recordIfAbsent('peerA', 'AA:BB');
    const { mgr, created } = makeManager({ pinnedCertStore: pins });
    await mgr.start();

    const resolve = created.servers[0].opts.resolveExpectedPeer;
    expect(resolve).toBeTypeOf('function');
    // Without this the server calls resolvePsk(undefined) and rejects every peer.
    expect(resolve('AA:BB')).toBe('peerA');
    // An unpinned cert must stay unresolved — resolving it would hand a PSK to
    // a machine we never paired with.
    expect(resolve('DE:AD')).toBeUndefined();
    await mgr.stop();
  });
});

describe('PeerLinkManager syncPeers', () => {
  /** A mutable registry so the test can mimic a pairing/edit landing at runtime. */
  function makeSyncManager(peers: any[]) {
    const created = { servers: [] as any[], clients: [] as any[] };
    const mgr = new PeerLinkManager({
      machineId: 'MID-LOCAL',
      listPeers: () => peers,
      resolvePsk: () => Buffer.alloc(32, 1),
      getCertKey: async () => ({ certPem: 'c', keyPem: 'k' }),
      pinnedCertStore: {} as any,
      onCall: async () => 'ok',
      createServer: (opts) => { const s = new FakeServer(opts); created.servers.push(s); return s as any; },
      createClient: (opts) => { const c = new FakeClient(opts); created.clients.push(c); return c as any; },
    });
    return { mgr, created };
  }

  const peerA = { id: 'peerA', alias: 'A', address: '10.0.0.2:47474', pskRef: 'r', inbound: true, direction: 'bidirectional' as const, createdAt: 0 };

  it('dials a peer that appeared in the registry after start (the just-paired case)', async () => {
    const peers: any[] = [];
    const { mgr, created } = makeSyncManager(peers);
    await mgr.start();
    expect(created.clients).toHaveLength(0);

    peers.push({ ...peerA });
    mgr.syncPeers();

    expect(created.clients).toHaveLength(1);
    expect(created.clients[0].opts.peerId).toBe('peerA');
    expect(created.clients[0].connected).toBe(true);
    await mgr.stop();
  });

  it('re-dials at the new address when a peer moves, and leaves an unchanged peer alone', async () => {
    const peers: any[] = [{ ...peerA }];
    const { mgr, created } = makeSyncManager(peers);
    await mgr.start();
    const first = created.clients[0];

    // Unchanged registry (mDNS re-announces constantly) must NOT churn the link.
    mgr.syncPeers();
    expect(created.clients).toHaveLength(1);
    expect(first.disposed).toBe(false);

    peers[0].address = '10.0.0.99:47474';
    mgr.syncPeers();

    expect(first.disposed).toBe(true);
    expect(created.clients).toHaveLength(2);
    expect(created.clients[1].opts.host).toBe('10.0.0.99');
    await mgr.stop();
  });
});

describe('PeerLinkManager peer reference resolution (id or alias)', () => {
  /**
   * Reported from a live fleet: peer_list showed alias "box" online, yet
   * peer_call("box", ...) failed with "No live link to peer box". The link was
   * healthy — list() looks peers up by id, call() was handed the alias, and
   * nothing mapped one to the other. An alias is what a human (or an AI reading
   * peer_list) reaches for, so both must work.
   */
  const twoPeers = [
    { id: 'id-box', alias: 'box', address: '10.0.0.2:47474', pskRef: 'r', inbound: true, direction: 'bidirectional' as const, createdAt: 0 },
    { id: 'id-desk', alias: 'desk', address: '10.0.0.3:47474', pskRef: 'r', inbound: true, direction: 'bidirectional' as const, createdAt: 0 },
  ];

  it('routes a call addressed by alias to the same live link as the id', async () => {
    const { mgr, created } = makeManager({ listPeers: () => twoPeers });
    await mgr.start();
    created.clients[0].emitLink(new FakeLink('box-link'), 'id-box');

    expect(mgr.status('box')).toBe('online');
    await expect(mgr.call('box', 'project_list', {})).resolves.toBe('project_list:box-link');
    await expect(mgr.call('id-box', 'project_list', {})).resolves.toBe('project_list:box-link');
    await mgr.stop();
  });

  it('matches an alias case-insensitively', async () => {
    const { mgr, created } = makeManager({ listPeers: () => twoPeers });
    await mgr.start();
    created.clients[0].emitLink(new FakeLink('box-link'), 'id-box');
    await expect(mgr.call('BOX', 'project_list', {})).resolves.toBe('project_list:box-link');
    await mgr.stop();
  });

  it('refuses an ambiguous alias instead of silently picking one', async () => {
    const dupes = [
      twoPeers[0],
      { ...twoPeers[1], id: 'id-box-2', alias: 'box' },
    ];
    const { mgr, created } = makeManager({ listPeers: () => dupes });
    await mgr.start();
    created.clients[0].emitLink(new FakeLink(), 'id-box');
    await expect(mgr.call('box', 'project_list', {})).rejects.toThrow(/ambiguous/i);
    await mgr.stop();
  });

  it('prefers an exact id when another peer uses it as an alias', async () => {
    const collide = [
      { ...twoPeers[0], id: 'box' },
      { ...twoPeers[1], id: 'id-desk', alias: 'box' },
    ];
    const { mgr, created } = makeManager({ listPeers: () => collide });
    await mgr.start();
    created.clients[0].emitLink(new FakeLink('by-id'), 'box');
    await expect(mgr.call('box', 'project_list', {})).resolves.toBe('project_list:by-id');
    await mgr.stop();
  });

  it('still reports a genuine outage for a known peer with no link', async () => {
    const { mgr } = makeManager({ listPeers: () => twoPeers });
    await mgr.start();
    await expect(mgr.call('box', 'project_list', {})).rejects.toThrow(/No live link/);
    await mgr.stop();
  });
});
