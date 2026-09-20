/**
 * HookReceiver — the dispatch behind POST /hooks on the localhost server.
 *
 * G2: PreToolUse events route through the policy, which may DENY with a
 * reason the CLI feeds back to the model. G4: every other steerable event
 * (SessionStart, UserPromptSubmit, Stop) routes through the injected
 * responder — the ContextInjector — which may return additionalContext or a
 * one-shot stop block. Everything else stays G1: normalise, stamp the Helm
 * session id the bearer token resolved to, log the traffic, emit the event.
 *
 * FAIL OPEN on every decision path: unknown tools and events allow by
 * construction, and any error inside the decision machinery — a throwing
 * session lookup, a broken rule source, a throwing responder — is swallowed
 * into a no-op. A crashed or confused decision must never brick a session.
 */

import { EventEmitter } from 'node:events';
import { encodeDenyResponse, normaliseHookEvent, type HookEvent, type HookProvider } from './hook-normaliser.js';
import { decideHookPolicy } from './hook-policy.js';
import type { InjectorResponse } from './context-injector.js';
import type { SessionInfo } from '../../types/session.js';
import { logger } from '../../utils/logger.js';

export interface HookReceiverDeps {
  now?: () => number;
  /** Resolves the Helm session a hook belongs to; the policy's session source. */
  getSession?: (helmSessionId: string) => SessionInfo | null;
  /** Deny rules for a provider, read live from config; empty = deny nothing. */
  getDenyRules?: (cli: HookProvider) => readonly unknown[] | null;
  /**
   * G4's non-deny responder (injection, nudges). Null/absent = no-op for
   * every event the policy is not involved in. Absent in G1/G2 wiring.
   */
  respond?: (event: HookEvent) => Promise<InjectorResponse>;
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
   * Async because the G4 responder awaits the (Promise-seamed) suggester —
   * the CLI blocks on this HTTP reply either way.
   */
  async receive(raw: unknown, helmSessionId: string | null): Promise<HookReceiveResult> {
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
    if (event.event === 'PreToolUse') return this.decide(correlated);
    return this.decideContext(correlated);
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

  /**
   * The G4 decision step for every non-policy event. Same belt around the
   * same braces: a throwing responder degrades to a no-op reply, which both
   * means "no injection this turn" and "the turn ends normally" on Stop.
   */
  private async decideContext(event: HookEvent): Promise<HookReceiveResult> {
    if (!this.deps.respond) return NO_OP;
    try {
      return (await this.deps.respond(event)) ?? NO_OP;
    } catch (error) {
      logger.warn(`[Hook] Injection failed open for ${event.cli} ${event.event}: ${String(error)}`);
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
