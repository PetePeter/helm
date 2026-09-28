/**
 * PeersTab component tests — real component + real usePeers composable, with the
 * IPC clients mocked at the module boundary (fakes, not mocks-with-verify where
 * avoidable). Covers rendering paired peers (dot colour + direction + enable
 * toggle), the discover section (excluding already-paired), the "may call me"
 * access toggle + combined direction label, enable toggle, and unpair.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// --- Fake IPC surface --------------------------------------------------------
const state = {
  fleetEnabled: true,
  peers: [] as any[],
  discovered: [] as any[],
  audit: [] as any[],
  fed: { enabled: true, host: '0.0.0.0', port: 47474 },
};

const peerFleetEnabled = vi.fn(async () => state.fleetEnabled);
const peerList = vi.fn(async () => state.peers);
const peerListDiscovered = vi.fn(async () => state.discovered);
const peerGetAudit = vi.fn(async () => state.audit);
const peerSetInbound = vi.fn(async () => ({ ok: true }));
const peerSetEnabled = vi.fn(async () => ({ ok: true }));
const peerUnpair = vi.fn(async () => ({ ok: true }));
const peerSessions = vi.fn(async () => [{ id: 'h1', name: 'builder', cliType: 'Claude Code' }]);
const peerAttach = vi.fn(async () => ({ ok: true, sessionId: 'remote-1' }));
const peerStartPairing = vi.fn(async () => ({ ok: true, sessionId: 's-1' }));
const peerConfirmPairing = vi.fn(async () => ({ ok: true }));
const peerCancelPairing = vi.fn(async () => ({ ok: true }));
const configSetFleetConfig = vi.fn(async (updates: any) => { state.fed = { ...state.fed, ...updates }; return { success: true }; });
const configGetFleetConfig = vi.fn(async () => ({ ...state.fed }));

// Captured event callbacks so tests can drive events (composable subscribes once).
const handlers: Record<string, ((data?: any) => void) | undefined> = {};
function capture(name: string) {
  return (cb: (data?: any) => void) => { handlers[name] = cb; return () => { handlers[name] = undefined; }; };
}

vi.mock('../../../renderer/ipc/clients.js', () => ({
  peersClient: {
    peerFleetEnabled: (...a: any[]) => peerFleetEnabled(...a),
    peerList: (...a: any[]) => peerList(...a),
    peerListDiscovered: (...a: any[]) => peerListDiscovered(...a),
    peerGetAudit: (...a: any[]) => peerGetAudit(...a),
    peerSetInbound: (...a: any[]) => peerSetInbound(...a),
    peerSetEnabled: (...a: any[]) => peerSetEnabled(...a),
    peerUnpair: (...a: any[]) => peerUnpair(...a),
    peerSessions: (...a: any[]) => peerSessions(...a),
    peerAttach: (...a: any[]) => peerAttach(...a),
    peerStartPairing: (...a: any[]) => peerStartPairing(...a),
    peerConfirmPairing: (...a: any[]) => peerConfirmPairing(...a),
    peerCancelPairing: (...a: any[]) => peerCancelPairing(...a),
  },
  configClient: {
    configSetFleetConfig: (...a: any[]) => configSetFleetConfig(...a),
    configGetFleetConfig: (...a: any[]) => configGetFleetConfig(...a),
  },
  eventsClient: {
    onPeerConfigChanged: capture('config'),
    onPeerLinkStatus: capture('link'),
    onPeerAuditChanged: capture('audit'),
    onPeerDiscovered: capture('discovered'),
    onPeerLost: capture('lost'),
    onPeerSas: capture('sas'),
    onPeerPaired: capture('paired'),
    onPeerFailed: capture('failed'),
  },
}));

import PeersTab from '../../../renderer/components/sidebar/PeersTab.vue';
import { getPeerStatusColor } from '../../../renderer/state-colors.js';
import { resetPeersStateForTesting } from '../../../renderer/composables/usePeers.js';

/** jsdom normalises inline hex colours to rgb(); convert so assertions match. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function onlinePeer(over: Partial<any> = {}) {
  return {
    id: 'p1', machineId: 'mac-1', alias: 'the Mac', address: '10.0.0.5:47474',
    direction: 'bidirectional', inbound: true, enabled: true, online: true, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPeersStateForTesting();
  state.fleetEnabled = true;
  state.peers = [];
  state.discovered = [];
  state.audit = [];
  state.fed = { enabled: true, host: '0.0.0.0', port: 47474 };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PeersTab', () => {
  it('renders a paired peer with the online dot colour and access direction', async () => {
    state.peers = [onlinePeer({ peerAllowsMe: true })];
    const w = mount(PeersTab);
    await flushPromises();

    const row = w.find('.peer-row');
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain('the Mac');
    expect(row.find('.peer-access').text()).toBe('↔ both');

    const dot = row.find('.peer-dot');
    // Explicit colour (dark-mode legibility): online green, not a default.
    expect(dot.attributes('style')).toContain(hexToRgb(getPeerStatusColor('online')));
    expect(getPeerStatusColor('online')).toBe('#44cc44');
  });

  it('shows a disabled peer with the enable toggle off', async () => {
    state.peers = [onlinePeer({ enabled: false, online: false })];
    const w = mount(PeersTab);
    await flushPromises();

    const toggle = w.find('.peer-enable-input');
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    // Offline dot is grey, explicitly.
    expect(w.find('.peer-dot').attributes('style')).toContain(hexToRgb(getPeerStatusColor('offline')));
    expect(getPeerStatusColor('offline')).toBe('#555555');
  });

  it('lists discovered peers excluding already-paired, and Pair starts pairing', async () => {
    state.peers = [onlinePeer({ machineId: 'mac-1' })];
    state.discovered = [
      { machineId: 'mac-1', alias: 'the Mac', address: '10.0.0.5:47474' }, // already paired
      { machineId: 'mac-2', alias: 'the PC', address: '10.0.0.6:47474' },  // pairable
    ];
    const w = mount(PeersTab);
    await flushPromises();

    const rows = w.findAll('.peer-discovered-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('the PC');

    await rows[0].find('.peer-pair-btn').trigger('click');
    await flushPromises();
    expect(peerStartPairing).toHaveBeenCalledWith('mac-2');
  });

  it.each([
    [true, true, '↔ both'],
    [true, false, '← them → me'],
    [false, true, '→ me → them'],
    [false, false, 'off'],
    [false, undefined, 'off (peer not heard yet)'],
  ])('access label: inbound=%s peerAllowsMe=%s → %s', async (inbound, peerAllowsMe, label) => {
    state.peers = [onlinePeer({ inbound, peerAllowsMe })];
    const w = mount(PeersTab);
    await flushPromises();
    expect(w.find('.peer-access').text()).toBe(label);
  });

  it('"May call me" toggle saves my own grant only', async () => {
    state.peers = [onlinePeer({ inbound: false })];
    const w = mount(PeersTab);
    await flushPromises();

    const toggle = w.find('.peer-inbound-input');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger('change');
    await flushPromises();
    expect(peerSetInbound).toHaveBeenCalledWith('p1', true);
  });

  it('enable toggle calls peerSetEnabled with the new value', async () => {
    state.peers = [onlinePeer({ enabled: true })];
    const w = mount(PeersTab);
    await flushPromises();

    await w.find('.peer-enable-input').setValue(false);
    await flushPromises();
    expect(peerSetEnabled).toHaveBeenCalledWith('p1', false);
  });

  it('unpair calls peerUnpair with the peer id', async () => {
    state.peers = [onlinePeer()];
    const w = mount(PeersTab);
    await flushPromises();

    await w.find('.peer-unpair').trigger('click');
    await flushPromises();
    expect(peerUnpair).toHaveBeenCalledWith('p1');
  });

  it('renders the FleetConfigPanel at the top of the tab', async () => {
    const w = mount(PeersTab);
    await flushPromises();
    expect(w.find('.fleet-config-panel').exists()).toBe(true);
  });

  it('toggling the panel enabled checkbox calls setFleetConfig({ enabled })', async () => {
    state.fed = { enabled: false, host: '0.0.0.0', port: 47474 };
    state.fleetEnabled = false;
    const w = mount(PeersTab);
    await flushPromises();

    const box = w.find('.fleet-config-panel input[type="checkbox"]');
    await box.setValue(true);
    await flushPromises();
    expect(configSetFleetConfig).toHaveBeenCalledWith({ enabled: true });
  });

  it('Attach lists the online peer sessions and opens the chosen one here', async () => {
    state.peers = [onlinePeer()];
    const w = mount(PeersTab);
    await flushPromises();

    await w.find('.peer-attach-toggle').trigger('click');
    await flushPromises();
    expect(peerSessions).toHaveBeenCalledWith('p1');
    const item = w.find('.peer-session-row');
    expect(item.text()).toContain('builder');

    await item.find('.peer-session-attach').trigger('click');
    await flushPromises();
    expect(peerAttach).toHaveBeenCalledWith('p1', 'h1');
  });

  it('Attach is unavailable while the peer is offline', async () => {
    state.peers = [onlinePeer({ online: false })];
    const w = mount(PeersTab);
    await flushPromises();
    expect(w.find('.peer-attach-toggle').attributes('disabled')).toBeDefined();
  });

  it('shows the error when the peer refuses the attach', async () => {
    state.peers = [onlinePeer()];
    peerAttach.mockResolvedValueOnce({ ok: false, error: 'Tool not permitted' } as any);
    const w = mount(PeersTab);
    await flushPromises();
    await w.find('.peer-attach-toggle').trigger('click');
    await flushPromises();
    await w.find('.peer-session-attach').trigger('click');
    await flushPromises();
    expect(w.find('.peer-attach-error').text()).toContain('Tool not permitted');
  });
});
