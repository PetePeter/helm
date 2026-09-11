/**
 * MobileGate — the security boundary in front of every inbound phone call.
 *
 * Real gate wired to a REAL MobileDeviceStore, a REAL PeerRateLimiter and a REAL
 * MobileAuditLog; only the dispatcher is an injected fake, so we can assert
 * exactly which identity and which arguments reach it without standing up the
 * whole MCP stack. Mirrors the fakes>mocks discipline of inbound-call-gate.test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MobileGate,
  GateError,
  RESERVED_MOBILE_TOOLS_METHOD,
  stripCallerIdentityOverrides,
  MOBILE_DENY_MESSAGE,
  isMobileUnreachableTool,
  MOBILE_UNREACHABLE_TOOL_PREFIXES,
} from '../src/mobile/mobile-gate.js';
import { HARD_DENY_TOOLS } from '../src/mcp/peer/inbound-call-gate.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { MobileAuditLog } from '../src/mobile/mobile-audit-log.js';
import { PeerRateLimiter } from '../src/mcp/peer/rate-limiter.js';
import { isMobileSessionId, deviceIdFromMobileSessionId } from '../src/mobile/mobile-identity.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import type { AuthContext } from '../src/mcp/tools/types.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

interface Built {
  gate: MobileGate;
  store: MobileDeviceStore;
  audit: MobileAuditLog;
  calls: Array<{ method: string; params: unknown; ctx: AuthContext }>;
  /** Local record id of the device registered from `allow`. */
  deviceId: string;
}

function build(
  allow: string[],
  opts: {
    now?: () => number;
    enabled?: boolean;
    capacity?: number;
    dispatchImpl?: (method: string, params: unknown, ctx: AuthContext) => Promise<unknown>;
    sessionLookup?: {
      getSession(id: string): { createdByMobileDeviceId?: string } | null;
      findByName(name: string): { createdByMobileDeviceId?: string } | undefined;
    };
  } = {},
): Built {
  const now = opts.now ?? (() => 0);
  const calls: Built['calls'] = [];
  const store = new MobileDeviceStore(undefined, now);
  const device = store.add({
    machineId: 'phone-machine',
    name: 'Pixel 8',
    pskRef: 'psk-ref',
    allow,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
  });
  // Persist sink is a no-op so nothing touches the user's real audit file.
  const audit = new MobileAuditLog(() => {}, now);
  audit.importAll([]);
  const gate = new MobileGate({
    deviceStore: store,
    dispatch: async (method, params, ctx) => {
      calls.push({ method, params, ctx });
      if (opts.dispatchImpl) return opts.dispatchImpl(method, params, ctx);
      return { ok: true };
    },
    rateLimiter: new PeerRateLimiter({ capacity: opts.capacity ?? 100, refillPerMs: 100 / 60000, now }),
    audit,
    now,
    ...(opts.sessionLookup ? { sessionLookup: opts.sessionLookup } : {}),
  });
  return { gate, store, audit, calls, deviceId: device.id };
}

describe('MobileGate — default-deny', () => {
  it('denies every tool when the device has an empty allow-list', async () => {
    const { gate, deviceId, calls } = build([]);
    await expect(gate.handle(deviceId, 'session_list', {})).rejects.toThrow(MOBILE_DENY_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('denies an unknown device outright', async () => {
    const { gate, calls } = build(['*']);
    await expect(gate.handle('not-a-registered-device', 'session_list', {})).rejects.toThrow(
      MOBILE_DENY_MESSAGE,
    );
    expect(calls).toHaveLength(0);
  });

  it('denies a device that was revoked mid-session', async () => {
    const { gate, store, deviceId } = build(['session_list']);
    await expect(gate.handle(deviceId, 'session_list', {})).resolves.toEqual({ ok: true });
    store.remove(deviceId);
    await expect(gate.handle(deviceId, 'session_list', {})).rejects.toThrow(MOBILE_DENY_MESSAGE);
  });

  it('denies an explicitly disabled device', async () => {
    const { gate, deviceId } = build(['*'], { enabled: false });
    await expect(gate.handle(deviceId, 'session_list', {})).rejects.toThrow(MOBILE_DENY_MESSAGE);
  });
});

describe('MobileGate — allow-list matching', () => {
  it('allows only tools matching a glob and denies the rest', async () => {
    const { gate, deviceId, calls } = build(['session_*']);
    await expect(gate.handle(deviceId, 'session_list', {})).resolves.toEqual({ ok: true });
    await expect(gate.handle(deviceId, 'plan_list', { dirPath: 'x' })).rejects.toThrow(
      MOBILE_DENY_MESSAGE,
    );
    expect(calls.map(c => c.method)).toEqual(['session_list']);
  });
});

describe('MobileGate — hard deny', () => {
  it('refuses hard-denied tools even under a wildcard allow-list', async () => {
    const { gate, deviceId, calls } = build(['*']);
    for (const tool of HARD_DENY_TOOLS) {
      await expect(gate.handle(deviceId, tool, {})).rejects.toThrow(MOBILE_DENY_MESSAGE);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses the structurally unreachable families rather than answering emptily', async () => {
    const { gate, deviceId, calls } = build(['*']);

    // Every one of these resolves its subject from authContext.sessionId and
    // takes no session argument, so from the mobile: proxy they address nothing
    // the user meant. Refusing is the honest answer; dispatching would return an
    // empty artifact list that reads as "your artifacts are gone".
    for (const tool of ['artifact_list', 'artifact_show', 'memory_search', 'mess_check']) {
      expect(isMobileUnreachableTool(tool)).toBe(true);
      await expect(gate.handle(deviceId, tool, { id: 'a1' })).rejects.toThrow(MOBILE_DENY_MESSAGE);
    }
    expect(calls).toHaveLength(0);
  });

  it('leaves tools that take an explicit session reference alone', async () => {
    const { gate, deviceId, calls } = build(['*']);

    // The rule is "cannot address anything but itself", not "touches a session".
    // session_* and scheduler_* take their target as an argument, so a phone can
    // aim them, and pulling them would break the whole control surface.
    for (const tool of ['session_list', 'session_read_terminal', 'session_compact', 'scheduler_list']) {
      expect(MOBILE_UNREACHABLE_TOOL_PREFIXES.some(p => tool.startsWith(p))).toBe(false);
      await gate.handle(deviceId, tool, { sessionId: 's1' });
    }
    expect(calls).toHaveLength(4);
  });
});

describe('MobileGate — impersonation defence', () => {
  it('dispatches under a mobile: proxy identity, never a real session id', async () => {
    const { gate, deviceId, calls } = build(['session_list']);
    await gate.handle(deviceId, 'session_list', {});
    const ctx = calls[0].ctx;
    expect(isMobileSessionId(ctx.sessionId)).toBe(true);
    expect(deviceIdFromMobileSessionId(ctx.sessionId)).toBe(deviceId);
  });

  it('strips senderSessionId before dispatch so a phone cannot act as a local session', async () => {
    const { gate, deviceId, calls } = build(['session_send_text']);
    const victim = '11111111-2222-4333-8444-555555555555';
    await gate.handle(deviceId, 'session_send_text', {
      sessionId: 'target',
      senderSessionId: victim,
      text: 'hi',
    });
    const params = calls[0].params as Record<string, unknown>;
    expect(params).not.toHaveProperty('senderSessionId');
    expect(params).toMatchObject({ sessionId: 'target', text: 'hi' });
  });

  it('stripCallerIdentityOverrides leaves non-object params untouched', () => {
    expect(stripCallerIdentityOverrides(undefined)).toBeUndefined();
    expect(stripCallerIdentityOverrides('raw')).toBe('raw');
    expect(stripCallerIdentityOverrides([1, 2])).toEqual([1, 2]);
  });
});

describe('MobileGate — session ownership', () => {
  const lookup = (sessions: Record<string, { createdByMobileDeviceId?: string }>) => ({
    getSession: (id: string) => sessions[id] ?? null,
    findByName: (name: string) => sessions[name],
  });

  it('lets an allowed phone close a session it did not create', async () => {
    // RULED: closing from the kitchen is the point of the app. The peer rule
    // ("only what you created") was removed for phones because a SAS-paired phone
    // is the user's own device — and because ownership is invisible to
    // __mobile_tools__, so the control sheet would have shown a permitted-looking
    // Close row that was refused every single time.
    const { gate, deviceId, calls } = build(['session_close'], {
      sessionLookup: lookup({ s1: {} }),
    });

    await expect(gate.handle(deviceId, 'session_close', { sessionId: 's1' })).resolves.toEqual({ ok: true });
    expect(calls.map(c => c.method)).toEqual(['session_close']);
  });

  it('still closes under the allow-list, not around it', async () => {
    // Permissive about WHICH session, unchanged about WHETHER: a device without
    // session_close on its allow-list is refused exactly as before.
    const { gate, deviceId, calls } = build(['session_list'], {
      sessionLookup: lookup({ s1: {} }),
    });
    await expect(gate.handle(deviceId, 'session_close', { sessionId: 's1' })).rejects.toThrow(
      MOBILE_DENY_MESSAGE,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('MobileGate — rate limiting', () => {
  it('blocks past the bucket and lets calls through again after a refill', async () => {
    let clock = 0;
    const { gate, deviceId } = build(['session_list'], { capacity: 2, now: () => clock });
    await expect(gate.handle(deviceId, 'session_list', {})).resolves.toBeTruthy();
    await expect(gate.handle(deviceId, 'session_list', {})).resolves.toBeTruthy();
    await expect(gate.handle(deviceId, 'session_list', {})).rejects.toThrow('Rate limit exceeded');
    clock += 60_000; // a full minute refills the bucket
    await expect(gate.handle(deviceId, 'session_list', {})).resolves.toBeTruthy();
  });
});

describe('MobileGate — uniform denials', () => {
  it('uses a byte-identical message for every deny reason, so tools cannot be probed', async () => {
    const messages = new Set<string>();
    const push = async (fn: Promise<unknown>) => {
      messages.add(await fn.catch((e: Error) => e.message));
    };
    const disabled = build(['*'], { enabled: false });
    await push(disabled.gate.handle(disabled.deviceId, 'session_list', {}));

    const wildcard = build(['*']);
    await push(wildcard.gate.handle(wildcard.deviceId, 'restart_helm', {}));
    await push(wildcard.gate.handle('unknown-device', 'session_list', {}));

    const narrow = build(['session_list']);
    await push(narrow.gate.handle(narrow.deviceId, 'plan_list', {}));
    await push(narrow.gate.handle(narrow.deviceId, 'no_such_tool_at_all', {}));

    expect([...messages]).toEqual([MOBILE_DENY_MESSAGE]);
  });
});

describe('MobileGate — audit', () => {
  it('records the tool name and argument KEY names, never a value', async () => {
    const secret = 'hunter2-super-secret-token';
    const { gate, audit, deviceId } = build(['session_send_text']);
    await gate.handle(deviceId, 'session_send_text', { sessionId: 's1', text: secret });

    const entries = audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ deviceId, method: 'session_send_text', outcome: 'ok' });
    expect(entries[0].argSummary).toBe('keys: sessionId,text');
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('records a dispatcher failure as the error TYPE only, never its message', async () => {
    const leak = 'Session not found: 11111111-2222-4333-8444-555555555555';
    const { gate, audit, deviceId } = build(['session_get'], {
      dispatchImpl: async () => {
        throw new Error(leak);
      },
    });
    await expect(gate.handle(deviceId, 'session_get', { sessionId: 'x' })).rejects.toThrow(leak);
    expect(audit.list()[0]).toMatchObject({ outcome: 'error', error: 'Error' });
    expect(JSON.stringify(audit.list())).not.toContain('11111111');
  });

  it('records denials and rate limits as distinct outcomes', async () => {
    let clock = 0;
    const { gate, audit, deviceId } = build(['session_list'], { capacity: 1, now: () => clock });
    await gate.handle(deviceId, 'session_list', {});
    await gate.handle(deviceId, 'restart_helm', {}).catch(() => undefined);
    await gate.handle(deviceId, 'session_list', {}).catch(() => undefined);
    expect(audit.list().map(e => e.outcome).sort()).toEqual(['denied', 'ok', 'rate-limited']);
  });
});

describe('MobileGate — permitted-tool discovery', () => {
  it('answers in-gate with the allowed surface and never dispatches it', async () => {
    const { gate, deviceId, calls } = build(['session_list', 'session_get']);
    const result = (await gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {})) as {
      tools: Array<{ name: string }>;
    };
    expect(result.tools.map(t => t.name).sort()).toEqual(['session_get', 'session_list']);
    expect(calls).toHaveLength(0);
  });

  it('never lists a hard-denied tool, even under a wildcard', async () => {
    const { gate, deviceId } = build(['*']);
    const result = (await gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {})) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map(t => t.name);
    const unreachable = MCP_TOOLS.filter(t => isMobileUnreachableTool(t.name)).length;
    expect(names.length).toBe(MCP_TOOLS.length - HARD_DENY_TOOLS.size - unreachable);
    for (const denied of HARD_DENY_TOOLS) expect(names).not.toContain(denied);
  });

  it('never lists a tool that could only return the proxy\'s own empty data', async () => {
    const { gate, deviceId } = build(['*']);
    const result = (await gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {})) as {
      tools: Array<{ name: string }>;
    };

    // The permitted surface must mean "this will do something". artifact_list is
    // the case that proved it: scoped to the CALLER'S session, it answers a phone
    // with an empty array rather than a denial, so a UI built from this list would
    // offer a working-looking row that silently shows nothing.
    expect(result.tools.map(t => t.name)).not.toContain('artifact_list');
    expect(result.tools.some(t => isMobileUnreachableTool(t.name))).toBe(false);
  });

  it('denies discovery to a disabled device with the uniform message', async () => {
    const { gate, deviceId } = build(['*'], { enabled: false });
    await expect(gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {})).rejects.toThrow(
      MOBILE_DENY_MESSAGE,
    );
  });

  it('is rate limited like any other call', async () => {
    const { gate, deviceId } = build(['*'], { capacity: 1, now: () => 0 });
    await gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {});
    await expect(gate.handle(deviceId, RESERVED_MOBILE_TOOLS_METHOD, {})).rejects.toThrow(
      'Rate limit exceeded',
    );
  });
});

describe('GateError', () => {
  it('carries a JSON-RPC code the transport can serialize', async () => {
    const { gate, deviceId } = build([]);
    const err = await gate.handle(deviceId, 'session_list', {}).catch(e => e);
    expect(err).toBeInstanceOf(GateError);
    expect(err.code).toBe(-32000);
  });
});
