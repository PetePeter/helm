/**
 * HookReceiver — the dispatch behind POST /hooks on the localhost server.
 *
 * G2: PreToolUse events route through the policy, which may DENY with a
 * reason the CLI feeds back to the model. The ContextInjector also responds
 * to PreToolUse and every other known event; on a deny its alert is merged
 * without changing the policy decision. Other events may return context or a
 * one-shot stop block.
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
  /** The G4 responder. Comes from deps, or is bound late via setResponder. */
  private respond?: HookReceiverDeps['respond'];

  constructor(deps: HookReceiverDeps = {}) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.respond = deps.respond;
  }

  /**
   * Bind the G4 responder after construction. The receiver is built with the
   * localhost server, but the ContextInjector needs managers that are only
   * constructed later in the handler setup (handover, plans, drafts) — the
   * same late-binding idiom the rest of the stack uses.
   */
  setResponder(respond: NonNullable<HookReceiverDeps['respond']>): void {
    this.respond = respond;
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
  private async decide(event: HookEvent): Promise<HookReceiveResult> {
    if (event.event !== 'PreToolUse') return NO_OP;
    try {
      const rules = this.deps.getDenyRules?.(event.cli) ?? [];
      const session = event.helmSessionId ? this.deps.getSession?.(event.helmSessionId) ?? null : null;
      const decision = decideHookPolicy(event, session, rules);
      if (decision.decision === 'deny') {
        logger.info(
          `[Hook] Denied ${event.cli} ${event.toolName} session=${event.helmSessionId ?? '?'}: ${decision.reason}`,
        );
        const denied = { statusCode: 200, body: encodeDenyResponse(event, decision.reason!) };
        return this.mergeContext(denied, await this.safeRespond(event));
      }
      return (await this.safeRespond(event)) ?? NO_OP;
    } catch (error) {
      logger.warn(`[Hook] Policy failed open for ${event.cli} ${event.toolName}: ${String(error)}`);
      return (await this.safeRespond(event)) ?? NO_OP;
    }
  }

  /**
   * The G4 decision step for every non-policy event. Same belt around the
   * same braces: a throwing responder degrades to a no-op reply, which both
   * means "no injection this turn" and "the turn ends normally" on Stop.
   */
  private async decideContext(event: HookEvent): Promise<HookReceiveResult> {
    return (await this.safeRespond(event)) ?? NO_OP;
  }

  private async safeRespond(event: HookEvent): Promise<HookReceiveResult | null> {
    const respond = this.respond;
    if (!respond) return null;
    try {
      return (await respond(event)) ?? null;
    } catch (error) {
      logger.warn(`[Hook] Injection failed open for ${event.cli} ${event.event}: ${String(error)}`);
      return null;
    }
  }

  /** Keep a policy deny intact while adding any red alert to its reply. */
  private mergeContext(primary: HookReceiveResult, context: HookReceiveResult | null): HookReceiveResult {
    if (!context) return primary;
    const body = primary.body && typeof primary.body === 'object' && !Array.isArray(primary.body)
      ? { ...(primary.body as Record<string, unknown>) }
      : {};
    const extra = context.body && typeof context.body === 'object' && !Array.isArray(context.body)
      ? context.body as Record<string, unknown>
      : {};
    const baseSpecific = body.hookSpecificOutput;
    const extraSpecific = extra.hookSpecificOutput;
    if (extraSpecific && typeof extraSpecific === 'object' && !Array.isArray(extraSpecific)) {
      const nested = extraSpecific as Record<string, unknown>;
      const currentSpecific = baseSpecific && typeof baseSpecific === 'object' && !Array.isArray(baseSpecific)
        ? baseSpecific as Record<string, unknown>
        : {};
      body.hookSpecificOutput = { ...nested, ...currentSpecific };
      if (typeof nested.additionalContext === 'string' && typeof currentSpecific.additionalContext === 'string') {
        (body.hookSpecificOutput as Record<string, unknown>).additionalContext =
          `${currentSpecific.additionalContext}\n\n${nested.additionalContext}`;
      }
    }
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'hookSpecificOutput') continue;
      if (typeof value === 'string' && typeof body[key] === 'string' && key === 'additionalContext') {
        body[key] = `${body[key]}\n\n${value}`;
      } else if (!(key in body)) {
        body[key] = value;
      }
    }
    return { statusCode: primary.statusCode, body };
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
