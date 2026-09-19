/**
 * HookReceiver — the dispatch behind POST /hooks on the localhost server.
 *
 * G1 decides NOTHING. The receiver normalises, stamps the Helm session id the
 * bearer token resolved to, logs the traffic so it is visible, and emits the
 * event for later groups (G2 deny policy, injection, …). The reply is always
 * a no-op decision — fail-open by construction, matching the CLIs' own
 * timeout behaviour. A hook must never be able to brick a session.
 */

import { EventEmitter } from 'node:events';
import { normaliseHookEvent, type HookEvent } from './hook-normaliser.js';
import { logger } from '../../utils/logger.js';

export interface HookReceiverDeps {
  now?: () => number;
}

export interface HookReceiveResult {
  statusCode: number;
  body: unknown;
}

const NO_OP: HookReceiveResult = { statusCode: 200, body: {} };

export class HookReceiver extends EventEmitter {
  private readonly now: () => number;

  constructor(deps: HookReceiverDeps = {}) {
    super();
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
    logger.info(
      `[Hook] ${correlated.cli} ${correlated.event}` +
        ` session=${correlated.helmSessionId ?? '?'}` +
        `${correlated.toolName ? ` tool=${correlated.toolName}` : ''}` +
        `${correlated.cwd ? ` cwd=${correlated.cwd}` : ''}`,
    );
    this.emit('hook', correlated);
    return NO_OP;
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
