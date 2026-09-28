/**
 * FleetController tests — the LIVE transport + discovery lifecycle behind
 * the in-app fleet toggle (P-0658). Real controller class, fakes for the
 * transport starter, discovery, and the setLinkManager sink. We assert:
 *  - enabled → true starts the transport (setLinkManager(mgr)) + discovery.start()
 *  - enabled → false tears down (prior mgr.stop(), setLinkManager(null), discovery.stop())
 *  - host/port change restarts (old stopped, new started)
 *  - repeated applyConfig is idempotent — only the latest manager is live, priors stopped
 *  - overlapping applyConfig calls serialize (no interleave)
 *  - start()/stop() delegate correctly
 * The controller NEVER touches ipcMain — that is asserted structurally (it takes
 * no electron dep and this test does not mock electron).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetController } from '../src/mcp/peer/fleet-controller.js';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';

interface FakeManager {
  id: number;
  started: boolean;
  stopped: boolean;
  stop: () => Promise<void>;
}

function makeFakeManager(id: number): FakeManager {
  const m: FakeManager = {
    id,
    started: true,
    stopped: false,
    stop: vi.fn(async () => { m.stopped = true; }),
  };
  return m;
}

interface FakeDiscovery {
  id: number;
  started: boolean;
  stopped: boolean;
  start: () => void;
  stop: () => void;
}

function makeFakeDiscovery(id: number): FakeDiscovery {
  const d: FakeDiscovery = {
    id,
    started: false,
    stopped: false,
    start: vi.fn(() => { d.started = true; }),
    stop: vi.fn(() => { d.stopped = true; }),
  };
  return d;
}

function baseConfig(over: Partial<{ enabled: boolean; host: string; port: number }> = {}) {
  return { enabled: false, host: '0.0.0.0', port: 47474, ...over };
}

describe('FleetController', () => {
  let config: { enabled: boolean; host: string; port: number };
  let managers: FakeManager[];
  let discoveries: FakeDiscovery[];
  let linkSink: Array<FakeManager | null>;
  let startTransport: ReturnType<typeof vi.fn>;
  let makeDiscovery: ReturnType<typeof vi.fn>;
  let controller: FleetController;

  beforeEach(() => {
    config = baseConfig();
    managers = [];
    discoveries = [];
    linkSink = [];
    let mgrSeq = 0;
    let discSeq = 0;
    startTransport = vi.fn(async () => {
      const m = makeFakeManager(++mgrSeq);
      managers.push(m);
      return m;
    });
    makeDiscovery = vi.fn(() => {
      const d = makeFakeDiscovery(++discSeq);
      discoveries.push(d);
      return d;
    });
    controller = new FleetController({
      getConfig: () => config,
      onCall: async () => ({ ok: true }),
      pinnedCertStore: {} as never,
      secretStore: {} as never,
      peerConfigManager: new PeerConfigManager(),
      setLinkManager: (mgr) => { linkSink.push(mgr as FakeManager | null); },
      startTransport: startTransport as never,
      makeDiscovery: makeDiscovery as never,
    });
  });

  it('enabled → true starts the transport, wires the link manager, and starts discovery', async () => {
    config = baseConfig({ enabled: true });
    await controller.applyConfig();

    expect(startTransport).toHaveBeenCalledTimes(1);
    expect(managers).toHaveLength(1);
    expect(linkSink.at(-1)).toBe(managers[0]);
    expect(controller.currentLinkManager()).toBe(managers[0]);
    expect(controller.isRunning()).toBe(true);
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0].started).toBe(true);
  });

  it('does nothing but clear when disabled from the start', async () => {
    config = baseConfig({ enabled: false });
    await controller.applyConfig();

    expect(startTransport).not.toHaveBeenCalled();
    expect(makeDiscovery).not.toHaveBeenCalled();
    expect(controller.currentLinkManager()).toBeNull();
    expect(controller.isRunning()).toBe(false);
    // setLinkManager(null) is still called to guarantee the peer_* tools report off.
    expect(linkSink.at(-1)).toBeNull();
  });

  it('enabled → false tears down: stops the manager, clears the link, stops discovery', async () => {
    config = baseConfig({ enabled: true });
    await controller.applyConfig();
    const startedMgr = managers[0];
    const startedDisc = discoveries[0];

    config = baseConfig({ enabled: false });
    await controller.applyConfig();

    expect(startedMgr.stopped).toBe(true);
    expect(startedDisc.stopped).toBe(true);
    expect(controller.currentLinkManager()).toBeNull();
    expect(controller.isRunning()).toBe(false);
    expect(linkSink.at(-1)).toBeNull();
  });

  it('host/port change restarts: old manager stopped, a new one started', async () => {
    config = baseConfig({ enabled: true, port: 47474 });
    await controller.applyConfig();
    const first = managers[0];

    config = baseConfig({ enabled: true, port: 50000 });
    await controller.applyConfig();

    expect(first.stopped).toBe(true);
    expect(managers).toHaveLength(2);
    expect(controller.currentLinkManager()).toBe(managers[1]);
    expect(managers[1].stopped).toBe(false);
    // Discovery also cycled.
    expect(discoveries[0].stopped).toBe(true);
    expect(discoveries[1].started).toBe(true);
  });

  it('repeated applyConfig is idempotent — only the latest manager stays live, priors stopped', async () => {
    config = baseConfig({ enabled: true });
    await controller.applyConfig();
    await controller.applyConfig();
    await controller.applyConfig();

    // Each apply tears down the prior then restarts, so 3 managers created, 2 stopped.
    const live = controller.currentLinkManager();
    const stoppedCount = managers.filter((m) => m.stopped).length;
    expect(managers).toHaveLength(3);
    expect(stoppedCount).toBe(2);
    expect(live).toBe(managers[2]);
    expect(managers[2].stopped).toBe(false);
    // No leaked discovery: only the last one is live.
    expect(discoveries.filter((d) => d.started && !d.stopped)).toEqual([discoveries[2]]);
  });

  it('overlapping applyConfig calls serialize — no interleaving of teardown/startup', async () => {
    // A slow transport start lets us launch a second applyConfig before the first
    // resolves; the controller must serialize so we never end with two live managers.
    config = baseConfig({ enabled: true });
    const gate: Array<() => void> = [];
    startTransport.mockImplementation(async () => {
      const m = makeFakeManager(managers.length + 1);
      managers.push(m);
      await new Promise<void>((resolve) => gate.push(resolve));
      return m;
    });

    const p1 = controller.applyConfig();
    const p2 = controller.applyConfig();

    // The two applies are serialized, so the second transport start only begins
    // after the first resolves. Drain gate resolvers until BOTH applies settle —
    // if they interleaved, more than one manager would be live simultaneously.
    let settled = false;
    void Promise.all([p1, p2]).then(() => { settled = true; });
    while (!settled) {
      // At every point at most one apply is mid-start → at most one live manager.
      const liveDuringRun = managers.filter((m) => !m.stopped);
      expect(liveDuringRun.length).toBeLessThanOrEqual(1);
      const next = gate.shift();
      if (next) next();
      await new Promise((r) => setTimeout(r, 0));
    }

    // Exactly one live manager; any prior stopped.
    const live = managers.filter((m) => !m.stopped);
    expect(live).toHaveLength(1);
    expect(controller.currentLinkManager()).toBe(live[0]);
  });

  it('clears the link manager BEFORE the old transport.stop() resolves (no half-closed window)', async () => {
    // A slow stop() lets us observe the ordering: at the moment stop() begins,
    // currentLinkManager() must ALREADY be null and setLinkManager(null) must have
    // already fired — so a peer_list/peer_call during the async close reports
    // "Fleet is not enabled" rather than hitting a closing socket.
    const observations: Array<{ linkNullAtStop: boolean; sinkNullAtStop: boolean }> = [];
    let releaseStop: () => void = () => {};
    startTransport.mockImplementationOnce(async () => {
      const m: FakeManager = {
        id: 1, started: true, stopped: false,
        stop: vi.fn(async () => {
          observations.push({
            linkNullAtStop: controller.currentLinkManager() === null,
            sinkNullAtStop: linkSink.at(-1) === null,
          });
          m.stopped = true;
          await new Promise<void>((r) => { releaseStop = r; });
        }),
      };
      managers.push(m);
      return m;
    });

    config = baseConfig({ enabled: true });
    await controller.applyConfig();
    expect(controller.currentLinkManager()).toBe(managers[0]);

    // Trigger teardown; do NOT await yet so we can release the slow stop().
    config = baseConfig({ enabled: false });
    const p = controller.applyConfig();
    // Let the teardown reach the awaited stop().
    await Promise.resolve();
    await Promise.resolve();
    releaseStop();
    await p;

    expect(observations).toHaveLength(1);
    expect(observations[0].linkNullAtStop).toBe(true);
    expect(observations[0].sinkNullAtStop).toBe(true);
    expect(managers[0].stopped).toBe(true);
    expect(controller.currentLinkManager()).toBeNull();
  });

  it('start() applies the current config; stop() tears everything down', async () => {
    config = baseConfig({ enabled: true });
    await controller.start();
    expect(controller.isRunning()).toBe(true);
    const mgr = managers[0];
    const disc = discoveries[0];

    await controller.stop();
    expect(mgr.stopped).toBe(true);
    expect(disc.stopped).toBe(true);
    expect(controller.currentLinkManager()).toBeNull();
    expect(controller.isRunning()).toBe(false);
    expect(linkSink.at(-1)).toBeNull();
  });
});

/**
 * Runtime peer reconciliation. A successful SAS pairing writes the new peer into
 * the PeerConfigManager — but nothing dialled it, so a freshly-paired fleet stayed
 * "offline" until the app was restarted. The controller now reconciles the live
 * transport against the registry on every 'peer-config:changed', which covers
 * pairing, a manual edit, and a discovered address change through ONE path.
 */
describe('FleetController peer reconciliation', () => {
  function setup() {
    const cfg = { enabled: true, host: '0.0.0.0', port: 47474 };
    const syncPeers = vi.fn();
    const peerConfigManager = new PeerConfigManager();
    const controller = new FleetController({
      getConfig: () => cfg,
      onCall: async () => ({ ok: true }),
      pinnedCertStore: {} as never,
      secretStore: {} as never,
      peerConfigManager,
      setLinkManager: () => { /* not under test */ },
      startTransport: (async () => ({ stop: async () => { /* */ }, syncPeers })) as never,
      makeDiscovery: (() => null) as never,
    });
    return { controller, peerConfigManager, syncPeers };
  }

  it('re-syncs the live transport when a pairing writes a peer into the registry', async () => {
    const { controller, peerConfigManager, syncPeers } = setup();
    await controller.applyConfig();
    expect(syncPeers).not.toHaveBeenCalled();

    // What PeerPairing.tryFinalize() does on a successful SAS.
    peerConfigManager.upsertByMachineId({
      machineId: 'MID-REMOTE', alias: 'the Mac', address: '10.0.0.2:47474',
      pskRef: 'peer-MID-REMOTE', inbound: false, direction: 'bidirectional',
    });

    expect(syncPeers).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it('stops re-syncing once torn down, so a stopped transport is never touched', async () => {
    const { controller, peerConfigManager, syncPeers } = setup();
    await controller.applyConfig();
    await controller.stop();

    expect(() => peerConfigManager.add({ alias: 'x', address: 'h:1', pskRef: 'r' })).not.toThrow();
    expect(syncPeers).not.toHaveBeenCalled();
  });
});
