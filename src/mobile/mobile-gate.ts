/**
 * MobileGate — the security boundary for a paired phone's MCP calls.
 *
 * An authenticated phone is a remote-code-execution surface reachable from a
 * pocket, so it gets the same treatment the fleet gives a peer: deny by default,
 * no impersonation, rate limited, audited. For every inbound call it, IN ORDER:
 *   1. rejects explicitly disabled devices,
 *   2. answers (never dispatches) the reserved permitted-tools meta-method,
 *   3. rejects hard-denied tools — even under a wildcard `*` allow-list,
 *   4. rejects ownership-gated tools on sessions the device did not create,
 *   5. rejects tools outside the device's allow-list,
 *   6. rejects calls exceeding the per-device rate limit,
 *   7. otherwise dispatches through the EXISTING MCP dispatcher UNCHANGED, under
 *      a synthetic `mobile:<deviceId>` identity (never a real local session),
 * and audits the outcome of every one of those paths.
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
 * project; only the identity prefix, the registry and the audit file differ.
 */

import { logger } from '../utils/logger.js';
import type { AuthContext } from '../mcp/tools/types.js';
import { MCP_TOOLS } from '../mcp/tools/definitions.js';
import { HARD_DENY_TOOLS } from '../mcp/peer/inbound-call-gate.js';
import { PeerRateLimiter } from '../mcp/peer/rate-limiter.js';
import { mobileAuthContext } from './mobile-identity.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { MobileAuditLog, MobileAuditOutcome } from './mobile-audit-log.js';

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

/** Uniform, non-leaky deny message shared by EVERY deny reason. */
export const MOBILE_DENY_MESSAGE = 'Tool not permitted';
const RATE_LIMIT_MESSAGE = 'Rate limit exceeded';
const JSONRPC_SERVER_ERROR = -32000;
/** Cap the audit summary so a huge arg-object cannot bloat the log. */
const ARG_SUMMARY_MAX = 200;

/**
 * Per-device bucket: ~60 calls/min with a burst of 60. Roomier than the fleet's
 * 30 because a phone UI is interactive — a screen open on the sessions list
 * refreshes far more often than a peer AI issues tool calls.
 */
export const DEFAULT_MOBILE_RATE_CAPACITY = 60;
export const DEFAULT_MOBILE_RATE_REFILL_PER_MS = 60 / 60000;

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
 * Tools a device may invoke only on sessions IT created. `session_close` alone
 * for now, matching the peer rule — a lost phone must not be able to close the
 * user's own work.
 */
const OWNERSHIP_GATED_TOOLS: ReadonlySet<string> = new Set(['session_close']);

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
  audit: MobileAuditLog;
  /**
   * Optional session lookup for ownership-gated tools. Absent means those tools
   * are denied outright — the safe default.
   */
  sessionLookup?: MobileSessionLookup;
  now?: () => number;
}

export class MobileGate {
  private readonly deviceStore: MobileGateDeps['deviceStore'];
  private readonly dispatch: MobileGateDeps['dispatch'];
  private readonly rateLimiter: PeerRateLimiter;
  private readonly audit: MobileAuditLog;
  private readonly sessionLookup: MobileSessionLookup | undefined;
  private readonly now: () => number;

  constructor(deps: MobileGateDeps) {
    this.deviceStore = deps.deviceStore;
    this.dispatch = deps.dispatch;
    this.rateLimiter = deps.rateLimiter;
    this.audit = deps.audit;
    this.sessionLookup = deps.sessionLookup;
    this.now = deps.now ?? Date.now;
  }

  /** Gate + dispatch one inbound phone call. */
  async handle(deviceId: string, method: string, params: unknown): Promise<unknown> {
    const argSummary = summarizeArgKeys(params);

    // 1. Disabled device — off in BOTH directions: it cannot invoke tools NOR
    // enumerate the permitted surface. Same uniform message as any other deny so
    // "Off" cannot be told apart from "not permitted". An UNKNOWN device is not
    // handled here; it falls through to the allow-list, which denies by default.
    if (this.isDeviceDisabled(deviceId)) {
      return this.denied(deviceId, method, argSummary);
    }

    // 2. Permitted-tool discovery. Answered in-gate, never dispatched, but still
    // rate-limited and audited so it cannot be probed for free.
    if (method === RESERVED_MOBILE_TOOLS_METHOD) {
      this.consumeOrThrow(deviceId, method, argSummary);
      const tools = MCP_TOOLS
        .filter(t => !HARD_DENY_TOOLS.has(t.name) && this.deviceStore.isToolAllowed(deviceId, t.name))
        .map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
      this.record(deviceId, method, argSummary, 'ok');
      return { tools };
    }

    // 3. Hard-deny — never invocable from a phone, even under a wildcard.
    if (HARD_DENY_TOOLS.has(method)) {
      return this.denied(deviceId, method, argSummary);
    }

    // 4. Ownership gate — a phone may only act on sessions it created itself.
    if (OWNERSHIP_GATED_TOOLS.has(method) && !ownsTargetSession(params, deviceId, this.sessionLookup)) {
      return this.denied(deviceId, method, argSummary);
    }

    // 5. Per-device allow-list. Already deny-by-default for unknown, disabled and
    // empty-allow devices (MobileDeviceStore.isToolAllowed).
    if (!this.deviceStore.isToolAllowed(deviceId, method)) {
      return this.denied(deviceId, method, argSummary);
    }

    // 6. Rate limit.
    this.consumeOrThrow(deviceId, method, argSummary);

    // 7. Dispatch under the synthetic proxy identity, with caller-identity
    // overrides stripped FIRST so the phone can never act as a real session.
    const safeParams = stripCallerIdentityOverrides(params);
    try {
      const result = await this.dispatch(method, safeParams, mobileAuthContext(deviceId));
      this.record(deviceId, method, argSummary, 'ok');
      return result;
    } catch (err) {
      // The wire response may carry the full message, but the PERSISTED audit
      // must be value-free: several dispatcher errors embed argument VALUES in
      // their message (e.g. `Session not found: <id>`). Store the TYPE only.
      const message = err instanceof Error ? err.message : String(err);
      const errorType = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
      this.record(deviceId, method, argSummary, 'error', errorType);
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

  /** Consume a rate-limit token or audit + throw. */
  private consumeOrThrow(deviceId: string, method: string, argSummary: string): void {
    if (this.rateLimiter.tryConsume(deviceId)) return;
    this.record(deviceId, method, argSummary, 'rate-limited');
    throw new GateError(JSONRPC_SERVER_ERROR, RATE_LIMIT_MESSAGE);
  }

  /** Audit a denial and throw the uniform deny error. Never returns. */
  private denied(deviceId: string, method: string, argSummary: string): never {
    this.record(deviceId, method, argSummary, 'denied');
    throw new GateError(JSONRPC_SERVER_ERROR, MOBILE_DENY_MESSAGE);
  }

  private record(
    deviceId: string,
    method: string,
    argSummary: string,
    outcome: MobileAuditOutcome,
    error?: string,
  ): void {
    this.audit.append({
      deviceId,
      method,
      argSummary,
      outcome,
      ranAt: this.now(),
      ...(error ? { error } : {}),
    });
    logger.info(`[mobile-gate] ${deviceId} ${method} → ${outcome}`);
  }
}

/**
 * Build the audit argSummary: the SORTED top-level argument KEY NAMES only —
 * NEVER any value. This is the mechanism that keeps secrets and payloads out of
 * the audit log. Truncated to a safe length.
 */
function summarizeArgKeys(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return 'keys: (none)';
  }
  const keys = Object.keys(params as Record<string, unknown>).sort();
  const summary = `keys: ${keys.length ? keys.join(',') : '(none)'}`;
  return summary.length > ARG_SUMMARY_MAX
    ? `${summary.slice(0, ARG_SUMMARY_MAX - 1)}…`
    : summary;
}
