/**
 * Cross-Machine Fleet — end-to-end A↔B integration test (P-0651).
 *
 * Spins up TWO full fleet stacks on loopback TLS (127.0.0.1, ephemeral
 * ports): machine A (caller) and machine B (callee). Everything below the
 * SessionManager + mDNS boundary is REAL:
 *
 *   • real peer-crypto machine identity + self-signed cert per machine,
 *   • real PinnedCertStore / SecretStore / PeerConfigManager per machine,
 *   • real PeerLinkManager wiring the real RemoteLinkServer + RemoteLinkClient
 *     + real PeerLink over a real Node TLS WebSocket on 127.0.0.1,
 *   • real InboundCallGate on B (access flag + hard-deny + rate-limit + audit),
 *   • the REAL MCP dispatcher (callMcpTool) on B, over a tiny FAKE
 *     HelmControlService (the ONLY faked seam besides mDNS — see below),
 *   • A's caller side enters at the REAL HelmPeerService.call() (skipping
 *     callMcpTool's trivial peer_call arg-parsing on A), which forwards over
 *     the real PeerLinkManager.call → transport → B's gate + dispatcher.
 *
 * PRE-ESTABLISHED PAIRING: the SAS pairing handshake is already unit-tested in
 * P-0649 and the DECISIONS defer a real cross-machine pair-over-the-wire to a
 * separate QUESTION plan. So here we seed the paired state directly — the SAME
 * PSK in both SecretStores, each other's cert fingerprint pinned in both
 * PinnedCertStores, and a bidirectional PeerConfig on each side. The PSK
 * handshake, cert pinning and TLS are all still exercised for real on connect.
 *
 * FAKED SEAMS (and why):
 *   • SessionManager / HelmControlService — replaced by FakeControlService, a
 *     minimal in-memory stand-in exposing only listSessions(), getSession() +
 *     sendTextToSession() (all session_list / session_send_text touch). This is
 *     the SessionManager boundary the plan permits faking; the dispatcher that
 *     calls it is the REAL callMcpTool.
 *   • mDNS discovery — not involved at all in this test (pairing is
 *     pre-established), so nothing network-discovers anything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOrCreateMachineIdentity,
  getOrCreateSelfSignedCert,
  generatePsk,
  type MachineIdentity,
  type SelfSignedCert,
} from '../src/mcp/peer/peer-crypto.js';
import { PinnedCertStore } from '../src/mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';
import { PeerLinkManager } from '../src/mcp/peer/peer-link-manager.js';
import { RemoteLinkServer } from '../src/mcp/peer/remote-link-server.js';
import { RemoteLinkClient } from '../src/mcp/peer/remote-link-client.js';
import { InboundCallGate } from '../src/mcp/peer/inbound-call-gate.js';
import { PeerRateLimiter } from '../src/mcp/peer/rate-limiter.js';
import { PeerAuditLog } from '../src/mcp/peer/peer-audit-log.js';
import { HelmPeerService } from '../src/mcp/services/helm-peer-service.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import type { AuthContext } from '../src/mcp/tools/types.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal fake of HelmControlService — the ONLY session boundary faked.
 * Records every text delivery so the test can assert B's PTY "received" it, and
 * returns a fixed session list for session_list. Only the two methods the
 * tools under test reach are implemented.
 */
class FakeControlService {
  readonly writes: Array<{ sessionId: string; text: string; senderSessionId?: string }> = [];
  /**
   * The machine's OWN outbound fleet surface, injected once its PeerLinkManager
   * exists. This is the real HelmPeerService — so a fleet-addressed send leaves
   * this machine over the real link, exactly as in production.
   */
  private outbound?: { call(peer: string, tool: string, args: Record<string, unknown>): Promise<unknown> };

  constructor(private readonly sessions: Array<{ id: string; name: string }>) {}

  setOutbound(peerService: FakeControlService['outbound']): void {
    this.outbound = peerService;
  }

  listSessions() {
    return this.sessions.map((s) => ({ id: s.id, name: s.name }));
  }

  getSession(ref: string) {
    return this.sessions.find((s) => s.id === ref || s.name === ref) ?? null;
  }

  sendTextToSession(sessionRef: string, text: string, options: { senderSessionId?: string }) {
    this.writes.push({ sessionId: sessionRef, text, senderSessionId: options?.senderSessionId });
    return { delivered: true, sessionId: sessionRef };
  }

  peerCall(peer: string, tool: string, args: Record<string, unknown>) {
    if (!this.outbound) throw new Error('Fleet is not enabled');
    return this.outbound.call(peer, tool, args);
  }
}

/** Build the REAL dispatch closure the gate hands to the peer: real callMcpTool. */
function realDispatch(fake: FakeControlService) {
  return (method: string, params: unknown, ctx: AuthContext): Promise<unknown> =>
    callMcpTool(
      {
        service: fake as unknown as HelmControlService,
        setPlanStateWithValidation: () => ({}),
        completePlanWithValidation: () => ({}),
      },
      method,
      (params ?? {}) as Record<string, unknown>,
      ctx,
    );
}

/** A full per-machine fleet stack. */
interface Stack {
  machineId: string;
  identity: MachineIdentity;
  cert: SelfSignedCert;
  pins: PinnedCertStore;
  secrets: SecretStore;
  config: PeerConfigManager;
  audit: PeerAuditLog;
  fake: FakeControlService;
  manager: PeerLinkManager;
  peerService: HelmPeerService;
  port: number;
}

/** Short, deterministic PeerLink options so heartbeat/timeouts don't leak. */
const FAST_LINK = { requestTimeoutMs: 2000, heartbeatIntervalMs: 60_000, pongTimeoutMs: 30_000 };

const PSK_REF = 'psk-shared';
/** A's own local session — the origin, and the destination of any fleet reply. */
const A_SESSIONS = [
  { id: '33333333-3333-4333-8333-333333333333', name: 'origin-1' },
];
const B_SESSIONS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'worker-1' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'worker-2' },
];

/** Wait until `cond()` is true, polling briefly, or reject after `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('Cross-Machine Fleet E2E (A↔B over loopback TLS)', () => {
  let tmp: string;
  let A: Stack;
  let B: Stack;
  const psk = generatePsk();

  /** Build one machine's stack, wiring real crypto/stores/config. */
  function buildStack(
    label: string,
    sessions: Array<{ id: string; name: string }>,
  ): { partial: Omit<Stack, 'manager' | 'peerService' | 'port' | 'config'>; config: PeerConfigManager } {
    const identity = getOrCreateMachineIdentity(join(tmp, `${label}-identity.yaml`));
    // Cert generated lazily below (async) — placeholder filled in start().
    const pins = new PinnedCertStore(() => {});
    const secrets = new SecretStore(() => {});
    secrets.set(PSK_REF, psk); // SAME PSK on both sides (pre-established pairing).
    const config = new PeerConfigManager(() => {});
    const audit = new PeerAuditLog(() => {}, () => Date.now());
    audit.importAll([]); // start clean, no disk load
    const fake = new FakeControlService(sessions);
    return {
      partial: {
        machineId: identity.machineId,
        identity,
        cert: undefined as unknown as SelfSignedCert,
        pins,
        secrets,
        audit,
        fake,
      },
      config,
    };
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'fed-e2e-'));

    const a = buildStack('A', A_SESSIONS);
    const b = buildStack('B', B_SESSIONS);

    a.partial.cert = await getOrCreateSelfSignedCert(join(tmp, 'A-cert.yaml'));
    b.partial.cert = await getOrCreateSelfSignedCert(join(tmp, 'B-cert.yaml'));

    // ---- Bring up B's server FIRST to learn its ephemeral port. -----------
    // B's gate: A is allowed in; hard-denied tools stay blocked.
    const bGate = new InboundCallGate({
      peerConfig: b.config,
      dispatch: realDispatch(b.partial.fake),
      rateLimiter: new PeerRateLimiter({ capacity: 50, refillPerMs: 50 / 60000, now: () => Date.now() }),
      audit: b.partial.audit,
      now: () => Date.now(),
    });

    // A's gate is present but never exercised (A is the caller). Give it a
    // permissive rate-limiter + its own audit so the manager can construct.
    const aGate = new InboundCallGate({
      peerConfig: a.config,
      dispatch: realDispatch(a.partial.fake),
      rateLimiter: new PeerRateLimiter({ capacity: 50, refillPerMs: 50 / 60000, now: () => Date.now() }),
      audit: a.partial.audit,
      now: () => Date.now(),
    });

    // Build B's manager on an ephemeral port (server only for this phase).
    B = buildManager(b, bGate.handle.bind(bGate), 0);
    await B.manager.start();
    B.port = serverPort(B.manager);

    // Now write bidirectional PeerConfig referencing the resolved addresses.
    const aPeerForB = a.config.add({
      alias: 'machine-B',
      address: `127.0.0.1:${B.port}`,
      pskRef: PSK_REF,
      inbound: true,
      direction: 'bidirectional',
      machineId: b.partial.machineId,
    });

    // B must KNOW A (config + access) BEFORE A dials, so B's server can
    // resolve A's cert fp → the config id it tracks the inbound link under, and
    // apply A's access flag. The address is a placeholder until A's port is known
    // (only B's OUTBOUND dial to A needs the real address).
    const bPeerForA = b.config.add({
      alias: 'machine-A',
      address: '127.0.0.1:0',
      pskRef: PSK_REF,
      inbound: true,
      direction: 'bidirectional',
      machineId: a.partial.machineId,
    });

    // ---- Pre-establish the paired state: pin each peer's cert fp under the
    // CONFIG id it is tracked by (matching the real pinning key), in BOTH
    // directions. Done AFTER the configs exist so the ids are known. ----
    a.partial.pins.recordIfAbsent(aPeerForB.id, b.partial.cert.fingerprint);
    b.partial.pins.recordIfAbsent(bPeerForA.id, a.partial.cert.fingerprint);

    // Build A's manager (server on its own ephemeral port + client dialling B).
    A = buildManager(a, aGate.handle.bind(aGate), 0);
    await A.manager.start();
    A.port = serverPort(A.manager);

    // Now B knows A's real address — B dials A too (bidirectional path proven).
    b.config.update(bPeerForA.id, { address: `127.0.0.1:${A.port}` });
    B.manager.addPeer(b.config.get(bPeerForA.id)!);

    // Wait for the bidirectional links to CONVERGE (both dial → dedup settles)
    // so no test call races a link being dedup-replaced.
    await waitForConverged();
  });

  /** Wire a PeerLinkManager for a stack, injecting real Remote* factories. */
  function buildManager(
    built: { partial: Omit<Stack, 'manager' | 'peerService' | 'port' | 'config'>; config: PeerConfigManager },
    onCall: (peerId: string, method: string, params: unknown) => Promise<unknown>,
    port: number,
  ): Stack {
    const p = built.partial;
    const manager = new PeerLinkManager({
      machineId: p.machineId,
      listPeers: () => built.config.list(),
      resolvePsk: () => p.secrets.get(PSK_REF),
      getCertKey: async () => ({ certPem: p.cert.certPem, keyPem: p.cert.privateKeyPem }),
      pinnedCertStore: p.pins,
      onCall,
      host: '127.0.0.1',
      port,
      createServer: (o) => new RemoteLinkServer({
        ...o,
        // Resolve the observed cert fp back to the configured peerId so the
        // server tracks the inbound link under the config id (not the raw
        // machineId), matching the caller's peerId.
        resolveExpectedPeer: (fp) => built.config.list().find(
          (peer) => p.pins.get(peer.id) === fp,
        )?.id,
        authTimeoutMs: 3000,
        peerLinkOptions: FAST_LINK,
      }),
      createClient: (o) => new RemoteLinkClient({
        ...o,
        connectTimeoutMs: 3000,
        authTimeoutMs: 3000,
        baseBackoffMs: 25,
        maxBackoffMs: 100,
        stabilityResetMs: 60_000,
        rng: () => 0.5,
        peerLinkOptions: FAST_LINK,
      }),
    });
    const peerService = new HelmPeerService(() => manager);
    // Give the machine its own outbound fleet surface, so a fleet-addressed
    // session_send_text can leave it over the real link.
    p.fake.setOutbound(peerService);
    return {
      ...p,
      config: built.config,
      manager,
      peerService,
      port,
    } as Stack;
  }

  /** The config id under which A tracks B (B's peer entry on A). */
  function peerIdOnA(): string {
    return A.config.getByMachineId(B.machineId)!.id;
  }
  /** The config id under which B tracks A. */
  function peerIdOnB(): string {
    return B.config.getByMachineId(A.machineId)!.id;
  }

  /**
   * Wait until the bidirectional links have CONVERGED: both managers report the
   * peer online AND no link churn has occurred for a quiet window. Both peers
   * dial each other, so two links briefly coexist until dedup keeps the
   * min-machineId link and disposes the other ('dedup-replaced'). Issuing a call
   * before convergence can land on the link being replaced. This is deterministic:
   * after convergence there are ZERO peer-link events, so the quiet window always
   * settles; during convergence each accept/dispose bumps the timer.
   */
  async function waitForConverged(timeoutMs = 10_000, quietMs = 250): Promise<void> {
    const pa = peerIdOnA();
    const pb = peerIdOnB();
    let lastEvent = Date.now();
    const bump = (): void => { lastEvent = Date.now(); };
    const targets = [A.manager, B.manager];
    for (const m of targets) { m.on('peer-link:online', bump); m.on('peer-link:offline', bump); }
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const bothOnline = A.manager.status(pa) === 'online' && B.manager.status(pb) === 'online';
        if (bothOnline && Date.now() - lastEvent >= quietMs) return;
        if (Date.now() > deadline) throw new Error('links did not converge');
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      for (const m of targets) { m.off('peer-link:online', bump); m.off('peer-link:offline', bump); }
    }
  }

  afterEach(async () => {
    // Hard teardown — stop both managers, then assert no live links remain.
    await A?.manager.stop();
    await B?.manager.stop();
    if (A) expect(A.manager.status(peerIdSafe(A, B))).toBe('offline');
    if (B) expect(B.manager.status(peerIdSafe(B, A))).toBe('offline');
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('HAPPY PATH: A.peer_call(B, session_list) then session_send_text lands on B', async () => {
    const pid = peerIdOnA();

    // 1a. Discover B's sessions via the real HelmPeerService.call path.
    const listResult = (await A.peerService.call(pid, 'session_list', {})) as {
      structuredContent?: unknown;
    } | Array<{ id: string; name: string }>;
    // callMcpTool returns the raw service result; session_list returns an array.
    const sessions = listResult as unknown as Array<{ id: string; name: string }>;
    expect(sessions.map((s) => s.id)).toEqual(B_SESSIONS.map((s) => s.id));

    // 1b. Deliver text to one of B's sessions — assert B's fake PTY got it.
    const target = B_SESSIONS[0].id;
    await A.peerService.call(pid, 'session_send_text', { sessionId: target, text: 'hello from A' });

    expect(B.fake.writes).toHaveLength(1);
    expect(B.fake.writes[0].sessionId).toBe(target);
    expect(B.fake.writes[0].text).toBe('hello from A');
    // The proxy identity — never a real session, always peer:<peerId>.
    expect(B.fake.writes[0].senderSessionId).toBe(`peer:${peerIdOnB()}`);
  });

  it('ROUND TRIP: the reply address B is handed routes a reply back to A\'s real session', async () => {
    const originSessionId = A_SESSIONS[0].id;
    const target = B_SESSIONS[0].id;

    // 1. A asks B for a response, identifying its own local origin session.
    await A.peerService.call(peerIdOnA(), 'session_send_text', {
      sessionId: target,
      text: 'question from A',
      senderSessionId: originSessionId,
      expectsResponse: true,
    });

    // 2. B's gate wrapped A's session id under the peer id B knows A by. This is
    //    the EXACT string the HELM_MSG preamble hands B's LLM to reply to.
    const replyAddress = B.fake.writes[0].senderSessionId!;
    expect(replyAddress).toBe(`fleet:${peerIdOnB()}:${originSessionId}`);

    // 3. B's LLM replies to that address — a plain local session_send_text on B.
    await callMcpTool(
      {
        service: B.fake as unknown as HelmControlService,
        setPlanStateWithValidation: () => ({}),
        completePlanWithValidation: () => ({}),
      },
      'session_send_text',
      { sessionId: replyAddress, text: 'answer from B', senderSessionId: target },
      {},
    );

    // 4. The reply crossed the fleet and landed on A's REAL local session.
    await waitFor(() => A.fake.writes.length > 0);
    expect(A.fake.writes[0].sessionId).toBe(originSessionId);
    expect(A.fake.writes[0].text).toBe('answer from B');
    // A's gate wrapped B's sender in turn — the path is symmetric.
    expect(A.fake.writes[0].senderSessionId).toBe(`fleet:${peerIdOnA()}:${target}`);
  });

  it('DENY: once B stops letting A call in, A is rejected uniformly; B never dispatches', async () => {
    const pid = peerIdOnA();
    B.config.update(peerIdOnB(), { inbound: false });
    await expect(A.peerService.call(pid, 'session_send_text', { sessionId: B_SESSIONS[0].id, text: 'x' }))
      .rejects.toThrow(/Tool not permitted/);
    // No PTY write, no session dispatch happened on B.
    expect(B.fake.writes).toHaveLength(0);
  });

  it('AUDIT: B\'s PeerAuditLog records ok for allowed + denied for blocked, method names, NO arg values', async () => {
    const pid = peerIdOnA();
    await A.peerService.call(pid, 'session_list', {});
    await A.peerService.call(pid, 'session_send_text', { sessionId: B_SESSIONS[0].id, text: 'secret-body-xyz' });
    B.config.update(peerIdOnB(), { inbound: false });
    await expect(A.peerService.call(pid, 'session_get', { sessionId: 'zzz' })).rejects.toThrow();

    const bPeerId = peerIdOnB();
    const entries = B.audit.list().filter((e) => e.peerId === bPeerId);

    const byMethod = (m: string) => entries.filter((e) => e.method === m);
    expect(byMethod('session_list')[0].outcome).toBe('ok');
    expect(byMethod('session_send_text')[0].outcome).toBe('ok');
    expect(byMethod('session_get')[0].outcome).toBe('denied');

    // The audit must NOT contain any arg VALUES — only key names.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('secret-body-xyz');
    expect(serialized).not.toContain(B_SESSIONS[0].id);
    // argSummary is key-names only.
    const sendEntry = byMethod('session_send_text')[0];
    expect(sendEntry.argSummary).toMatch(/keys:/);
    expect(sendEntry.argSummary).toContain('text');
    expect(sendEntry.argSummary).toContain('sessionId');
  });

  it('RESILIENCE: B offline → clear error; B back → link recovers and a call succeeds', async () => {
    const pid = peerIdOnA();

    // Sanity: link is up.
    await A.peerService.call(pid, 'session_list', {});

    // Stop B entirely → A's link drops.
    await B.manager.stop();
    await waitFor(() => A.manager.status(pid) === 'offline', 10_000);

    // A call now fails with a clear, non-crashing error.
    await expect(A.peerService.call(pid, 'session_list', {}))
      .rejects.toThrow(/No live link to peer/);

    // Restart B's stack on the SAME port (its client reconnect backoff is short).
    const bGate = new InboundCallGate({
      peerConfig: B.config,
      dispatch: realDispatch(B.fake),
      rateLimiter: new PeerRateLimiter({ capacity: 50, refillPerMs: 50 / 60000, now: () => Date.now() }),
      audit: B.audit,
      now: () => Date.now(),
    });
    const revived = new PeerLinkManager({
      machineId: B.machineId,
      listPeers: () => B.config.list(),
      resolvePsk: () => B.secrets.get(PSK_REF),
      getCertKey: async () => ({ certPem: B.cert.certPem, keyPem: B.cert.privateKeyPem }),
      pinnedCertStore: B.pins,
      onCall: bGate.handle.bind(bGate),
      host: '127.0.0.1',
      port: B.port,
      createServer: (o) => new RemoteLinkServer({
        ...o,
        resolveExpectedPeer: (fp) => B.config.list().find((peer) => B.pins.get(peer.id) === fp)?.id,
        authTimeoutMs: 3000,
        peerLinkOptions: FAST_LINK,
      }),
      createClient: (o) => new RemoteLinkClient({
        ...o, connectTimeoutMs: 3000, authTimeoutMs: 3000,
        baseBackoffMs: 25, maxBackoffMs: 100, rng: () => 0.5, peerLinkOptions: FAST_LINK,
      }),
    });
    await revived.start();
    B.manager = revived;

    // A's client auto-reconnects (short backoff) → link recovers. Generous
    // ceiling: the reconnect drives real RSA/X25519 TLS+PSK handshakes whose
    // wall-clock varies under full-suite CPU contention; waitFor resolves the
    // instant the link is online, so headroom never slows the happy path.
    await waitFor(() => A.manager.status(pid) === 'online', 20_000);
    // Let the re-established bidirectional links converge before calling.
    await waitForConverged();

    // A subsequent call succeeds again.
    const result = (await A.peerService.call(pid, 'session_list', {})) as Array<{ id: string }>;
    expect(result.map((s) => s.id)).toEqual(B_SESSIONS.map((s) => s.id));
  });
});

/** The bound server port for a manager (reaches into the injected server). */
function serverPort(manager: PeerLinkManager): number {
  const server = (manager as unknown as { server: RemoteLinkServer }).server;
  const addr = server.address();
  if (!addr) throw new Error('server not listening');
  return addr.port;
}

/** peerId under which `self` tracks `other`, or a dummy if config gone. */
function peerIdSafe(self: Stack, other: Stack): string {
  return self.config.getByMachineId(other.machineId)?.id ?? '__none__';
}
