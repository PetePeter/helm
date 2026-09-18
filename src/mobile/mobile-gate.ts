/**
 * MobileGate — the security boundary for a paired phone's MCP calls.
 *
 * An authenticated phone is a remote-code-execution surface reachable from a
 * pocket, so it gets the same treatment the fleet gives a peer: deny by default,
 * no impersonation, rate limited. For every inbound call it, IN ORDER:
 *   1. rejects explicitly disabled devices,
 *   2. answers (never dispatches) the reserved permitted-tools meta-method,
 *   3. rejects hard-denied and structurally unreachable tools — even under a
 *      wildcard `*` allow-list,
 *   4. rejects ownership-gated tools on sessions the device did not create,
 *   5. rejects tools outside the device's allow-list,
 *   6. rejects calls exceeding the per-device rate limit,
 *   7. otherwise dispatches through the EXISTING MCP dispatcher UNCHANGED, under
 *      a synthetic `mobile:<deviceId>` identity (never a real local session).
 *
 * The boundary lives in FRONT of `callMcpTool`, never inside it: the dispatcher
 * signature is untouched, and dispatch is injected so this class is testable
 * without the MCP stack.
 *
 * Deny messages are UNIFORM and non-leaky — a hard-deny, an allow-list deny, an
 * unknown device and an unknown tool are indistinguishable, so a phone (or
 * whoever holds a stolen one) cannot probe which tools exist.
 *
 * DELIBERATE REUSE, not a second model: the hard-deny set and the token-bucket
 * limiter are the fleet's own (see docs/fleet.md). One gate pattern for the
 * project; only the identity prefix and the registry differ.
 */

import { logger } from '../utils/logger.js';
import type { AuthContext } from '../mcp/tools/types.js';
import { MCP_TOOLS } from '../mcp/tools/definitions.js';
import { HARD_DENY_TOOLS } from '../mcp/peer/inbound-call-gate.js';
import { PeerRateLimiter } from '../mcp/peer/rate-limiter.js';
import { mobileAuthContext } from './mobile-identity.js';
import type { MobileDeviceStore } from './mobile-device-store.js';

export { HARD_DENY_TOOLS };

/**
 * A reserved, non-dispatchable meta-method the phone uses to learn which tools
 * this hub will actually let it invoke — the mechanism behind the ratified
 * "grey out forbidden actions" rule in the app. Answered IN-GATE by intersecting
 * the tool catalogue with the device's allow-list minus the hard-deny set, so a
 * phone learns exactly what it may call and nothing about what it may not.
 * Sentinel underscores keep it from ever colliding with a real tool name.
 */
export const RESERVED_MOBILE_TOOLS_METHOD = '__mobile_tools__';

/**
 * A second reserved, non-dispatchable meta-method: the phone reporting the seq
 * of the last chat message it has, so the hub can replay the journal gap. It
 * carries no tool name and dispatches nothing, but it is answered IN-GATE all
 * the same — a disabled device must not be able to pull the journal by simply
 * asking, and this is what keeps that rule true by construction. Sentinel
 * underscores keep it clear of every real tool name.
 */
export const RESERVED_CHAT_CURSOR_METHOD = '__chat_cursor__';

/**
 * Tool-name prefixes that are STRUCTURALLY UNREACHABLE from a phone.
 *
 * These families resolve their subject from `authContext.sessionId` alone — they
 * take no session argument at all (see every `requireCallerSession` call site in
 * `mcp/tools/dispatcher.ts`). A phone's identity is the synthetic
 * `mobile:<deviceId>` proxy, which deliberately owns no artifacts, no memories
 * and no mess thread, so these can only ever address the proxy's OWN empty data.
 *
 * That makes them worse than denied. `artifact_list` from a phone does not fail —
 * it SUCCEEDS with an empty array, and a user who can see three artifacts on the
 * desktop concludes the phone lost them. A denial is legible; a silent empty
 * success is not.
 *
 * So the permitted surface means "this will do something", not merely "this will
 * not be refused": they are filtered out of the discovery answer AND denied on
 * dispatch, exactly like a hard-deny. This is NOT a change to the ownership
 * boundary — `requireCallerSession` is untouched. Cross-session artifact access
 * belongs to the explicit `session_artifact_*` family, which is allow-list gated.
 */
export const MOBILE_UNREACHABLE_TOOL_PREFIXES: readonly string[] = [
  'artifact_',
  'memory_',
  'mess_',
];

/** Whether `tool` is structurally unreachable for a phone. */
export function isMobileUnreachableTool(tool: string): boolean {
  return MOBILE_UNREACHABLE_TOOL_PREFIXES.some(prefix => tool.startsWith(prefix));
}

/** Uniform, non-leaky deny message shared by EVERY deny reason. */
export const MOBILE_DENY_MESSAGE = 'Tool not permitted';
const RATE_LIMIT_MESSAGE = 'Rate limit exceeded';
const JSONRPC_SERVER_ERROR = -32000;

/**
 * Per-device bucket: ~120 calls/min with a burst of 120. The phone's session
 * poll alone spends 30/min of this shared bucket (one session_list every 2s
 * while the app is visible), so 60 left too little for a user acting on top of
 * it; 120 keeps the poll and the actions in one bucket with room for both.
 * Still roomier than the fleet's 30 because a phone UI is interactive.
 */
export const DEFAULT_MOBILE_RATE_CAPACITY = 120;
export const DEFAULT_MOBILE_RATE_REFILL_PER_MS = 120 / 60000;

export function createDefaultMobileRateLimiter(now: () => number = Date.now): PeerRateLimiter {
  return new PeerRateLimiter({
    capacity: DEFAULT_MOBILE_RATE_CAPACITY,
    refillPerMs: DEFAULT_MOBILE_RATE_REFILL_PER_MS,
    now,
  });
}

/**
 * Argument keys a phone must NEVER be able to set RAW — they would override the
 * caller's identity and let it act as a real local session, bypassing the
 * synthetic proxy identity entirely. Unlike the fleet, which WRAPS
 * `senderSessionId` as a routable `fleet:<peerId>:<id>` address, a phone has no
 * sessions of its own to route a reply to, so these are simply STRIPPED.
 */
const CALLER_IDENTITY_OVERRIDE_KEYS: readonly string[] = ['senderSessionId'];

/**
 * Shallow copy of `params` with every caller-identity-override key removed, so a
 * phone cannot smuggle a real local session id past the proxy identity.
 * Non-object params pass through unchanged.
 */
export function stripCallerIdentityOverrides(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const copy = { ...(params as Record<string, unknown>) };
  for (const key of CALLER_IDENTITY_OVERRIDE_KEYS) delete copy[key];
  return copy;
}

/** JSON-RPC error shape the mobile transport can serialize as {error:{code,message}}. */
export class GateError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * Tools a device may invoke only on sessions IT created.
 *
 * DELIBERATELY EMPTY. `session_close` was here, mirroring the peer rule, and the
 * user removed it: a SAS-paired phone is their own device, and closing a session
 * from the kitchen is the point of the app, not an attack on it. The alternative
 * was worse than permissive — ownership is invisible to `__mobile_tools__`, so
 * the control sheet would have offered a Close row that looked permitted and was
 * refused every single time, which is the "fails looking like success" trap this
 * surface was audited to remove.
 *
 * The MECHANISM is kept, not deleted: the next tool that needs "only what you
 * created" (a phone-initiated destructive batch, say) adds a name here and gets
 * the check and the uniform denial for free. An empty set is one line;
 * re-deriving the check later is not.
 */
const OWNERSHIP_GATED_TOOLS: ReadonlySet<string> = new Set<string>();

/** Minimal session view the ownership check needs. */
export interface MobileSessionLookup {
  getSession(sessionId: string): { createdByMobileDeviceId?: string } | null;
  findByName(name: string): { createdByMobileDeviceId?: string } | undefined;
}

/**
 * Whether `deviceId` created the session targeted by a call. Every negative
 * outcome — no lookup wired, no reference, session missing, session owned by
 * someone else — collapses to `false` so the gate denies uniformly and reveals
 * nothing about which sessions exist.
 */
function ownsTargetSession(
  params: unknown,
  deviceId: string,
  lookup: MobileSessionLookup | undefined,
): boolean {
  if (!lookup) return false;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;

  const args = params as Record<string, unknown>;
  const ref = typeof args.sessionId === 'string' ? args.sessionId
    : typeof args.name === 'string' ? args.name
    : undefined;
  if (!ref) return false;

  // By id first, then by name — mirrors HelmSessionService.findSession.
  const session = lookup.getSession(ref) ?? lookup.findByName(ref);
  return session?.createdByMobileDeviceId === deviceId;
}

export interface MobileGateDeps {
  /** The paired-phone registry. Owns the allow-list and the enabled flag. */
  deviceStore: Pick<MobileDeviceStore, 'isToolAllowed' | 'get'>;
  /**
   * The dispatch closure. Real wiring passes a closure over the existing
   * callMcpTool seam; injecting it keeps the dispatcher signature untouched and
   * the gate unit-testable with a fake.
   */
  dispatch: (method: string, params: unknown, ctx: AuthContext) => Promise<unknown>;
  rateLimiter: PeerRateLimiter;
  /**
   * Optional session lookup for ownership-gated tools. Absent means those tools
   * are denied outright — the safe default.
   */
  sessionLookup?: MobileSessionLookup;
}

export class MobileGate {
  private readonly deviceStore: MobileGateDeps['deviceStore'];
  private readonly dispatch: MobileGateDeps['dispatch'];
  private readonly rateLimiter: PeerRateLimiter;
  private readonly sessionLookup: MobileSessionLookup | undefined;

  constructor(deps: MobileGateDeps) {
    this.deviceStore = deps.deviceStore;
    this.dispatch = deps.dispatch;
    this.rateLimiter = deps.rateLimiter;
    this.sessionLookup = deps.sessionLookup;
  }

  /** Gate + dispatch one inbound phone call. */
  async handle(deviceId: string, method: string, params: unknown): Promise<unknown> {
    // 1. Disabled device — off in BOTH directions: it cannot invoke tools NOR
    // enumerate the permitted surface. Same uniform message as any other deny so
    // "Off" cannot be told apart from "not permitted". An UNKNOWN device is not
    // handled here; it falls through to the allow-list, which denies by default.
    if (this.isDeviceDisabled(deviceId)) {
      return this.denied(deviceId, method);
    }

    // 2. Permitted-tool discovery. Answered in-gate, never dispatched, but still
    // rate-limited so it cannot be probed for free.
    if (method === RESERVED_MOBILE_TOOLS_METHOD) {
      this.consumeOrThrow(deviceId, method);
      const tools = MCP_TOOLS
        .filter(t => !HARD_DENY_TOOLS.has(t.name)
          && !isMobileUnreachableTool(t.name)
          && this.deviceStore.isToolAllowed(deviceId, t.name))
        .map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
      this.logOutcome(deviceId, method, 'ok');
      return { tools };
    }

    // 2b. The chat catch-up cursor. The body of the answer means nothing — the
    // replay itself is the bridge's job, over the link the call arrived on — but
    // the CHECK is everything: a disabled or unrecognised device gets the same
    // denial here as any tool would, so the journal is reachable only by a
    // device the registry currently trusts.
    if (method === RESERVED_CHAT_CURSOR_METHOD) {
      this.consumeOrThrow(deviceId, method);
      this.logOutcome(deviceId, method, 'ok');
      return { ok: true };
    }

    // 3. Hard-deny, and the structurally unreachable families with it: a tool
    // that can only return the proxy's own empty data must refuse legibly rather
    // than succeed emptily.
    if (HARD_DENY_TOOLS.has(method) || isMobileUnreachableTool(method)) {
      return this.denied(deviceId, method);
    }

    // 4. Ownership gate — a phone may only act on sessions it created itself.
    if (OWNERSHIP_GATED_TOOLS.has(method) && !ownsTargetSession(params, deviceId, this.sessionLookup)) {
      return this.denied(deviceId, method);
    }

    // 5. Per-device allow-list. Already deny-by-default for unknown, disabled and
    // empty-allow devices (MobileDeviceStore.isToolAllowed).
    if (!this.deviceStore.isToolAllowed(deviceId, method)) {
      return this.denied(deviceId, method);
    }

    // 6. Rate limit.
    this.consumeOrThrow(deviceId, method);

    // 7. Dispatch under the synthetic proxy identity, with caller-identity
    // overrides stripped FIRST so the phone can never act as a real session.
    const safeParams = stripCallerIdentityOverrides(params);
    try {
      const result = await this.dispatch(method, safeParams, mobileAuthContext(deviceId));
      this.logOutcome(deviceId, method, 'ok');
      return result;
    } catch (err) {
      // The wire response may carry the full message, but the log line must be
      // value-free: several dispatcher errors embed argument VALUES in their
      // message (e.g. `Session not found: <id>`). Log the TYPE only.
      const message = err instanceof Error ? err.message : String(err);
      const errorType = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
      this.logOutcome(deviceId, method, 'error', errorType);
      throw new GateError(JSONRPC_SERVER_ERROR, message);
    }
  }

  /**
   * Whether `deviceId` is an EXPLICITLY disabled registered device. Default-true:
   * a missing record or an undefined `enabled` is not "disabled" here — an
   * unknown device is denied one step later by the allow-list instead.
   */
  private isDeviceDisabled(deviceId: string): boolean {
    return this.deviceStore.get(deviceId)?.enabled === false;
  }

  /** Consume a rate-limit token or throw. */
  private consumeOrThrow(deviceId: string, method: string): void {
    if (this.rateLimiter.tryConsume(deviceId)) return;
    this.logOutcome(deviceId, method, 'rate-limited');
    throw new GateError(JSONRPC_SERVER_ERROR, RATE_LIMIT_MESSAGE);
  }

  /** Deny with the uniform message. Never returns. */
  private denied(deviceId: string, method: string): never {
    this.logOutcome(deviceId, method, 'denied');
    throw new GateError(JSONRPC_SERVER_ERROR, MOBILE_DENY_MESSAGE);
  }

  /** Log the gate outcome to winston — key names and error types only, never values. */
  private logOutcome(deviceId: string, method: string, outcome: string, error?: string): void {
    logger.info(`[mobile-gate] ${deviceId} ${method} → ${outcome}${error ? ` (${error})` : ''}`);
  }
}
