/**
 * Peer-management IPC handler tests — the setEnabled → live-transport wiring.
 * Real PeerConfigManager + fake link manager + faked Electron. We assert that
 * toggling a peer Off drops its live link immediately (disposePeer) and toggling
 * it On re-dials (addPeer), so "Off" takes effect in both directions at runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PeerConfig } from '../src/types/peer.js';
import { InboundCallGate } from '../src/mcp/peer/inbound-call-gate.js';
import { PeerRateLimiter } from '../src/mcp/peer/rate-limiter.js';

const handleCalls = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { PeerConfigManager } = await import('../src/session/peer-config-manager.js');
const { PeerAuditLog } = await import('../src/mcp/peer/peer-audit-log.js');
const { setupPeerManagementHandlers } = await import('../src/electron/ipc/peer-management-handlers.js');

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

/** A fake link manager recording disposePeer/addPeer calls + reporting status. */
function fakeLinkManager() {
  const disposed: string[] = [];
  const dialed: PeerConfig[] = [];
  const calls: Array<{ peerId: string; method: string; params: unknown }> = [];
  const manager = {
    disposed,
    dialed,
    calls,
    toolList: [] as Array<{ cliType: string; name: string; kind?: string }>,
    status: (_id: string) => 'online' as const,
    disposePeer: (peerId: string) => { disposed.push(peerId); },
    addPeer: (peer: PeerConfig) => { dialed.push(peer); },
    call: async (peerId: string, method: string, params: unknown) => {
      calls.push({ peerId, method, params });
      return manager.toolList;
    },
    on: () => {},
    off: () => {},
  };
  return manager;
}

describe('peer-management handlers — remote CLI type listing', () => {
  let audit: InstanceType<typeof PeerAuditLog>;
  let link: ReturnType<typeof fakeLinkManager>;

  beforeEach(() => {
    handleCalls.clear();
    audit = new PeerAuditLog(() => {}, () => 0);
    link = fakeLinkManager();
    setupPeerManagementHandlers({
      isEnabled: () => true,
      peerConfigManager: new PeerConfigManager(),
      pinnedCertStore: { removePin: vi.fn() } as any,
      secretStore: { remove: vi.fn() } as any,
      audit,
      getLinkManager: () => link as any,
      attach: async () => ({ id: 'attached' }),
      spawn: async () => ({ id: 'spawned' }),
    });
  });

  function gateLink(inbound: boolean | undefined): void {
    const gate = new InboundCallGate({
      peerConfig: {
        isInboundAllowed: (peerId) => peerId === 'viewer' && inbound === true,
        get: (peerId) => peerId === 'viewer' && inbound !== undefined ? { enabled: true } : undefined,
      },
      dispatch: async (method) => method === 'tool_list' ? link.toolList : {},
      rateLimiter: new PeerRateLimiter({ capacity: 10, refillPerMs: 1, now: () => 0 }),
      audit,
      now: () => 0,
    });
    link.call = async (peerId, method, params) => {
      link.calls.push({ peerId, method, params });
      return gate.handle('viewer', method, params);
    };
  }

  it('fetches tool_list through the peer link and returns only peer ids, names, and kinds', async () => {
    link.toolList = [
      { cliType: 'peer-claude-id', name: 'Claude Code', kind: 'cli', command: 'claude', supportsResume: true, supportedDirPaths: ['D:/work'] },
      { cliType: 'peer-api-id', name: 'API Agent', kind: 'api', command: '', supportsResume: true, supportedDirPaths: [] },
    ];
    gateLink(true);

    const result = await getHandler('peer:cliTypes')({}, 'peer-machine');

    expect(result).toEqual([
      { id: 'peer-claude-id', name: 'Claude Code', kind: 'cli' },
      { id: 'peer-api-id', name: 'API Agent', kind: 'api' },
    ]);
    expect(link.calls).toEqual([{ peerId: 'peer-machine', method: 'tool_list', params: {} }]);
    expect(audit.list()[0]).toMatchObject({ method: 'tool_list', outcome: 'ok' });
  });

  it.each([
    ['unpaired', undefined],
    ['paired but inbound-disabled', false],
  ] as const)('refuses tool listing when the remote gate sees an %s caller', async (_label, inbound) => {
    gateLink(inbound);

    await expect(getHandler('peer:cliTypes')({}, 'peer-machine')).rejects.toMatchObject({
      message: 'Tool not permitted',
    });
    expect(link.calls).toEqual([{ peerId: 'peer-machine', method: 'tool_list', params: {} }]);
    expect(audit.list()[0]).toMatchObject({ method: 'tool_list', outcome: 'denied' });
  });
});

describe('peer-management handlers — setEnabled live-transport wiring', () => {
  let cfg: InstanceType<typeof PeerConfigManager>;
  let audit: InstanceType<typeof PeerAuditLog>;
  let link: ReturnType<typeof fakeLinkManager>;

  beforeEach(() => {
    handleCalls.clear();
    cfg = new PeerConfigManager();
    audit = new PeerAuditLog(() => {}, () => 0);
    link = fakeLinkManager();
    setupPeerManagementHandlers({
      isEnabled: () => true,
      peerConfigManager: cfg,
      pinnedCertStore: { removePin: vi.fn() } as any,
      secretStore: { remove: vi.fn() } as any,
      audit,
      getLinkManager: () => link as any,
    });
  });

  it('setEnabled(false) persists the flag AND disposes the live link', async () => {
    const peer = cfg.add({ alias: 'Mac', address: 'h:1', pskRef: 'r' });
    await getHandler('peer:setEnabled')({}, peer.id, false);

    expect(cfg.get(peer.id)!.enabled).toBe(false);
    expect(link.disposed).toEqual([peer.id]);
    expect(link.dialed).toEqual([]);
  });

  it('setEnabled(true) persists the flag AND re-dials via addPeer', async () => {
    const peer = cfg.add({ alias: 'Mac', address: 'h:1', pskRef: 'r', enabled: false });
    await getHandler('peer:setEnabled')({}, peer.id, true);

    expect(cfg.get(peer.id)!.enabled).toBe(true);
    expect(link.dialed.map(p => p.id)).toEqual([peer.id]);
    expect(link.disposed).toEqual([]);
  });

  it('setEnabled on an unknown peer returns ok:false and touches no transport', async () => {
    const res = await getHandler('peer:setEnabled')({}, 'ghost', false);
    expect(res).toEqual({ ok: false });
    expect(link.disposed).toEqual([]);
    expect(link.dialed).toEqual([]);
  });

  it('peer:list reports the enabled flag (default-true for undefined)', async () => {
    const a = cfg.add({ alias: 'A', address: 'h:1', pskRef: 'r' });            // undefined → enabled
    const b = cfg.add({ alias: 'B', address: 'h:2', pskRef: 'r', enabled: false });
    const list = await getHandler('peer:list')();
    const byId = Object.fromEntries(list.map((p: any) => [p.id, p.enabled]));
    expect(byId[a.id]).toBe(true);
    expect(byId[b.id]).toBe(false);
  });
});

describe('peer-management handlers — live isEnabled() closure (P-0658)', () => {
  it('peer:fleetEnabled reflects the LIVE closure, re-evaluated per call', async () => {
    handleCalls.clear();
    let enabled = false;
    setupPeerManagementHandlers({
      isEnabled: () => enabled,
      peerConfigManager: new PeerConfigManager(),
      pinnedCertStore: { removePin: vi.fn() } as any,
      secretStore: { remove: vi.fn() } as any,
      audit: new PeerAuditLog(() => {}, () => 0),
      getLinkManager: () => null,
    });

    expect(await getHandler('peer:fleetEnabled')()).toBe(false);
    enabled = true;
    expect(await getHandler('peer:fleetEnabled')()).toBe(true);
    enabled = false;
    expect(await getHandler('peer:fleetEnabled')()).toBe(false);
  });

  it('peer:list returns [] while disabled and real peers once the closure flips on', async () => {
    handleCalls.clear();
    let enabled = false;
    const cfg = new PeerConfigManager();
    cfg.add({ alias: 'Mac', address: 'h:1', pskRef: 'r' });
    setupPeerManagementHandlers({
      isEnabled: () => enabled,
      peerConfigManager: cfg,
      pinnedCertStore: { removePin: vi.fn() } as any,
      secretStore: { remove: vi.fn() } as any,
      audit: new PeerAuditLog(() => {}, () => 0),
      getLinkManager: () => null,
    });

    expect(await getHandler('peer:list')()).toEqual([]);
    enabled = true;
    expect((await getHandler('peer:list')()).length).toBe(1);
  });
});
