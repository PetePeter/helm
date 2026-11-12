import { executeSequenceString } from '../input/sequence-executor.js';
import { assertSessionWritable } from './frozen.js';
import { parseSubmitSuffix } from '../mcp/submit-suffix.js';
import type { ConfigLoader } from '../config/loader.js';
import type { PtyManager, WriteIntent } from './pty-manager.js';
import type { SessionManager } from './manager.js';
import { SUBMIT_SETTLE_DELAY_MS, type DeliveryContext, type TextDeliveryOptions } from './delivery-context.js';
import { logger } from '../utils/logger.js';
import { deliveryLock as sharedDeliveryLock, type DeliveryLock } from './delivery-lock.js';
import {
  verifyDeliveryAfterDelay,
  type DeliveryVerificationResult,
} from './delivery-verification.js';
import { promptSubmitSignal } from './prompt-submit-signal.js';

/** Token patterns the sequence parser recognizes as actions, not literal text. */
const RECOGNIZED_TOKEN_PATTERNS = [
  /^(NoSend|NoEnter)$/i,
  /^Wait\s+\d+$/i,
  /^\S+\s+(Down|Up)$/i,
  /.+\+.+/, // combos like Ctrl+C
];

/** Key names the sequence parser resolves to PTY escape sequences. */
const CANONICAL_KEYS = new Set([
  'enter', 'send', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete',
  'up', 'down', 'right', 'left', 'arrowup', 'arrowdown', 'arrowright', 'arrowleft',
  'home', 'end', 'pageup', 'pagedown', 'insert', 'capslock', 'printscreen',
]);

/** Check whether a brace-group content string is a recognized Helm sequence token. */
function isRecognizedToken(token: string): boolean {
  if (!token) return false;
  for (const re of RECOGNIZED_TOKEN_PATTERNS) {
    if (re.test(token)) return true;
  }
  if (/^F\d+$/i.test(token)) return true;
  if (CANONICAL_KEYS.has(token.toLowerCase())) return true;
  return false;
}

/**
 * Escape brace groups that are NOT recognized Helm sequence tokens.
 * Handles nested braces (JSON, code) by tracking depth and escaping
 * the outermost unmatched group. Recognized tokens like {Send}, {NoSend},
 * {Wait 500}, {Ctrl+C} are preserved. Unrecognized groups have their outer
 * braces escaped to {{/}} so they render as literal text through the parser.
 */
function escapeUnrecognizedBraces(text: string): string {
  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '{') {
      // Find matching closing brace by tracking raw depth
      const start = i;
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        if (depth > 0) j++;
      }

      if (depth !== 0) {
        // Unmatched brace — emit as-is
        result += text.slice(start);
        break;
      }

      const content = text.slice(start + 1, j);

      if (isRecognizedToken(content)) {
        // Recognized token — preserve as-is
        result += text.slice(start, j + 1);
      } else {
        // Escape outer braces to {{/}}, recursively process inner content
        const inner = escapeUnrecognizedBraces(content);
        result += '{{' + inner + '}}';
      }

      i = j + 1;
    } else {
      result += text[i];
      i++;
    }
  }

  return result;
}

/**
 * Deliver prompt text through the sequence executor, honoring the recipient
 * CLI's configured submit suffix.
 *
 * This is the main-process counterpart of renderer/sequence-delivery.ts.
 * It enables {Send}, {NoSend}, {Wait} tokens in MCP inter-session text.
 * Literal curly braces in the text (e.g. JSON envelopes) are smart-escaped:
 * recognized tokens are preserved, unrecognized brace groups are escaped.
 */
/** Who a delivery speaks for. Only 'user' deliveries count as the user working (time tracking). */
export type DeliveryOrigin = 'user' | 'system';

type DeliveryObserver = (sessionId: string, origin: DeliveryOrigin) => void;
let deliveryObserver: DeliveryObserver | null = null;

/** One process-wide observer, like the delivery lock: told of every completed delivery. */
export function setDeliveryObserver(observer: DeliveryObserver | null): void {
  deliveryObserver = observer;
}

export async function deliverPromptSequenceToSession(input: {
  sessionId: string;
  text: string;
  ptyManager: PtyManager;
  sessionManager: SessionManager;
  configLoader: ConfigLoader;
  impliedSubmit?: boolean;
  deliveryContext?: DeliveryContext;
  writeIntent?: WriteIntent;
  /** Defaults to 'system'. Set 'user' where the text is a human speaking (for example, on a phone). */
  origin?: DeliveryOrigin;
  /** Overridable for tests; production uses the process-wide gate. */
  deliveryLock?: DeliveryLock;
  verifyDelivery?: {
    label?: string;
    delayMs?: number;
    retrySubmit?: boolean;
    /** Require a post-delivery submit hook even when the target appears idle. */
    requirePromptSubmit?: boolean;
    /** Run verification in background — returns undefined immediately, calls onComplete when done. */
    background?: boolean;
    onComplete?: (result: DeliveryVerificationResult) => void;
  };
}): Promise<DeliveryVerificationResult | undefined> {
  const { sessionId, text, ptyManager, sessionManager, configLoader, impliedSubmit, deliveryContext, verifyDelivery } = input;
  const writeIntent = input.writeIntent ?? (input.origin === 'user' ? 'input' : 'system');
  const session = sessionManager.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  let targetWasBusy = false;
  let busyBeforeTextInCurrentSubmit: boolean | undefined;
  assertSessionWritable(session);
  if (session.comfyUiTool) {
    throw new Error('ComfyUI sessions accept prompts through chat; terminal and automated prompt delivery is disabled.');
  }

  const cliEntry = configLoader.getCliTypeEntry(session.cliType);
  const submitSuffix = parseSubmitSuffix(cliEntry?.submitSuffix);
  let codexBusySubmitRecoverySent = false;

  const lock = input.deliveryLock ?? sharedDeliveryLock;
  const processedText = escapeUnrecognizedBraces(text);
  const textDeliveryOptions: TextDeliveryOptions | undefined = deliveryContext || input.writeIntent || input.origin === 'user'
    ? {
      ...(deliveryContext ? { deliveryContext } : {}),
      ...(input.writeIntent || input.origin === 'user' ? { writeIntent } : {}),
    }
    : undefined;
  const deliverText = async (sid: string, chunk: string, options?: TextDeliveryOptions): Promise<void> => {
    // Input-origin writes mark an idle session active. Keep the state from just
    // before the payload so that our own write is not mistaken for pre-existing work.
    if (chunk && busyBeforeTextInCurrentSubmit === undefined) {
      busyBeforeTextInCurrentSubmit = sessionManager.getSession(sid)?.activityLevel === 'active';
    }
    if (options) await ptyManager.deliverText(sid, chunk, options);
    else await ptyManager.deliverText(sid, chunk);
  };

  const runSequence = () => executeSequenceString({
    sessionId,
    input: processedText,
    write: (sid, data) => {
      ptyManager.write(sid, data, writeIntent);
    },
    deliverText: (sid, chunk) => deliverText(sid, chunk, textDeliveryOptions),
    submit: async (sid) => {
      await new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_SETTLE_DELAY_MS));
      const activityLevel = sessionManager.getSession(sid)?.activityLevel;
      targetWasBusy = activityLevel === 'active'
        && !(writeIntent === 'input' && busyBeforeTextInCurrentSubmit === false);
      busyBeforeTextInCurrentSubmit = undefined;
      await deliverText(sid, '', { ...textDeliveryOptions, submitSuffix });
      // When verification owns recovery, let it wait for the submit hook before
      // retrying. An early Enter can still land inside the running turn.
      const verifierOwnsRecovery = verifyDelivery !== undefined && verifyDelivery.retrySubmit !== false;
      if (cliEntry?.provider === 'codex' && targetWasBusy && submitSuffix === '\r' && !verifierOwnsRecovery) {
        await new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_SETTLE_DELAY_MS));
        codexBusySubmitRecoverySent = ptyManager.write(sid, submitSuffix, writeIntent);
        if (codexBusySubmitRecoverySent) {
          logger.info(`[SequenceDelivery] Codex busy submit fallback sent for ${sid}`);
        }
      }
    },
    impliedSubmit: impliedSubmit ?? true,
  });

  /**
   * One delivery, serialized against every other delivery to this session.
   *
   * The gate covers nudge through submit as a single transaction. Locking the
   * write alone would not help: two senders could both nudge before either
   * wrote, dropping one message's resize between the other's payload and its
   * submit.
   *
   * The nudge is a transient resize. Full-screen TUIs (e.g. Copilot CLI) only
   * redraw their input region on SIGWINCH; a hidden session that never received
   * a fit keeps a stale size and renders the delivered text into a mis-sized
   * buffer. Fitted PTYs skip the nudge (see PtyManager.nudgeResize).
   * Harmless for line-based CLIs, which ignore the size change.
   */
  // Stamped inside the gate: a delivery queued ahead of this one must not
  // have its submit hook mistaken for ours.
  let deliveryStartedAt = 0;
  const runTransaction = () => lock.run(sessionId, async () => {
    deliveryStartedAt = Date.now();
    await ptyManager.nudgeResize(sessionId);
    await runSequence();
  });

  await runTransaction();
  deliveryObserver?.(sessionId, input.origin ?? 'system');

  // Verification infers "the CLI took it" from terminal activity, which fits a
  // TUI that repaints constantly. An API tool is an in-process line editor: once
  // the write returns, the line is submitted or queued — nothing to verify, and
  // waiting for its first model output would outlast every caller's deadline.
  if (!verifyDelivery || cliEntry?.api) return undefined;

  const verifyRequest = {
    sessionId,
    text,
    ptyManager,
    submitSuffix,
    deliveryContext,
    writeIntent,
    label: verifyDelivery.label,
    delayMs: verifyDelivery.delayMs,
    retrySubmit: verifyDelivery.retrySubmit ?? true,
    // Recovery must replay through the sequence executor: `text` still holds
    // {Wait}/{Enter} tokens, which a raw write would type out literally. It
    // re-acquires the gate so a resend cannot interleave with a fresh delivery,
    // but does NOT nudge again — the geometry was already fixed moments ago by
    // the original transaction, and a re-send is about the payload, not the size.
    //
    // This is also why verification runs OUTSIDE the transaction and must stay
    // there. Its polling window is seconds long, so holding the gate across it
    // would serialize every sender behind one message's diagnosis — and worse,
    // this resend would be waiting on a gate its own caller still held. Pulling
    // verification inside the lock deadlocks recovery outright.
    resendPayload: () => lock.run(sessionId, runSequence),
    promptSubmit: { since: deliveryStartedAt, lastAt: () => promptSubmitSignal.lastAt(sessionId) },
    // Busy targets can redraw their composer while a turn is running. Require
    // the submit hook even for a fresh session with no prior hook observation.
    requirePromptSubmit: verifyDelivery.requirePromptSubmit ?? targetWasBusy,
  };

  if (verifyDelivery.background) {
    verifyDeliveryAfterDelay(verifyRequest)
      .then((result) => verifyDelivery.onComplete?.({ ...result, codexBusySubmitRecoverySent }))
      .catch((err) => logger.warn(`[SequenceDelivery] Background verification error for ${sessionId}: ${err}`));
    return undefined;
  }

  return verifyDeliveryAfterDelay(verifyRequest).then(result => ({ ...result, codexBusySubmitRecoverySent }));
}
