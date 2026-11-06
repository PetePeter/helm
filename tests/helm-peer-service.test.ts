/**
 * HelmPeerService — the local-side surface for peer_list / peer_tools / peer_call.
 * Backed by a FAKE in-memory PeerLinkManager so we assert exactly what method +
 * args are forwarded over the link (the real transport is covered by P-0646/P-0651).
 */

import { describe, it, expect } from 'vitest';
import { HelmPeerService } from '../src/mcp/services/helm-peer-service.js';
import { RESERVED_PEER_TOOLS_METHOD, HARD_DENY_TOOLS } from '../src/mcp/peer/inbound-call-gate.js';

interface CallRecord {
  peerId: string;
  method: string;
  params: unknown;
}

/**
 * A fake PeerLinkManager exposing only the surface HelmPeerService depends on:
 * list() + call(). Records every call() so tests can assert verbatim forwarding.
 */
class FakePeerLinkManager {
  readonly calls: CallRecord[] = [];
  callResult: unknown = { ok: true };
  callImpl?: (peerId: string, method: string, params: unknown) => Promise<unknown>;

  constructor(
    private readonly peers: Array<{ id: string; alias: string; direction: 'inbound' | 'outbound' | 'bidirectional'; online: boolean }>,
  ) {}

  list() {
    return this.peers;
  }

  call(peerId: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ peerId, method, params });
    if (this.callImpl) return this.callImpl(peerId, method, params);
    return Promise.resolve(this.callResult);
  }
}

function serviceWith(manager: FakePeerLinkManager | undefined) {
  return new HelmPeerService(() => manager as never);
}

describe('HelmPeerService', () => {
  it('list() returns configured peers with online flags', () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: true },
      { id: 'pi', alias: 'the Pi', direction: 'outbound', online: false },
    ]);
    const svc = serviceWith(mgr);
    expect(svc.list()).toEqual({
      peers: [
        { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: true },
        { id: 'pi', alias: 'the Pi', direction: 'outbound', online: false },
      ],
    });
  });

  it('tools() forwards the reserved sentinel method verbatim and returns the remote tool list', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: true },
    ]);
    const remoteTools = [
      { name: 'session_list', title: 'List Sessions', description: 'd', inputSchema: { type: 'object' } },
    ];
    mgr.callResult = { tools: remoteTools };
    const svc = serviceWith(mgr);

    const result = await svc.tools('mac');

    expect(result).toEqual({ peerId: 'mac', tools: remoteTools });
    expect(mgr.calls).toHaveLength(1);
    expect(mgr.calls[0].method).toBe(RESERVED_PEER_TOOLS_METHOD);
    expect(mgr.calls[0].peerId).toBe('mac');
    expect(mgr.calls[0].params).toEqual({});
  });

  it('call() forwards tool + args VERBATIM (no mutation) and returns the remote result', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: true },
    ]);
    mgr.callResult = { ok: 42 };
    const svc = serviceWith(mgr);
    const args = { sessionId: 'dest', text: 'hi', nested: { a: 1 } };

    const result = await svc.call('mac', 'session_send_text', args);

    expect(result).toEqual({ ok: 42 });
    expect(mgr.calls).toHaveLength(1);
    expect(mgr.calls[0].peerId).toBe('mac');
    expect(mgr.calls[0].method).toBe('session_send_text');
    // Reference identity — a future {...args} spread/clone would break this.
    expect(mgr.calls[0].params).toBe(args);
    expect(mgr.calls[0].params).toEqual(args); // deep-equal, no mutation
  });

  it('call() trims the tool name and rejects a whitespace-padded guarded method pre-send', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    await expect(svc.call('mac', ' peer_call', {})).rejects.toThrow(/not permitted for peer calls/i);
    await expect(svc.call('mac', '  __peer_tools__ ', {})).rejects.toThrow(/not permitted for peer calls/i);
    expect(mgr.calls).toHaveLength(0); // never sent
  });

  it('call() forwards the TRIMMED tool name for a legit padded method', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    await svc.call('mac', '  session_send_text  ', { text: 'hi' });
    expect(mgr.calls).toHaveLength(1);
    expect(mgr.calls[0].method).toBe('session_send_text'); // trimmed
  });

  it('call() surfaces an offline/unknown/timeout peer as a clear Error, not a crash', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: false },
    ]);
    mgr.callImpl = () => Promise.reject(new Error('No live link to peer mac'));
    const svc = serviceWith(mgr);

    await expect(svc.call('mac', 'session_list', {})).rejects.toThrow(/No live link to peer mac/);
  });

  it('tools() surfaces an offline/unknown peer as a clear Error', async () => {
    const mgr = new FakePeerLinkManager([]);
    mgr.callImpl = () => Promise.reject(new Error('No live link to peer ghost'));
    const svc = serviceWith(mgr);
    await expect(svc.tools('ghost')).rejects.toThrow(/No live link to peer ghost/);
  });

  it('call() rejects client-side (pre-send) a tool starting with peer_', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    await expect(svc.call('mac', 'peer_call', {})).rejects.toThrow(/not permitted for peer calls/i);
    expect(mgr.calls).toHaveLength(0); // never sent
  });

  it('call() rejects client-side the reserved meta-method', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    await expect(svc.call('mac', RESERVED_PEER_TOOLS_METHOD, {})).rejects.toThrow(/not permitted for peer calls/i);
    expect(mgr.calls).toHaveLength(0);
  });

  it('call() rejects client-side an empty tool name', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    await expect(svc.call('mac', '', {})).rejects.toThrow(/not permitted for peer calls/i);
    expect(mgr.calls).toHaveLength(0);
  });

  it('call() rejects client-side each HARD_DENY tool (defense in depth)', async () => {
    const mgr = new FakePeerLinkManager([
      { id: 'mac', alias: 'm', direction: 'bidirectional', online: true },
    ]);
    const svc = serviceWith(mgr);
    for (const tool of HARD_DENY_TOOLS) {
      await expect(svc.call('mac', tool, {})).rejects.toThrow(/not permitted for peer calls/i);
    }
    expect(mgr.calls).toHaveLength(0);
  });

  it('fleet OFF (no manager): list/tools/call all throw "Fleet is not enabled"', async () => {
    const svc = serviceWith(undefined);
    expect(() => svc.list()).toThrow(/Fleet is not enabled/);
    await expect(svc.tools('mac')).rejects.toThrow(/Fleet is not enabled/);
    await expect(svc.call('mac', 'session_list', {})).rejects.toThrow(/Fleet is not enabled/);
  });

  it('CLEARING the manager (live disable) reverts to "Fleet is not enabled" (P-0658)', async () => {
    // The getter mirrors HelmControlService.setPeerLinkManager(null) at runtime:
    // a live manager, then cleared when fleet is toggled OFF in-app.
    let manager: FakePeerLinkManager | null = new FakePeerLinkManager([
      { id: 'mac', alias: 'the Mac', direction: 'bidirectional', online: true },
    ]);
    const svc = new HelmPeerService(() => (manager ?? undefined) as never);

    // While wired, the surface works.
    expect(svc.list().peers).toHaveLength(1);

    // Live disable clears the manager (null, as setPeerLinkManager(null) does).
    manager = null;
    expect(() => svc.list()).toThrow(/Fleet is not enabled/);
    await expect(svc.tools('mac')).rejects.toThrow(/Fleet is not enabled/);
    await expect(svc.call('mac', 'session_list', {})).rejects.toThrow(/Fleet is not enabled/);
  });
});
