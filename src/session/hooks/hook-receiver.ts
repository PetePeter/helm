/**
 * HookReceiver — the dispatch behind POST /hooks on the localhost server.
 *
 * G2: PreToolUse events route through the policy, which may DENY with a
 * reason the CLI feeds back to the model. Everything else stays G1:
 * normalise, stamp the Helm session id the bearer token resolved to, log the
 * traffic, and emit the event for later groups (injection, …).
 *
 * FAIL OPEN on every path the policy is involved in: unknown tools and events
 * allow by construction, and any error inside the decision machinery — a
 * throwing session lookup, a broken rule source — is swallowed into allow.
 * A crashed or confused policy must never be able to brick a session.
 */

import { EventEmitter } from 'node:events';
import { encodeDenyResponse, normaliseHookEvent, type HookEvent, type HookProvider } from './hook-normaliser.js';
import { decideHookPolicy } from './hook-policy.js';
import type { SessionInfo } from '../../types/session.js';
import { logger } from '../../utils/logger.js';

export interface HookReceiverDeps {
  now?: () => number;
  /** Resolves the Helm session a hook belongs to; the policy's session source. */
  getSession?: (helmSessionId: string) => SessionInfo | null;
  /** Deny rules for a provider, read live from config; empty = deny nothing. */
  getDenyRules?: (cli: HookProvider) => readonly unknown[] | null;
}

export interface HookReceiveResult {
  statusCode: number;
  body: unknown;
}

const NO_OP: HookReceiveResult = { statusCode: 200, body: {} };

export class HookReceiver extends EventEmitter {
  private readonly now: () => number;
  private readonly deps: HookReceiverDeps;

  constructor(deps: HookReceiverDeps = {}) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * One inbound shim envelope. `helmSessionId` comes from the server's session
   * token auth — the payload's own session id is the CLI's, not Helm's.
   * Every malformed input is swallowed with a no-op: the shim does not read
   * error statuses beyond "reply or not", so there is nothing useful to say.
   */
  receive(raw: unknown, helmSessionId: string | null): HookReceiveResult {
    if (!isInboundBody(raw)) {
      logger.warn('[Hook] Dropped a malformed hook body');
      return NO_OP;
    }

    const event = normaliseHookEvent(raw, this.now);
    if (!event) {
      logger.info(`[Hook] Ignored unknown event ${raw.cli}/${raw.event}`);
      return NO_OP;
    }

    const correlated: HookEvent = { ...event, helmSessionId };
    // PreToolUse/PostToolUse fire on EVERY tool call — two lines per tool use
    // at info would bury the log's real signal. The happy path is debug; the
    // abnormal paths below stay visible.
    logger.debug(
      `[Hook] ${correlated.cli} ${correlated.event}` +
        ` session=${correlated.helmSessionId ?? '?'}` +
        `${correlated.toolName ? ` tool=${correlated.toolName}` : ''}` +
        `${correlated.cwd ? ` cwd=${correlated.cwd}` : ''}`,
    );
    this.emit('hook', correlated);
    return this.decide(correlated);
  }

  /**
   * The G2 decision step. Only PreToolUse is policy business; every other
   * event allows. Everything failure-shaped degrades to allow — the policy
   * itself is pure and defensive, and this wrapper is the belt to its braces.
   */
  private decide(event: HookEvent): HookReceiveResult {
    if (event.event !== 'PreToolUse') return NO_OP;
    try {
      const rules = this.deps.getDenyRules?.(event.cli) ?? [];
      const session = event.helmSessionId ? this.deps.getSession?.(event.helmSessionId) ?? null : null;
      const decision = decideHookPolicy(event, session, rules);
      if (decision.decision === 'deny') {
        logger.info(
          `[Hook] Denied ${event.cli} ${event.toolName} session=${event.helmSessionId ?? '?'}: ${decision.reason}`,
        );
        return { statusCode: 200, body: encodeDenyResponse(event, decision.reason!) };
      }
      return NO_OP;
    } catch (error) {
      logger.warn(`[Hook] Policy failed open for ${event.cli} ${event.toolName}: ${String(error)}`);
      return NO_OP;
    }
  }
}

function isInboundBody(value: unknown): value is { cli: string; event: string; payload: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { cli?: unknown; event?: unknown; payload?: unknown };
  return (
    typeof candidate.cli === 'string' &&
    typeof candidate.event === 'string' &&
    !!candidate.payload &&
    typeof candidate.payload === 'object' &&
    !Array.isArray(candidate.payload)
  );
}
