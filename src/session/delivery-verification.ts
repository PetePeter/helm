import { logger } from '../utils/logger.js';
import type { WriteIntent } from './pty-manager.js';

/**
 * Delivery verification status.
 *
 * - confirmed: tail's lastOutputAt advanced twice after delivery (CLI received and is generating)
 * - suspected_stuck: tail advanced once (initial echo) but never advanced again (CLI received, no progress)
 * - no_signal: tail's lastOutputAt never advanced from baseline (likely never reached the CLI)
 * - unverifiable: terminal tail accessor unavailable or empty payload, cannot determine delivery
 *
 * - retry_confirmed: delivery was stuck or unseen, recovery re-submitted, and the CLI then moved
 * - retry_failed: recovery was attempted the allowed number of times and the CLI still never moved
 */
export type DeliveryVerificationStatus =
  | 'confirmed'
  | 'suspected_stuck'
  | 'no_signal'
  | 'unverifiable'
  | 'retry_confirmed'
  | 'retry_failed';

export interface DeliveryVerificationRequest {
  sessionId: string;
  text: string;
  label?: string;
  /** Legacy field — ignored by the new activity-timestamp verifier. Kept for type compatibility. */
  delayMs?: number;
  /**
   * Enable recovery when delivery does not land (default true). Callers delivering raw
   * terminal control input (arrows, Esc, Ctrl combos) pass false: re-sending navigation
   * keys into a TUI would move it somewhere unintended.
   */
  retrySubmit?: boolean;
  submitSuffix: string;
  deliveryContext?: 'background' | 'interactive';
  writeIntent?: WriteIntent;
  /**
   * Replays the original delivery. Required for callers whose `text` is a sequence
   * string ({Wait 500}, {Enter}, …): writing that raw would put the tokens on the
   * prompt as literal characters. Without it, a full re-send falls back to writing
   * `text` directly, which is only correct for plain payloads.
   */
  resendPayload?: () => Promise<void>;
  ptyManager: {
    getTerminalTail?: (sessionId: string, lines: number, mode: 'raw' | 'stripped' | 'both', stripBlankLines?: boolean) => { lastOutputAt?: number } | undefined;
    deliverText?: (sessionId: string, text: string, options?: { submitSuffix?: string; deliveryContext?: 'background' | 'interactive' }) => Promise<void>;
    write?: (sessionId: string, data: string, intent?: WriteIntent) => void;
  };
}

export interface DeliveryVerificationResult {
  status: DeliveryVerificationStatus;
  sessionId: string;
  label?: string;
  detail: string;
  /** True when at least one recovery re-send was made. */
  retryAttempted: boolean;
  /** Number of recovery re-sends made (0 when delivery landed first time). */
  retryCount: number;
  /** A second Enter was sent after the implied submit for a busy Codex session. */
  codexBusySubmitRecoverySent?: boolean;
  /** Legacy field — represents total elapsed verification time. */
  delayMs: number;
}

// Phase 1 — "seen": how long to wait for the first lastOutputAt advance.
const SEEN_TIMEOUT_MS = 8000;
// Phase 2 — "moved past": after the first advance, how long to wait for another advance.
const NOT_SEEN_TIMEOUT_MS = 6000;
// Poll interval used in both phases.
const POLL_INTERVAL_MS = 200;

// Minimum gap between first and second advance — a single fresh tick after the
// initial echo confirms the CLI is actually generating output, not just echoing input.
const MIN_PROGRESS_GAP_MS = 250;

// Fast-path budgets used when the caller passes delayMs === 0 (typically tests). Same
// seen→moved-past logic, compressed windows so unit tests don't stall on the full budget.
const FAST_SEEN_TIMEOUT_MS = 200;
const FAST_NOT_SEEN_TIMEOUT_MS = 600;
const FAST_POLL_INTERVAL_MS = 20;

// Recovery budgets. A stuck CLI already holds the text in its prompt, so recovery
// only re-sends the submit suffix — cheap and safe to repeat. A CLI that produced
// no output at all likely never received the text, so the whole payload goes again,
// once, because a second copy of a real message is worse than a missed one.
const MAX_STUCK_RESUBMITS = 2;
const MAX_UNSEEN_RESENDS = 1;

// Recovery passes run on halved budgets. The first pass already established that the
// session is quiet, and the caller is an LLM blocked on the answer — a full-length
// pass per attempt would push a stuck delivery past 40s before it reports back.
const RECOVERY_BUDGET_SCALE = 0.5;

/** Outcome of one verification pass, before any recovery decision. */
type PhaseStatus = 'confirmed' | 'suspected_stuck' | 'no_signal';

interface PhaseOutcome {
  status: PhaseStatus;
  detail: string;
}

interface Budgets {
  seen: number;
  notSeen: number;
  poll: number;
}

/**
 * Activity-timestamp delivery verification.
 *
 * Phase 1 polls the tail's `lastOutputAt` until it advances past the baseline
 * (confirms *some* output happened after delivery — typically the echo of our input).
 * Phase 2 keeps polling until `lastOutputAt` advances again past the first-advance
 * timestamp (confirms the CLI moved past the echo — i.e. is generating a response).
 *
 * Why timestamps instead of substring matching: TUI CLIs (Claude Code, etc.) draw
 * user input via ANSI boxes, so the delivered text rarely appears as a literal
 * substring in the stripped tail. The lastOutputAt timestamp is a reliable signal
 * that the PTY emitted bytes — regardless of how they render.
 *
 * A pass that does not confirm is then remedied rather than merely reported: see the
 * recovery ladder below (suffix-only for a stuck prompt, full re-send for silence).
 *
 * The `_before` and `_deliveredAt` parameters are accepted for signature stability
 * with the previous verifier but are not used in the new logic.
 */
export async function verifyDeliveryAfterDelay(
  request: DeliveryVerificationRequest,
  _before?: unknown,
  _deliveredAt?: number,
): Promise<DeliveryVerificationResult> {
  if (typeof request.ptyManager.getTerminalTail !== 'function') {
    return makeResult(request, 'unverifiable', 'terminal tail is unavailable', 0, 0);
  }

  if (!request.text && !request.submitSuffix) {
    return makeResult(request, 'unverifiable', 'no payload delivered', 0, 0);
  }

  const fastMode = request.delayMs === 0;
  const budgets: Budgets = {
    seen: fastMode ? FAST_SEEN_TIMEOUT_MS : SEEN_TIMEOUT_MS,
    notSeen: fastMode ? FAST_NOT_SEEN_TIMEOUT_MS : NOT_SEEN_TIMEOUT_MS,
    poll: fastMode ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
  };

  const startedAt = Date.now();
  const firstPass = await runVerificationPass(request, budgets);
  const elapsed = () => Date.now() - startedAt;

  if (firstPass.status === 'confirmed') {
    return makeResult(request, 'confirmed', firstPass.detail, elapsed(), 0);
  }

  // Recovery is opt-out (raw terminal input disables it) and needs a write path.
  if (request.retrySubmit === false || !canResend(request)) {
    return makeResult(request, firstPass.status, firstPass.detail, elapsed(), 0);
  }

  // The first pass decides the recovery mode for the whole ladder: a CLI holding
  // the text only needs Enter again, and must never be sent the text twice.
  const resendText = firstPass.status === 'no_signal';
  const maxAttempts = resendText ? MAX_UNSEEN_RESENDS : MAX_STUCK_RESUBMITS;
  // Fast mode is the test compression; scaling it further would leave no room to observe.
  const recoveryBudgets: Budgets = fastMode
    ? budgets
    : {
        seen: budgets.seen * RECOVERY_BUDGET_SCALE,
        notSeen: budgets.notSeen * RECOVERY_BUDGET_SCALE,
        poll: budgets.poll,
      };

  let retryCount = 0;
  let lastDetail = firstPass.detail;

  while (retryCount < maxAttempts) {
    const sent = await resend(request, resendText);
    if (!sent) break;
    retryCount++;

    const pass = await runVerificationPass(request, recoveryBudgets);
    lastDetail = pass.detail;
    if (pass.status === 'confirmed') {
      const what = resendText ? 'full re-send' : 'submit re-send';
      return makeResult(
        request,
        'retry_confirmed',
        `recovered after ${retryCount} ${what}(s)`,
        elapsed(),
        retryCount,
      );
    }
  }

  if (retryCount === 0) {
    return makeResult(request, firstPass.status, firstPass.detail, elapsed(), 0);
  }

  return makeResult(
    request,
    'retry_failed',
    `still not delivered after ${retryCount} recovery attempt(s): ${lastDetail}`,
    elapsed(),
    retryCount,
  );
}

/**
 * One verification pass: wait for the tail to tick once (the CLI saw something),
 * then to tick again (the CLI moved past the echo and is generating).
 */
async function runVerificationPass(
  request: DeliveryVerificationRequest,
  budgets: Budgets,
): Promise<PhaseOutcome> {
  // Baseline: default to "just before now" so any tick from here counts as advanced.
  const baselineOutputAt = currentLastOutputAt(request) ?? (Date.now() - 1);

  const seenAt = await pollUntil(
    () => {
      const v = currentLastOutputAt(request);
      return v !== undefined && v > baselineOutputAt;
    },
    budgets.seen,
    budgets.poll,
  );

  if (!seenAt) {
    return { status: 'no_signal', detail: `tail activity never advanced within ${budgets.seen}ms` };
  }

  const firstAdvanceAt = currentLastOutputAt(request) ?? seenAt;

  const movedPastAt = await pollUntil(
    () => {
      const v = currentLastOutputAt(request);
      return v !== undefined && v > firstAdvanceAt + MIN_PROGRESS_GAP_MS;
    },
    budgets.notSeen,
    budgets.poll,
  );

  if (!movedPastAt) {
    return {
      status: 'suspected_stuck',
      detail: `tail activity stalled after initial advance for ${budgets.notSeen}ms`,
    };
  }

  return { status: 'confirmed', detail: 'tail activity advanced twice — CLI is producing output' };
}

/** True when the request carries a write path recovery can use. */
function canResend(request: DeliveryVerificationRequest): boolean {
  return typeof request.resendPayload === 'function'
    || typeof request.ptyManager.deliverText === 'function'
    || typeof request.ptyManager.write === 'function';
}

/**
 * Re-send to unstick a delivery. `withText` false sends only the submit suffix —
 * the text is already sitting in the CLI's prompt, so re-sending it would duplicate
 * the message. Returns false when there was nothing to send.
 */
async function resend(request: DeliveryVerificationRequest, withText: boolean): Promise<boolean> {
  const text = withText ? request.text : '';
  if (!text && !request.submitSuffix) return false;

  const options = {
    ...(request.submitSuffix ? { submitSuffix: request.submitSuffix } : {}),
    ...(request.deliveryContext ? { deliveryContext: request.deliveryContext } : {}),
    ...(request.writeIntent ? { writeIntent: request.writeIntent } : {}),
  };

  try {
    if (withText && typeof request.resendPayload === 'function') {
      await request.resendPayload();
    } else if (typeof request.ptyManager.deliverText === 'function') {
      await request.ptyManager.deliverText(request.sessionId, text, options);
    } else if (typeof request.ptyManager.write === 'function') {
      request.ptyManager.write(request.sessionId, text + request.submitSuffix, request.writeIntent);
    } else {
      return false;
    }
  } catch (err) {
    logger.warn(`[DeliveryVerification] recovery re-send failed for ${request.sessionId}: ${err}`);
    return false;
  }

  logger.info(
    `[DeliveryVerification] recovery re-send for ${request.sessionId} (${withText ? 'text+submit' : 'submit only'})`,
  );
  return true;
}

/**
 * Probe the current tail's lastOutputAt timestamp. Returns undefined on probe
 * failure so the caller treats it as "no activity yet" and keeps polling.
 */
function currentLastOutputAt(request: DeliveryVerificationRequest): number | undefined {
  try {
    const tail = request.ptyManager.getTerminalTail?.(request.sessionId, 1, 'stripped', false);
    return tail?.lastOutputAt;
  } catch (err) {
    logger.warn(`[DeliveryVerification] tail probe failed for ${request.sessionId}: ${err}`);
    return undefined;
  }
}

/**
 * Poll the predicate every `intervalMs` until it returns true or the budget
 * is exhausted. Returns the timestamp at which it matched, or null on timeout.
 */
async function pollUntil(
  predicate: () => boolean,
  budgetMs: number,
  intervalMs: number,
): Promise<number | null> {
  const deadline = Date.now() + budgetMs;
  if (predicate()) return Date.now();
  while (Date.now() < deadline) {
    await wait(intervalMs);
    if (predicate()) return Date.now();
  }
  return null;
}

function makeResult(
  request: DeliveryVerificationRequest,
  status: DeliveryVerificationStatus,
  detail: string,
  delayMs: number,
  retryCount: number,
): DeliveryVerificationResult {
  return {
    status,
    sessionId: request.sessionId,
    ...(request.label ? { label: request.label } : {}),
    detail,
    retryAttempted: retryCount > 0,
    retryCount,
    delayMs,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
