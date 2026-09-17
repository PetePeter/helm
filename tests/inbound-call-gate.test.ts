/**
 * InboundCallGate — the remote-peer security boundary. Real gate wired to a real
 * PeerRateLimiter and real PeerAuditLog; the dispatcher is an injected fake so
 * we can assert exactly what identity/args it receives without running the whole
 * MCP stack. This mirrors the fakes>mocks preference.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InboundCallGate,
  HARD_DENY_TOOLS,
  GateError,
  RESERVED_PEER_TOOLS_METHOD,
  wrapCallerIdentityOverrides,
} from '../src/mcp/peer/inbound-call-gate.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { PeerRateLimiter } from '../src/mcp/peer/rate-limiter.js';
import { PeerAuditLog } from '../src/mcp/peer/peer-audit-log.js';
import { isProxySessionId } from '../src/mcp/peer/proxy-identity.js';
import type { AuthContext } from '../src/mcp/tools/types.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/**
 * A peerConfig fake exposing isToolAllowed + get (the surface the gate needs).
 * `enabledMap[peerId] === false` marks that peer explicitly disabled; a peerId
 * absent from the map returns undefined from get() (unknown/legacy peer), and any
 * other value is treated as enabled (default-true) by the gate.
 */
function fakePeerConfig(rules: Record<string, string[]>, enabledMap: Record<string, boolean> = {}) {
  return {
    isToolAllowed(peerId: string, tool: string): boolean {
      const allow = rules[peerId] ?? [];
      return allow.some(p => p === '*' || p === tool);
    },
    get(peerId: string): { enabled?: boolean } | undefined {
      if (!(peerId in enabledMap)) return undefined;
      return { enabled: enabledMap[peerId] };
    },
  };
}

interface Built {
  gate: InboundCallGate;
  audit: PeerAuditLog;
  calls: Array<{ method: string; params: unknown; ctx: AuthContext }>;
}

function build(
  rules: Record<string, string[]>,
  opts: {
    now?: () => number;
    dispatchImpl?: (method: string, params: unknown, ctx: AuthContext) => Promise<unknown>;
    capacity?: number;
    enabledMap?: Record<string, boolean>;
    sessionLookup?: {
      getSession(sessionId: string): { createdByPeerId?: string } | null;
      findByName(name: string): { createdByPeerId?: string } | undefined;
    };
  } = {},
): Built {
  const now = opts.now ?? (() => 0);
  const calls: Built['calls'] = [];
  const dispatch = async (method: string, params: unknown, ctx: AuthContext) => {
    calls.push({ method, params, ctx });
    if (opts.dispatchImpl) return opts.dispatchImpl(method, params, ctx);
    return { ok: true };
  };
  const audit = new PeerAuditLog(() => {}, now);
  audit.importAll([]); // start clean — the constructor otherwise hydrates from the real on-disk log
  const rateLimiter = new PeerRateLimiter({
    capacity: opts.capacity ?? 100,
    refillPerMs: 100 / 60000,
    now,
  });
  const gate = new InboundCallGate({
    peerConfig: fakePeerConfig(rules, opts.enabledMap),
    dispatch,
    rateLimiter,
    audit,
    sessionLookup: opts.sessionLookup,
    now,
  });
  return { gate, audit, calls };
}

describe('InboundCallGate', () => {
  it('dispatches an allowed tool once with a PROXY identity and returns the result', async () => {
    const { gate, audit, calls } = build({ mac: ['artifact_get'] });
    const result = await gate.handle('mac', 'artifact_get', { id: 'x' });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('artifact_get');
    expect(calls[0].ctx.sessionId).toBe('peer:mac');
    expect(isProxySessionId(calls[0].ctx.sessionId)).toBe(true);

    const log = audit.list();
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe('ok');
    expect(log[0].method).toBe('artifact_get');
  });

  it('denies a disallowed tool: uniform error, no dispatch, audit denied', async () => {
    const { gate, audit, calls } = build({ mac: ['artifact_get'] });
    await expect(gate.handle('mac', 'scheduler_list', {})).rejects.toMatchObject({
      code: -32000,
      message: 'Tool not permitted',
    });
    expect(calls).toHaveLength(0);
    expect(audit.list()[0].outcome).toBe('denied');
  });

  it('hard-denies helm_restart even with a wildcard allow-list', async () => {
    const { gate, audit, calls } = build({ mac: ['*'] });
    await expect(gate.handle('mac', 'helm_restart', {})).rejects.toMatchObject({
      code: -32000,
      message: 'Tool not permitted',
    });
    expect(calls).toHaveLength(0);
    expect(audit.list()[0].outcome).toBe('denied');
    expect(HARD_DENY_TOOLS.has('helm_restart')).toBe(true);
  });

  it('hard-deny and allow-list-deny are indistinguishable (no existence leak)', async () => {
    const { gate } = build({ mac: ['*'] });
    let hardMsg = '';
    let allowMsg = '';
    await gate.handle('mac', 'helm_restart', {}).catch(e => { hardMsg = e.message; });
    // deny a tool the wildcard would allow by using a peer with an empty list
    const { gate: gate2 } = build({ mac: [] });
    await gate2.handle('mac', 'artifact_get', {}).catch(e => { allowMsg = e.message; });
    expect(hardMsg).toBe(allowMsg);
    expect(hardMsg).toBe('Tool not permitted');
  });

  describe('disabled-peer gate (Off means off in both directions)', () => {
    it('denies a call from an explicitly-disabled peer: uniform message, no dispatch, audit denied', async () => {
      const { gate, audit, calls } = build(
        { mac: ['*'] },                       // allow-list would otherwise permit it
        { enabledMap: { mac: false } },       // …but the peer is disabled
      );
      await expect(gate.handle('mac', 'artifact_get', { id: 'x' })).rejects.toMatchObject({
        code: -32000,
        message: 'Tool not permitted',        // identical to allow-list-deny (no leak)
      });
      expect(calls).toHaveLength(0);
      expect(audit.list()[0].outcome).toBe('denied');
    });

    it('denies the reserved __peer_tools__ enumeration for a disabled peer', async () => {
      const { gate, audit, calls } = build(
        { mac: ['*'] },
        { enabledMap: { mac: false } },
      );
      await expect(gate.handle('mac', RESERVED_PEER_TOOLS_METHOD, {})).rejects.toMatchObject({
        code: -32000,
        message: 'Tool not permitted',
      });
      expect(calls).toHaveLength(0);
      expect(audit.list()[0].outcome).toBe('denied');
    });

    it('an enabled peer (enabled:true) still works normally', async () => {
      const { gate, calls } = build(
        { mac: ['artifact_get'] },
        { enabledMap: { mac: true } },
      );
      expect(await gate.handle('mac', 'artifact_get', {})).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
    });

    it('a peer with no config-provided enabled flag (undefined) is treated as enabled', async () => {
      // enabledMap omits 'mac' → get() returns undefined → default-true.
      const { gate, calls } = build({ mac: ['artifact_get'] }, {});
      expect(await gate.handle('mac', 'artifact_get', {})).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
    });
  });

  it('rate-limits past capacity: burst passes, next rejected, refill re-allows', async () => {
    let t = 0;
    const { gate, audit } = build(
      { mac: ['*'] },
      { now: () => t, capacity: 2 },
    );
    expect(await gate.handle('mac', 'artifact_get', {})).toEqual({ ok: true });
    expect(await gate.handle('mac', 'artifact_get', {})).toEqual({ ok: true });
    await expect(gate.handle('mac', 'artifact_get', {})).rejects.toMatchObject({
      code: -32000,
      message: 'Rate limit exceeded',
    });
    expect(audit.list()[0].outcome).toBe('rate-limited');

    // refillPerMs = 2/60000 → need 30000ms for one token
    t += 60000;
    expect(await gate.handle('mac', 'artifact_get', {})).toEqual({ ok: true });
  });

  it('records only arg KEY NAMES in the audit — never values/secrets', async () => {
    const { gate, audit } = build({ mac: ['*'] });
    await gate.handle('mac', 'session_create', {
      workingDir: 'C:/x',
      psk: 'hunter2-super-secret',
    });
    const rec = audit.list()[0];
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain('hunter2-super-secret');
    expect(serialized).not.toContain('C:/x');
    expect(rec.argSummary).toContain('workingDir');
    expect(rec.argSummary).toContain('psk'); // the KEY name is fine; the value is not
  });

  it('rethrows a dispatch error as -32000 with the full message on the wire', async () => {
    const { gate } = build(
      { mac: ['*'] },
      { dispatchImpl: async () => { throw new Error('boom internal detail'); } },
    );
    await expect(gate.handle('mac', 'artifact_get', {})).rejects.toMatchObject({
      code: -32000,
      message: 'boom internal detail',
    });
  });

  it('C-2: the persisted audit error stores the error TYPE only, never the message/values', async () => {
    class SessionNotFoundError extends Error {}
    const secret = 'Session not found: 11111111-1111-1111-1111-111111111111';
    const { gate, audit } = build(
      { mac: ['*'] },
      { dispatchImpl: async () => { throw new SessionNotFoundError(secret); } },
    );
    await expect(gate.handle('mac', 'session_send_text', { sessionId: 'dest', text: 'hi' }))
      .rejects.toMatchObject({ code: -32000, message: secret }); // wire still carries it

    const rec = audit.list()[0];
    expect(rec.outcome).toBe('error');
    expect(rec.error).toBe('SessionNotFoundError'); // TYPE only
    // The value-bearing message must be ENTIRELY absent from the stored entry.
    expect(JSON.stringify(rec)).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(JSON.stringify(rec)).not.toContain('Session not found');
  });

  it('proxy identity is stable per peer, distinct across peers, never a real uuid', async () => {
    const seen: string[] = [];
    const { gate } = build(
      { a: ['*'], b: ['*'] },
      { dispatchImpl: async (_m, _p, ctx) => { seen.push(ctx.sessionId!); return 1; } },
    );
    await gate.handle('a', 'artifact_get', {});
    await gate.handle('a', 'artifact_get', {});
    await gate.handle('b', 'artifact_get', {});
    expect(seen[0]).toBe(seen[1]);       // stable per peer
    expect(seen[0]).not.toBe(seen[2]);   // distinct per peer
    const realId = randomUUID();
    expect(seen).not.toContain(realId);
    expect(seen.every(isProxySessionId)).toBe(true);
  });

  it('GateError carries a JSON-RPC code/message shape', () => {
    const err = new GateError(-32000, 'Tool not permitted');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(-32000);
    expect(err.message).toBe('Tool not permitted');
  });

  it('C-1: wraps senderSessionId as a fleet address so a peer cannot impersonate a real session', async () => {
    let received: Record<string, unknown> | undefined;
    let ctxSeen: AuthContext | undefined;
    const { gate } = build(
      { peer1: ['session_send_text'] },
      {
        dispatchImpl: async (_m, params, ctx) => {
          received = params as Record<string, unknown>;
          ctxSeen = ctx;
          return { ok: true };
        },
      },
    );
    await gate.handle('peer1', 'session_send_text', {
      sessionId: 'dest',
      text: 'hi',
      senderSessionId: '11111111-1111-1111-1111-111111111111',
    });
    expect(received).toBeDefined();
    // Wrapped, never raw — the real UUID can no longer name a local session.
    expect(received!.senderSessionId).toBe('fleet:peer1:11111111-1111-1111-1111-111111111111');
    expect(received!.sessionId).toBe('dest');            // destination preserved
    expect(received!.text).toBe('hi');                   // non-identity arg preserved
    expect(ctxSeen!.sessionId).toBe('peer:peer1');       // proxy is the only identity
  });

  it('I-1: denies session_close without sessionLookup (safe fallback — no ownership data)', async () => {
    const { gate, calls } = build({ mac: ['*'] });
    await expect(gate.handle('mac', 'session_close', { sessionId: 'x' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    expect(HARD_DENY_TOOLS.has('session_close')).toBe(false); // no longer hard-denied
  });

  it('I-1: hard-denies session_group_close even with a wildcard allow-list', async () => {
    const { gate, calls } = build({ mac: ['*'] });
    await expect(gate.handle('mac', 'session_group_close', { groupId: 'g' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    expect(HARD_DENY_TOOLS.has('session_group_close')).toBe(true);
  });
});

describe('InboundCallGate — reserved __peer_tools__ meta-method', () => {
  it('returns MCP_TOOLS filtered by allow-list ∩ not-hard-denied; never dispatches', async () => {
    // Allow-list grants a set of session_* tools plus the hard-denied
    // helm_restart: those must STILL be excluded (hard-deny),
    // a non-allowed tool (artifact_get) must be absent.
    // session_close is NOT hard-denied (ownership-gated), so it appears.
    const { gate, calls } = build({
      mac: ['session_list', 'session_create', 'helm_restart', 'session_close'],
    });

    const result = (await gate.handle('mac', RESERVED_PEER_TOOLS_METHOD, {})) as {
      tools: Array<{ name: string; title: string; description: string; inputSchema: unknown }>;
    };
    const names = result.tools.map(t => t.name);

    // allow-listed, catalogued, not hard-denied → present
    expect(names).toContain('session_list');
    expect(names).toContain('session_create');
    expect(names).toContain('session_close'); // ownership-gated, NOT hard-denied
    // hard-denied tool EXCLUDED even though allow-listed
    expect(names).not.toContain('helm_restart');
    // non-allowed tool absent
    expect(names).not.toContain('artifact_get');

    // every returned tool carries the exposed shape
    for (const t of result.tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.title).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
    }

    // NEVER dispatched through callMcpTool
    expect(calls).toHaveLength(0);
  });

  it('is audited as ok and counts against the rate-limit bucket', async () => {
    let t = 0;
    const { gate, audit } = build({ mac: ['session_list'] }, { now: () => t, capacity: 1 });

    const first = (await gate.handle('mac', RESERVED_PEER_TOOLS_METHOD, {})) as { tools: unknown[] };
    expect(Array.isArray(first.tools)).toBe(true);

    // audited as ok with the sentinel method name
    const rec = audit.list()[0];
    expect(rec.outcome).toBe('ok');
    expect(rec.method).toBe(RESERVED_PEER_TOOLS_METHOD);

    // it consumed the single token → next call is rate-limited
    await expect(gate.handle('mac', RESERVED_PEER_TOOLS_METHOD, {}))
      .rejects.toMatchObject({ code: -32000, message: 'Rate limit exceeded' });
  });

  it('exposes exactly the intersection with MCP_TOOLS (no invented tools)', async () => {
    const { gate } = build({ mac: ['*'] });
    const result = (await gate.handle('mac', RESERVED_PEER_TOOLS_METHOD, {})) as {
      tools: Array<{ name: string }>;
    };
    const definedNames = new Set(MCP_TOOLS.map(t => t.name));
    for (const t of result.tools) {
      expect(definedNames.has(t.name)).toBe(true);
      expect(HARD_DENY_TOOLS.has(t.name)).toBe(false);
    }
  });
});

describe('wrapCallerIdentityOverrides', () => {
  it('WRAPS senderSessionId under the calling peer, preserving everything else', () => {
    const out = wrapCallerIdentityOverrides('mac', {
      sessionId: 'dest',
      text: 'hi',
      senderSessionId: 'real-uuid',
    }) as Record<string, unknown>;
    expect(out).toEqual({ sessionId: 'dest', text: 'hi', senderSessionId: 'fleet:mac:real-uuid' });
  });

  it('never passes a caller-supplied session id through RAW — impersonation stays impossible', () => {
    const localSessionUuid = randomUUID();
    const out = wrapCallerIdentityOverrides('mac', {
      senderSessionId: localSessionUuid,
    }) as Record<string, unknown>;
    expect(out.senderSessionId).not.toBe(localSessionUuid);
    expect(out.senderSessionId).toBe(`fleet:mac:${localSessionUuid}`);
  });

  it('leaves params without senderSessionId untouched — the key is never invented', () => {
    const out = wrapCallerIdentityOverrides('mac', { sessionId: 'dest', text: 'hi' }) as Record<string, unknown>;
    expect(out).toEqual({ sessionId: 'dest', text: 'hi' });
    expect('senderSessionId' in out).toBe(false);
  });

  it('ignores a non-string senderSessionId rather than wrapping it', () => {
    const out = wrapCallerIdentityOverrides('mac', { senderSessionId: 42 }) as Record<string, unknown>;
    expect('senderSessionId' in out).toBe(false);
  });

  it('is a shallow COPY — does not mutate the input', () => {
    const input = { senderSessionId: 'x', a: 1 };
    const out = wrapCallerIdentityOverrides('mac', input);
    expect(input.senderSessionId).toBe('x'); // original untouched
    expect(out).not.toBe(input);
  });

  it('passes non-object params through unchanged', () => {
    expect(wrapCallerIdentityOverrides('mac', undefined)).toBeUndefined();
    expect(wrapCallerIdentityOverrides('mac', 'str')).toBe('str');
    expect(wrapCallerIdentityOverrides('mac', [1, 2])).toEqual([1, 2]);
  });
});

describe('InboundCallGate — fleet sender wrapping', () => {
  it('hands the dispatcher a WRAPPED senderSessionId, not a stripped one', async () => {
    const { gate, calls } = build({ mac: ['session_send_text'] });
    await gate.handle('mac', 'session_send_text', {
      sessionId: 'dest',
      text: 'hi',
      senderSessionId: 'sender-uuid',
    });

    expect(calls[0].params).toEqual({
      sessionId: 'dest',
      text: 'hi',
      senderSessionId: 'fleet:mac:sender-uuid',
    });
  });

  it('keeps the PROXY authContext — the security model is unchanged by wrapping', async () => {
    const { gate, calls } = build({ mac: ['session_send_text'] });
    await gate.handle('mac', 'session_send_text', { senderSessionId: 'sender-uuid' });

    expect(calls[0].ctx.sessionId).toBe('peer:mac');
    expect(isProxySessionId(calls[0].ctx.sessionId)).toBe(true);
  });
});

describe('InboundCallGate — session_close ownership gate', () => {
  /** Build a minimal sessionLookup for tests. Key = sessionId, value includes createdByPeerId. */
  function fakeLookup(
    sessions: Array<{ id: string; name: string; createdByPeerId?: string }>,
  ) {
    const byId = new Map(sessions.map(s => [s.id, { createdByPeerId: s.createdByPeerId }]));
    return {
      getSession(id: string) { return byId.get(id) ?? null; },
      findByName(name: string) {
        const matches = sessions.filter(s => s.name === name);
        return matches.length === 1 ? { createdByPeerId: matches[0].createdByPeerId } : undefined;
      },
    };
  }

  it('allows peer to close a session it created (by sessionId)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    const { gate, calls, audit } = build({ mac: ['*'] }, { sessionLookup: lookup });
    expect(await gate.handle('mac', 'session_close', { sessionId: 's1' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(audit.list()[0].outcome).toBe('ok');
  });

  it('allows peer to close a session it created (by name)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    expect(await gate.handle('mac', 'session_close', { name: 'Worker' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('denies peer closing a session created by another peer', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'other-peer' },
    ]);
    const { gate, calls, audit } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { sessionId: 's1' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    expect(audit.list()[0].outcome).toBe('denied');
  });

  it('denies peer closing a locally-created session (no createdByPeerId)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Local', createdByPeerId: undefined },
    ]);
    const { gate, calls, audit } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { sessionId: 's1' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    expect(audit.list()[0].outcome).toBe('denied');
  });

  it('denies peer closing a non-existent session (uniform message, no existence leak)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { sessionId: 'nonexistent' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    // Same message as an ownership denial — no leak
  });

  it('denies peer closing with missing sessionId and name', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { foo: 'bar' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
  });

  it('denies even with ownership if session_close is not in allow-list', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    // Peer has session_create but NOT session_close in allow-list
    const { gate, calls, audit } = build({ mac: ['session_create'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { sessionId: 's1' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
    expect(audit.list()[0].outcome).toBe('denied');
  });

  it('falls back to deny when sessionLookup is not provided', async () => {
    const { gate, calls } = build({ mac: ['*'] });
    await expect(gate.handle('mac', 'session_close', { sessionId: 's1' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
  });

  it('denies when findByName returns undefined (ambiguous name)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
      { id: 's2', name: 'Worker', createdByPeerId: 'mac' }, // duplicate name
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', { name: 'Worker' }))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
  });

  it('prefers sessionId over name when both present', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
      { id: 's2', name: 'Other', createdByPeerId: 'other' },
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    // sessionId matches peer, name would NOT match — sessionId wins
    expect(await gate.handle('mac', 'session_close', { sessionId: 's1', name: 'Other' }))
      .toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('ownership denial is indistinguishable from allow-list denial (no information leak)', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'other' },
    ]);
    const { gate } = build({ mac: ['session_close'] }, { sessionLookup: lookup });
    let ownershipMsg = '';
    await gate.handle('mac', 'session_close', { sessionId: 's1' }).catch(e => { ownershipMsg = e.message; });
    // allow-list deny (different peer with empty list)
    const { gate: gate2 } = build({ mac: [] });
    let allowMsg = '';
    await gate2.handle('mac', 'session_close', {}).catch(e => { allowMsg = e.message; });
    expect(ownershipMsg).toBe(allowMsg);
    expect(ownershipMsg).toBe('Tool not permitted');
  });

  it('handles malformed params (non-object) without crashing', async () => {
    const lookup = fakeLookup([
      { id: 's1', name: 'Worker', createdByPeerId: 'mac' },
    ]);
    const { gate, calls } = build({ mac: ['*'] }, { sessionLookup: lookup });
    await expect(gate.handle('mac', 'session_close', 'not-an-object'))
      .rejects.toMatchObject({ code: -32000, message: 'Tool not permitted' });
    expect(calls).toHaveLength(0);
  });
});
