/**
 * Dispatcher fleet routing — the two halves of the cross-machine reply path for
 * `session_send_text` (P-0002):
 *
 *   SENDER side — a `fleet:<peerId>:<id>` senderSessionId is a REMOTE session, so
 *   it must skip the local known-session validation and reach the delivery
 *   service verbatim (it is what the HELM_MSG preamble tells the recipient to
 *   reply to).
 *   TARGET side — a `fleet:<peerId>:<id>` sessionId is a REMOTE destination, so
 *   the call is forwarded to that peer with the real id unwrapped.
 *
 * The real dispatcher runs against a fake HelmControlService recording both the
 * local delivery surface and the outbound peer surface.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import type { McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';

const LOCAL_SESSION = { id: randomUUID(), name: 'local-worker' };
const REMOTE_SESSION_ID = randomUUID();
const FLEET_SENDER = `fleet:mac:${REMOTE_SESSION_ID}`;
const FLEET_TARGET = `fleet:mac:${REMOTE_SESSION_ID}`;

interface SendCall {
  sessionRef: string;
  text: string;
  options: { senderSessionId?: string; senderSessionName?: string; expectsResponse?: boolean };
}
interface PeerCall {
  peer: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Fake control service exposing only the surface session_send_text reaches. */
class FakeService {
  readonly sends: SendCall[] = [];
  readonly peerCalls: PeerCall[] = [];
  constructor(
    private readonly sessions: Array<{ id: string; name: string }> = [LOCAL_SESSION],
    private readonly peerCallImpl: (peer: string, tool: string, args: Record<string, unknown>) => unknown =
      () => ({ delivered: true }),
  ) {}

  listSessions() {
    return this.sessions.map((s) => ({ id: s.id, name: s.name }));
  }

  sendTextToSession(sessionRef: string, text: string, options: SendCall['options']) {
    this.sends.push({ sessionRef, text, options });
    return { delivered: true, sessionId: sessionRef };
  }

  peerCall(peer: string, tool: string, args: Record<string, unknown>) {
    this.peerCalls.push({ peer, tool, args });
    return this.peerCallImpl(peer, tool, args);
  }
}

function deps(service: FakeService): McpToolDispatcherDeps {
  return {
    service: service as unknown as HelmControlService,
    setPlanStateWithValidation: () => ({}),
    completePlanWithValidation: () => ({}),
  };
}

const send = (service: FakeService, args: Record<string, unknown>) =>
  callMcpTool(deps(service), 'session_send_text', args, {});

describe('session_send_text — fleet SENDER', () => {
  it('skips local validation and forwards the wrapped id to the delivery service', async () => {
    const service = new FakeService();
    await send(service, {
      sessionId: LOCAL_SESSION.id,
      text: 'hello',
      senderSessionId: FLEET_SENDER,
    });

    expect(service.sends).toHaveLength(1);
    expect(service.sends[0].sessionRef).toBe(LOCAL_SESSION.id);
    expect(service.sends[0].options.senderSessionId).toBe(FLEET_SENDER);
  });

  it('does not throw "Unknown sender session" even with no local sessions at all', async () => {
    const service = new FakeService([]);
    await expect(
      send(service, { sessionId: 'dest', text: 'hello', senderSessionId: FLEET_SENDER }),
    ).resolves.toBeDefined();
  });

  it('labels the sender with a non-empty remote name for the HELM_MSG envelope', async () => {
    const service = new FakeService();
    await send(service, { sessionId: LOCAL_SESSION.id, text: 'hi', senderSessionId: FLEET_SENDER });

    expect(service.sends[0].options.senderSessionName).toBeTruthy();
  });
});

describe('session_send_text — fleet TARGET', () => {
  it('forwards to the peer with the real session id unwrapped, bypassing local delivery', async () => {
    const service = new FakeService();
    const result = await send(service, {
      sessionId: FLEET_TARGET,
      text: 'reply body',
      senderSessionId: LOCAL_SESSION.id,
    });

    expect(service.sends).toHaveLength(0); // never delivered locally
    expect(service.peerCalls).toEqual([
      {
        peer: 'mac',
        tool: 'session_send_text',
        args: { sessionId: REMOTE_SESSION_ID, text: 'reply body', senderSessionId: LOCAL_SESSION.id },
      },
    ]);
    expect(result).toEqual({ delivered: true });
  });

  it('forwards expectsResponse when the caller sets it', async () => {
    const service = new FakeService();
    await send(service, {
      sessionId: FLEET_TARGET,
      text: 'ping',
      senderSessionId: LOCAL_SESSION.id,
      expectsResponse: true,
    });

    expect(service.peerCalls[0].args.expectsResponse).toBe(true);
  });

  it('surfaces the peer error unchanged when the link is offline', async () => {
    const service = new FakeService([LOCAL_SESSION], () => {
      throw new Error('No live link to peer mac');
    });

    await expect(
      send(service, { sessionId: FLEET_TARGET, text: 'x', senderSessionId: LOCAL_SESSION.id }),
    ).rejects.toThrow(/No live link to peer mac/);
  });

  it('rejects a malformed fleet target rather than forwarding a broken id', async () => {
    const service = new FakeService();
    await expect(
      send(service, { sessionId: 'fleet:mac', text: 'x', senderSessionId: LOCAL_SESSION.id }),
    ).rejects.toThrow();
    expect(service.peerCalls).toHaveLength(0);
  });
});

describe('session_send_input — fleet sender', () => {
  /**
   * Regression guard: before senderSessionId was wrapped it was STRIPPED, so a
   * peer's send_input silently fell back to the proxy identity and worked. The
   * wrapped id must be accepted the same way, or remote input breaks.
   */
  it('accepts a fleet-addressed sender without a local session lookup', async () => {
    const service = new FakeService();
    const inputs: Array<{ options: { senderSessionId?: string } }> = [];
    (service as unknown as Record<string, unknown>).sendInputToSession = (
      _ref: string,
      _seq: string,
      options: { senderSessionId?: string },
    ) => {
      inputs.push({ options });
      return { delivered: true };
    };

    await callMcpTool(
      deps(service),
      'session_send_input',
      { sessionId: LOCAL_SESSION.id, sequence: '{Enter}', senderSessionId: FLEET_SENDER },
      {},
    );

    expect(inputs[0].options.senderSessionId).toBe(FLEET_SENDER);
  });
});

describe('session_send_text — local behaviour is unaffected', () => {
  it('still delivers locally for a plain session id and a known local sender', async () => {
    const service = new FakeService();
    await send(service, {
      sessionId: LOCAL_SESSION.id,
      text: 'local hello',
      senderSessionId: LOCAL_SESSION.id,
    });

    expect(service.peerCalls).toHaveLength(0);
    expect(service.sends[0].options.senderSessionName).toBe(LOCAL_SESSION.name);
  });

  it('still rejects an unknown LOCAL sender session', async () => {
    const service = new FakeService();
    await expect(
      send(service, { sessionId: LOCAL_SESSION.id, text: 'x', senderSessionId: randomUUID() }),
    ).rejects.toThrow(/Unknown sender session/);
  });
});

/**
 * Remote rows (`peer_attach`): the row's artifacts live with the CLI on the
 * owning peer, so session-addressed artifact READS for a remote row are
 * forwarded there under the owner's session id — the renderer, the phone and
 * local AIs all see the owner's artifacts without knowing the row is remote.
 */
describe('session_artifact_* — Remote rows forward to the owning peer', () => {
  class RemoteAwareService extends FakeService {
    readonly localReads: string[] = [];
    constructor(private readonly rows: Record<string, { remote?: { peerId: string; sessionId: string } }>) {
      super([], (_peer, tool) => ({ forwarded: tool }));
    }
    getSession(id: string) { return this.rows[id] ? { id, ...this.rows[id] } : null; }
    listArtifacts(id: string) { this.localReads.push(id); return []; }
    readArtifact(id: string) { this.localReads.push(id); return {}; }
  }

  it('forwards list and get for a remote row with the owner-side session id', async () => {
    const service = new RemoteAwareService({ 'remote-1': { remote: { peerId: 'mac', sessionId: 'h1' } } });
    const call = (tool: string, args: Record<string, unknown>) =>
      callMcpTool(deps(service), tool, args, {});

    await expect(call('session_artifact_list', { sessionId: 'remote-1' })).resolves.toEqual({ forwarded: 'session_artifact_list' });
    await call('session_artifact_get', { sessionId: 'remote-1', artifactId: 'a1' });

    expect(service.peerCalls).toEqual([
      { peer: 'mac', tool: 'session_artifact_list', args: { sessionId: 'h1' } },
      { peer: 'mac', tool: 'session_artifact_get', args: { sessionId: 'h1', artifactId: 'a1' } },
    ]);
    expect(service.localReads).toEqual([]);
  });

  it('a local row is served locally, never forwarded', async () => {
    const service = new RemoteAwareService({ local: {} });
    await callMcpTool(deps(service), 'session_artifact_list', { sessionId: 'local' }, {});
    expect(service.peerCalls).toEqual([]);
    expect(service.localReads).toEqual(['local']);
  });
});
