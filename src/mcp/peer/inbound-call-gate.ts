/**
 * InboundCallGate — the security boundary for a remote peer's MCP calls.
 *
 * It is the concrete `onCall(peerId, method, params)` sink handed to the
 * RemoteLink (P-0646). For every inbound call it, IN ORDER:
 *   1. rejects hard-denied tools (never proxyable, even under a `*` allow-list),
 *   2. rejects tools outside the peer's allow-list,
 *   3. rejects calls exceeding the per-peer rate limit,
 *   4. otherwise dispatches through the EXISTING MCP dispatcher UNCHANGED, under
 *      a synthesized PROXY identity (never a real local session),
 * and audits the outcome of every one of those paths.
 *
 * Deny messages are UNIFORM and non-leaky: a hard-deny and an allow-list-deny
 * are indistinguishable, so a remote peer cannot probe which tools exist.
 */

import { logger } from '../../utils/logger.js';
import type { AuthContext } from '../tools/types.js';
import { proxyAuthContext } from './proxy-identity.js';
import { wrapFleetSessionId } from './fleet-session-id.js';
import type { PeerRateLimiter } from './rate-limiter.js';
import type { PeerAuditLog, PeerAuditOutcome } from './peer-audit-log.js';
import { MCP_TOOLS } from '../tools/definitions.js';

/**
 * A reserved, non-dispatchable meta-method a remote peer uses to discover the
 * tool surface THIS host will actually let it invoke. It is answered in-gate by
 * intersecting MCP_TOOLS with the caller's allow-list (minus hard-denied tools)
 * — the allow-list authority lives on the REMOTE, so a peer learns exactly what
 * it may call, and nothing about tools it may not. Never routed through the MCP
 * dispatcher. Named with sentinel underscores so it can never collide with a
 * real tool name.
 */
export const RESERVED_PEER_TOOLS_METHOD = '__peer_tools__';

/**
 * Tools that must NEVER be invocable by a remote peer, regardless of that peer's
 * allow-list — the belt-and-suspenders host/app-lifecycle deny list.
 *
 * The primary gate is the per-peer allow-list (PeerConfigManager.isToolAllowed);
 * this set is the last-resort guard for tools so dangerous they must be blocked
 * even if a peer is configured with a wildcard `*`. Defined HERE (not in the MCP
 * dispatcher, which stays untouched). Extend this set — do not weaken the
 * allow-list — when adding new host/lifecycle tools that must stay local-only.
 */
export const HARD_DENY_TOOLS: ReadonlySet<string> = new Set<string>([
  'restart_helm',
  // Mobile pairing + grant administration: LOCAL AI ONLY. A phone that could
  // reach these would pair further devices or widen its own allow-list — the
  // gate would be handing out the keys to itself. A peer has no business
  // administering this host's phones either. Deny regardless of allow-list.
  'mobile_pair_start',
  'mobile_pair_status',
  'mobile_pair_confirm',
  'mobile_pair_cancel',
  'mobile_device_list',
  'mobile_device_allow',
  // Running-session group killer: destructive to host/app lifecycle. A peer with a
  // wildcard `*` allow-list could otherwise batch-kill a whole group.
  'session_group_close',
  // NOTE: session_close is NOT here — it is handled by the ownership gate below,
  // allowing peers to close only sessions they created via session_create.
]);

/**
 * Argument keys a caller must NEVER be able to set RAW — they would override the
 * caller's identity and let a remote peer impersonate a real local session,
 * bypassing the synthetic proxy identity entirely. For now this is just
 * `senderSessionId` (read FIRST, ahead of authContext.sessionId, by
 * session_send_text/session_send_input/session_create); extend this list if new
 * tools add other caller-identity-override params.
 */
const CALLER_IDENTITY_OVERRIDE_KEYS: readonly string[] = ['senderSessionId'];

/**
 * Return a shallow copy of `params` with caller-identity-override keys made
 * safe, so a peer cannot smuggle a real local session id past the proxy identity.
 *
 * `senderSessionId` is WRAPPED as `fleet:<peerId>:<value>` rather than dropped:
 * the value names a session on the CALLING machine, and the recipient needs it
 * to address a reply back across the fleet (see [[fleet-session-id]]). Wrapping
 * preserves the impersonation defence in full — the wrapped form can never equal
 * a local UUID, so the worst a hostile peer achieves by forging it is routing a
 * reply back to its own machine. Every other override key is still stripped
 * outright. Non-object params pass through unchanged.
 */
export function wrapCallerIdentityOverrides(peerId: string, params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const copy = { ...(params as Record<string, unknown>) };
  for (const key of CALLER_IDENTITY_OVERRIDE_KEYS) {
    const value = copy[key];
    // A non-string value can't name a session; drop it rather than wrap it.
    if (key === 'senderSessionId' && typeof value === 'string') {
      copy[key] = wrapFleetSessionId(peerId, value);
    } else {
      delete copy[key];
    }
  }
  return copy;
}

/**
 * Tri-state result for session ownership checks.
 * - `owned`: session exists and its createdByPeerId matches the calling peer.
 * - `not-owned`: session exists but was created by a different peer or locally.
 * - `not-found`: session reference missing, malformed, or session does not exist.
 */
type OwnershipResult = 'owned' | 'not-owned' | 'not-found';

/**
 * Check whether a peer owns the session targeted by a tool call.
 * Returns `'owned'` only when the session's `createdByPeerId` matches the
 * calling peer. All other outcomes (not-owned, not-found, missing params,
 * no lookup) produce the same result so the gate can deny uniformly.
 */
function checkSessionOwnership(
  params: unknown,
  peerId: string,
  lookup: InboundCallGateDeps['sessionLookup'],
): OwnershipResult {
  if (!lookup) return 'not-found';
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'not-found';

  const args = params as Record<string, unknown>;
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;
  const ref = sessionId ?? name;

  if (!ref) return 'not-found';

  // Try by ID first, then by name — mirrors HelmSessionService.findSession.
  const session = lookup.getSession(ref) ?? lookup.findByName(ref);
  if (!session) return 'not-found';
  return session.createdByPeerId === peerId ? 'owned' : 'not-owned';
}

/** JSON-RPC error shape the RemoteLink can serialize as {error:{code,message}}. */
export class GateError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'GateError';
  }
}

const JSONRPC_SERVER_ERROR = -32000;
/** Uniform, non-leaky deny message shared by hard-deny and allow-list-deny. */
const DENY_MESSAGE = 'Tool not permitted';
const RATE_LIMIT_MESSAGE = 'Rate limit exceeded';
/** Cap the audit summary so a huge arg-object can't bloat the log. */
const ARG_SUMMARY_MAX = 200;

export interface InboundCallGateDeps {
  /**
   * Per-peer allow-list matcher + enablement lookup (PeerConfigManager). `get`
   * returns the peer's config (or undefined). Only an explicit `enabled === false`
   * disables a peer; undefined/true = enabled (default-true), so legacy peers
   * without the field stay active.
   */
  peerConfig: {
    isToolAllowed(peerId: string, toolName: string): boolean;
    get?(peerId: string): { enabled?: boolean } | undefined;
  };
  /**
   * The dispatch closure. The real wiring passes a closure over the existing
   * callMcpTool; injecting it keeps the gate unit-testable with a fake and keeps
   * the dispatcher signature untouched.
   */
  dispatch: (method: string, params: unknown, ctx: AuthContext) => Promise<unknown>;
  rateLimiter: PeerRateLimiter;
  audit: PeerAuditLog;
  /**
   * Optional session lookup for ownership-gated tools (e.g. session_close).
   * If absent, ownership-gated tools fall back to hard-deny (safe default).
   */
  sessionLookup?: {
    getSession(sessionId: string): { createdByPeerId?: string } | null;
    findByName(name: string): { createdByPeerId?: string } | undefined;
  };
  now?: () => number;
}

export class InboundCallGate {
  private readonly peerConfig: InboundCallGateDeps['peerConfig'];
  private readonly dispatch: InboundCallGateDeps['dispatch'];
  private readonly rateLimiter: PeerRateLimiter;
  private readonly audit: PeerAuditLog;
  private readonly sessionLookup: InboundCallGateDeps['sessionLookup'];
  private readonly now: () => number;

  constructor(deps: InboundCallGateDeps) {
    this.peerConfig = deps.peerConfig;
    this.dispatch = deps.dispatch;
    this.rateLimiter = deps.rateLimiter;
    this.audit = deps.audit;
    this.sessionLookup = deps.sessionLookup;
    this.now = deps.now ?? Date.now;
  }

  /** Gate + dispatch one inbound peer call. */
  async handle(peerId: string, method: string, params: unknown): Promise<unknown> {
    const argSummary = summarizeArgKeys(params);

    // 0a. Disabled-peer gate — an explicitly disabled peer is off in BOTH
    // directions. It cannot invoke tools NOR enumerate the reserved tool surface.
    // Deny with the SAME uniform message as an allow-list-deny (no existence
    // leak) so "Off" can't be probed apart from "not permitted". A peer with NO
    // config (undefined) is NOT blocked here — it falls through to the existing
    // allow-list deny, which already denies deny-by-default.
    if (this.isPeerDisabled(peerId)) {
      return this.denied(peerId, method, argSummary);
    }

    // 0. Reserved tool-discovery meta-method. Answered IN-GATE (never dispatched)
    // by intersecting the tool catalogue with this peer's allow-list, minus the
    // hard-deny set. Still rate-limited + audited so a peer cannot probe it for
    // free. This is how a remote returns the CALLER's permitted surface.
    if (method === RESERVED_PEER_TOOLS_METHOD) {
      if (!this.rateLimiter.tryConsume(peerId)) {
        this.record(peerId, method, argSummary, 'rate-limited');
        throw new GateError(JSONRPC_SERVER_ERROR, RATE_LIMIT_MESSAGE);
      }
      const tools = MCP_TOOLS
        .filter((t) => !HARD_DENY_TOOLS.has(t.name) && this.peerConfig.isToolAllowed(peerId, t.name))
        .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
      this.record(peerId, method, argSummary, 'ok');
      return { tools };
    }

    // 1. Hard-deny — never proxyable, even under a wildcard allow-list.
    if (HARD_DENY_TOOLS.has(method)) {
      return this.denied(peerId, method, argSummary);
    }

    // 1b. Ownership-gated tools — peer may only invoke these on sessions it
    // created via session_create (tracked by createdByPeerId). Falls through
    // to the allow-list check when ownership is confirmed. Uniform deny for
    // all other outcomes (not-owned, not-found, missing ref) — no information
    // leak about whether the session exists or who owns it.
    if (method === 'session_close') {
      const ownership = checkSessionOwnership(params, peerId, this.sessionLookup);
      if (ownership !== 'owned') {
        return this.denied(peerId, method, argSummary);
      }
    }

    // 2. Per-peer allow-list — same uniform message (no existence leak).
    if (!this.peerConfig.isToolAllowed(peerId, method)) {
      return this.denied(peerId, method, argSummary);
    }

    // 3. Rate limit.
    if (!this.rateLimiter.tryConsume(peerId)) {
      this.record(peerId, method, argSummary, 'rate-limited');
      throw new GateError(JSONRPC_SERVER_ERROR, RATE_LIMIT_MESSAGE);
    }

    // 4. Dispatch under a synthetic proxy identity (never a real session). Make
    // any caller-identity-override args safe FIRST — senderSessionId is wrapped
    // as a fleet address, the rest stripped — so a peer can never act under a
    // real local session identity (impersonation defence).
    const safeParams = wrapCallerIdentityOverrides(peerId, params);
    try {
      const result = await this.dispatch(method, safeParams, proxyAuthContext(peerId));
      this.record(peerId, method, argSummary, 'ok');
      return result;
    } catch (err) {
      // The wire response may carry the full message, but the PERSISTED audit
      // must be value-free: several dispatcher errors embed arg VALUES in their
      // message (e.g. `Session not found: <id>`). Store only the error TYPE.
      const message = err instanceof Error ? err.message : String(err);
      const errorType = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
      this.record(peerId, method, argSummary, 'error', errorType);
      throw new GateError(JSONRPC_SERVER_ERROR, message);
    }
  }

  /**
   * Whether `peerId` is an EXPLICITLY disabled configured peer. Default-true: a
   * missing config or an undefined/true `enabled` field is treated as enabled, so
   * only `enabled === false` disables. If the lookup surface is unavailable
   * (`get` not provided) no peer is ever considered disabled here.
   */
  private isPeerDisabled(peerId: string): boolean {
    const peer = this.peerConfig.get?.(peerId);
    return peer?.enabled === false;
  }

  /** Audit a denial and throw the uniform deny error. Never returns. */
  private denied(peerId: string, method: string, argSummary: string): never {
    this.record(peerId, method, argSummary, 'denied');
    throw new GateError(JSONRPC_SERVER_ERROR, DENY_MESSAGE);
  }

  private record(
    peerId: string,
    method: string,
    argSummary: string,
    outcome: PeerAuditOutcome,
    error?: string,
  ): void {
    this.audit.append({
      peerId,
      method,
      argSummary,
      outcome,
      ranAt: this.now(),
      ...(error ? { error } : {}),
    });
    logger.info(`[peer-gate] ${peerId} ${method} → ${outcome}`);
  }
}

/**
 * Build the audit argSummary: the SORTED top-level argument KEY NAMES only —
 * NEVER any value. This is the mechanism that keeps secrets/payloads out of the
 * audit log. Truncated to a safe length.
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
