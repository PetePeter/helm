/**
 * usePeers fleet-config tests (P-0658) — the in-app enable/host/port surface.
 * setFleetConfig persists via configClient.configSetFleetConfig, then
 * refetches configGetFleetConfig + refresh(); fleetEnabled derives from
 * the fetched config. IPC clients are faked at the module boundary.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  fed: { enabled: false, host: '0.0.0.0', port: 47474 },
  peers: [] as any[],
  discovered: [] as any[],
};

const configSetFleetConfig = vi.fn(async (updates: any) => {
  state.fed = { ...state.fed, ...updates };
  return { success: true };
});
const configGetFleetConfig = vi.fn(async () => ({ ...state.fed }));
const peerFleetEnabled = vi.fn(async () => state.fed.enabled);
const peerList = vi.fn(async () => state.peers);
const peerListDiscovered = vi.fn(async () => state.discovered);
const peerGetAudit = vi.fn(async () => []);

vi.mock('../renderer/ipc/clients.js', () => ({
  peersClient: {
    peerFleetEnabled: (...a: any[]) => peerFleetEnabled(...a),
    peerList: (...a: any[]) => peerList(...a),
    peerListDiscovered: (...a: any[]) => peerListDiscovered(...a),
    peerGetAudit: (...a: any[]) => peerGetAudit(...a),
  },
  configClient: {
    configSetFleetConfig: (...a: any[]) => configSetFleetConfig(...a),
    configGetFleetConfig: (...a: any[]) => configGetFleetConfig(...a),
  },
  eventsClient: {},
}));

const { usePeers, resetPeersStateForTesting } = await import('../renderer/composables/usePeers.js');

beforeEach(() => {
  vi.clearAllMocks();
  resetPeersStateForTesting();
  state.fed = { enabled: false, host: '0.0.0.0', port: 47474 };
});

describe('usePeers — fleet config', () => {
  it('setFleetConfig persists via configClient then refetches the config', async () => {
    const { setFleetConfig, fleetConfig } = usePeers();
    await setFleetConfig({ enabled: true, port: 50000 });

    expect(configSetFleetConfig).toHaveBeenCalledWith({ enabled: true, port: 50000 });
    expect(configGetFleetConfig).toHaveBeenCalled();
    expect(fleetConfig.value).toEqual({ enabled: true, host: '0.0.0.0', port: 50000 });
  });

  it('fleetEnabled derives from the fetched fleet config', async () => {
    const { setFleetConfig, fleetEnabled } = usePeers();
    expect(fleetEnabled.value).toBe(false);
    await setFleetConfig({ enabled: true });
    expect(fleetEnabled.value).toBe(true);
  });

  it('refetches peers/discovered after a config change so the UI stays consistent', async () => {
    const { setFleetConfig } = usePeers();
    await setFleetConfig({ enabled: true });
    expect(peerList).toHaveBeenCalled();
    expect(peerListDiscovered).toHaveBeenCalled();
  });
});

describe('usePeers — spawnTargets (machines I may spawn on)', () => {
  const peer = (over: Record<string, unknown>) => ({
    id: 'p', alias: 'P', address: 'h:1', direction: 'bidirectional', inbound: false,
    enabled: true, online: true, peerAllowsMe: true, ...over,
  });

  it('lists only enabled, online peers that let me call them', async () => {
    state.peers = [
      peer({ id: 'ok', alias: 'Box' }),
      peer({ id: 'offline', online: false }),
      peer({ id: 'disabled', enabled: false }),
      peer({ id: 'denies', peerAllowsMe: false }),
      peer({ id: 'unheard', peerAllowsMe: undefined }),
    ];
    const { refresh, spawnTargets } = usePeers();
    await refresh();
    expect(spawnTargets.value).toEqual([{ id: 'ok', alias: 'Box' }]);
  });
});
