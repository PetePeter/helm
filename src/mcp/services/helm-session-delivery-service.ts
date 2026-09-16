import { logger } from '../../utils/logger.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionManager } from '../../session/manager.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { SessionInfo } from '../../types/session.js';
import { deliverPromptSequenceToSession } from '../../session/sequence-delivery.js';
import { isMobileSessionId } from '../../mobile/mobile-identity.js';
import type { DeliveryVerificationResult } from '../../session/delivery-verification.js';
import {
  buildLargeTextTempFileNotice,
  shouldSendLargeTextAsTempFile,
  writeLargeTextTempFile,
} from '../../session/large-text-temp-file.js';

const DEFAULT_DELIVERY_VERIFY_DELAY_MS = 4000;
const DEFAULT_CLEAR_SETTLE_DELAY_MS = 1500;
const DEFAULT_CLEAR_COMMAND = '/clear';

/** Advisory returned by worker-control actions — CLIs process clear/compact/export asynchronously. */
const ACTION_WAIT_NOTE =
  'Command delivered. The CLI may take up to ~1 minute to finish — wait before reading its output.';

/**
 * Directive appended to every enveloped inter-session message.
 *
 * Why: the recipient is driven by another LLM — local or across the fleet — and
 * nobody is watching its terminal. An AskUserQuestion modal there blocks
 * forever, unseen. Questions must travel back over the same wire the work came
 * in on. Mirrors the guarantee Telegram mode already gives (relay-service.ts).
 *
 * Contains no brace tokens: the sequence parser would rewrite them.
 */
function buildNonBlockingDirective(senderSessionId: string): string {
  return (
    '[HELM_MSG_RULES]\n' +
    `${describeSender(senderSessionId)} ` +
    'Nobody can see or answer an interactive prompt here.\n' +
    'Do NOT use AskUserQuestion or any other blocking prompt.\n' +
    `If you need a decision, ${buildReplyInstruction(senderSessionId)} — ` +
    'then stand by for the reply. Do not guess and do not proceed on assumptions.\n' +
    'While standing by, call session_set_aiagent_state with state="planning" so the wait is visible on your session row.\n' +
    '[/HELM_MSG_RULES]'
  );
}

/** One sentence of provenance, so the recipient knows who it is actually talking to. */
function describeSender(senderSessionId: string): string {
  return isMobileSessionId(senderSessionId)
    ? 'This message came from the user on a paired phone, not from a human at this terminal.'
    : 'This message came from another Helm session, not from a human at this terminal.';
}

/**
 * How the recipient answers whoever sent the message.
 *
 * WHY the branch: a phone is not a session. Its sender address is the synthetic
 * `mobile:<deviceId>` proxy identity (docs/mobile-gate.md), which nothing in
 * session_send_text can resolve — a recipient told to reply there got "Session
 * not found" every single time. The phone's surface is chat_send, which routes
 * to the recipient's own bound chat (the phone over BLE, Telegram if
 * configured), exactly as Telegram mode routes replies through telegram_chat.
 * Local and fleet senders are real addressable sessions and keep send_text.
 */
function buildReplyInstruction(senderSessionId: string): string {
  if (isMobileSessionId(senderSessionId)) {
    return 'send the question back to the user with chat_send text="<your question>". Keep lines short — they are read on a phone';
  }
  return (
    'send the question back to your caller with session_send_text ' +
    `sessionId="${senderSessionId}", senderSessionId=<your HELM_SESSION_ID>, expectsResponse=true`
  );
}

/** The reply-routing hint carried on the opening tag when a response is expected. */
function buildExpectsResponseTag(senderSessionId: string): string {
  if (isMobileSessionId(senderSessionId)) {
    return '[HELM_MSG: expectsResponse=true. To reply, call MCP tool mcp__helm__chat_send with: text="<your reply>". It reaches the user on the phone they sent this from; keep lines short.]';
  }
  return `[HELM_MSG: expectsResponse=true. To reply, call MCP tool mcp__helm__session_send_text with: sessionId="${senderSessionId}", senderSessionId=<your env $HELM_SESSION_ID>, text="<your reply>". Your HELM_SESSION_ID is injected by Helm at startup.]`;
}

/**
 * Flatten a verification result into the caller-facing delivery outcome.
 *
 * The status and retry count travel back to the sending LLM so an unattended
 * caller can tell "the CLI is working on it" from "it never got sent" instead of
 * moving on behind a bare boolean.
 */
function summarizeDelivery(
  verification: DeliveryVerificationResult | undefined,
): { verified: boolean; deliveryStatus: string; retryCount: number } {
  if (!verification) {
    return { verified: true, deliveryStatus: 'unverified', retryCount: 0 };
  }
  const verified = verification.status === 'confirmed' || verification.status === 'retry_confirmed';
  return { verified, deliveryStatus: verification.status, retryCount: verification.retryCount };
}

/** Replace $-prefixed placeholders (e.g. $instruction, $path) in an action template. */
function substituteActionParams(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.split(key).join(value);
  }
  return result;
}

function getDeliveryVerifyDelayMs(): number {
  const configured = process.env.HELM_INTERSESSION_VERIFY_DELAY_MS;
  if (configured === undefined) return DEFAULT_DELIVERY_VERIFY_DELAY_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELIVERY_VERIFY_DELAY_MS;
}

function getClearSettleDelayMs(): number {
  const configured = process.env.HELM_CLEAR_SETTLE_DELAY_MS;
  if (configured === undefined) return DEFAULT_CLEAR_SETTLE_DELAY_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CLEAR_SETTLE_DELAY_MS;
}

/**
 * Handles inter-session text delivery via PTY stdin.
 * Wraps messages in [HELM_MSG] envelopes unless the recipient CLI disables preamble.
 */
/**
 * The slice of HandoverDelivery this service needs. Narrow on purpose: the MCP
 * layer only ever hands a handover over, it never waits on or inspects one.
 */
export interface HandoverArming {
  arm(sessionId: string, text: string): void;
}

export class HelmSessionDeliveryService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly ptyManager: PtyManager,
    private readonly configLoader: ConfigLoader,
    private handover?: HandoverArming,
  ) {}

  /**
   * Late-bind the handover sink.
   *
   * HandoverDelivery needs the StateDetector, which is wired after the MCP
   * services are built. A setter keeps that ordering out of an already
   * ten-argument constructor chain.
   */
  setHandoverDelivery(handover: HandoverArming): void {
    this.handover = handover;
  }

  /**
   * Send text to a session's PTY with optional [HELM_MSG] envelope.
   * The envelope carries sender metadata and reply-routing instructions.
   */
  async sendTextToSession(
    sessionRef: string,
    text: string,
    options?: { senderSessionId?: string; senderSessionName?: string; expectsResponse?: boolean },
  ): Promise<{ ok: true; preambleUsed: boolean; verified: boolean; deliveryStatus: string; retryCount: number }> {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (!this.ptyManager.has(session.id)) {
      throw new Error(`Session PTY is not running: ${session.id}`);
    }
    if (!options?.senderSessionId || !options?.senderSessionName) {
      throw new Error('senderSessionId and senderSessionName are required — anonymous messages are not allowed');
    }
    if (session.id === options.senderSessionId) {
      throw new Error('Cannot send a message from a session to itself — sender and receiver must be different sessions');
    }

    // Determine if recipient wants the Helm preamble
    const recipientEntry = this.configLoader.getCliTypeEntry(session.cliType);
    const usePreamble = recipientEntry?.helmPreambleForInterSession ?? true;
    let deliveryText = text;
    if (shouldSendLargeTextAsTempFile(recipientEntry?.largeTextAsTempFile, text)) {
      const tempFilePath = writeLargeTextTempFile(text, 'session-send-text');
      deliveryText = buildLargeTextTempFileNotice(tempFilePath, 'session_send_text payload');
      logger.info(`[HelmSessionDelivery] Wrote large session_send_text payload to temp file for ${session.id}: ${tempFilePath}`);
    }

    let deliveryVerification: DeliveryVerificationResult | undefined;

    if (usePreamble) {
      // Send with [HELM_MSG] envelope
      const expectsResponse = options.expectsResponse ?? false;
      const envelope = JSON.stringify({
        type: 'inter_llm_message',
        fromSessionId: options.senderSessionId,
        fromSessionName: options.senderSessionName,
        expectsResponse,
        timestamp: new Date().toISOString(),
      });

      const tag = expectsResponse
        ? buildExpectsResponseTag(options.senderSessionId)
        : '[HELM_MSG]';
      // Envelope JSON braces will be smart-escaped by escapeUnrecognizedBraces
      // (unrecognized brace groups get {{/}}), while user text tokens like {Send}
      // are preserved since they are recognized tokens.
      //
      // Frame, payload and directive are concatenated with no separator, so the
      // documented "[HELM_MSG]{json}" opening and the user text stay byte-exact
      // for existing envelope parsers.
      //
      // They are deliberately NOT split with {Wait} tokens: a wait forces the
      // sequence executor to flush, turning one message into three PTY writes —
      // three bracketed pastes into the recipient's composer, each one a chance
      // for a full-screen TUI to still be ingesting when the submit lands. Same
      // bytes, one race instead of three.
      const directive = buildNonBlockingDirective(options.senderSessionId);
      const message = `${tag}${envelope}${deliveryText}${directive}`;

      deliveryVerification = await deliverPromptSequenceToSession({
        sessionId: session.id,
        text: message,
        ptyManager: this.ptyManager,
        sessionManager: this.sessionManager,
        configLoader: this.configLoader,
        verifyDelivery: {
          label: 'inter-session message',
          delayMs: getDeliveryVerifyDelayMs(),
          retrySubmit: true,
        },
      });
    } else {
      // Send plain text only — no envelope. Smart escaping handles both tokens and literals.
      deliveryVerification = await deliverPromptSequenceToSession({
        sessionId: session.id,
        text: deliveryText,
        ptyManager: this.ptyManager,
        sessionManager: this.sessionManager,
        configLoader: this.configLoader,
        verifyDelivery: {
          label: 'inter-session message',
          delayMs: getDeliveryVerifyDelayMs(),
          retrySubmit: true,
        },
      });
    }

    if (deliveryVerification && deliveryVerification.status !== 'confirmed' && deliveryVerification.status !== 'retry_confirmed') {
      logger.warn(`[HelmSessionDelivery] Delivery verification for ${session.id}: ${deliveryVerification.status} (${deliveryVerification.detail})`);
    }

    return { ok: true, preambleUsed: usePreamble, ...summarizeDelivery(deliveryVerification) };
  }

  /**
   * Send sequence-style terminal input to a session's PTY without HELM_MSG envelope.
   * Used for TUI navigation: Esc, Tab, arrows, Ctrl combos, waits, and literal text.
   */
  async sendInputToSession(
    sessionRef: string,
    sequence: string,
    options?: { senderSessionId?: string; senderSessionName?: string; impliedSubmit?: boolean; verify?: boolean },
  ): Promise<{ ok: true; verified: boolean; deliveryStatus: string; retryCount: number }> {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (!this.ptyManager.has(session.id)) {
      throw new Error(`Session PTY is not running: ${session.id}`);
    }
    if (!options?.senderSessionId || !options?.senderSessionName) {
      throw new Error('senderSessionId and senderSessionName are required — anonymous input is not allowed');
    }
    if (session.id === options.senderSessionId) {
      throw new Error('Cannot send input from a session to itself — sender and receiver must be different sessions');
    }

    logger.debug(`[HelmSessionDelivery] session_send_input from "${options.senderSessionName}" to "${session.name}" (${session.id}): ${sequence.slice(0, 80)}`);

    const verify = options.verify ?? true;
    const deliveryVerification = await deliverPromptSequenceToSession({
      sessionId: session.id,
      text: sequence,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      impliedSubmit: options.impliedSubmit ?? false,
      verifyDelivery: verify ? { label: 'terminal input', delayMs: getDeliveryVerifyDelayMs(), retrySubmit: false } : undefined,
    });

    if (deliveryVerification && deliveryVerification.status !== 'confirmed' && deliveryVerification.status !== 'retry_confirmed') {
      logger.warn(`[HelmSessionDelivery] Delivery verification for terminal input to ${session.id}: ${deliveryVerification.status} (${deliveryVerification.detail})`);
    }

    return { ok: true, ...summarizeDelivery(deliveryVerification) };
  }

  /**
   * Deliver one app-owned Mess reminder without an inter-session envelope.
   * This deliberately has no sender identity: it is local Helm system input,
   * not a message pretending to come from another session.
   */
  async sendSystemReminder(
    sessionRef: string,
    text: string,
    options?: { onVerification?: (verified: boolean) => void },
  ): Promise<void> {
    const session = this.requireRunningSession(sessionRef);
    if (!text || text.includes('\n') || text.includes('\r')) {
      throw new Error('System reminders must be exactly one non-empty line');
    }

    await deliverPromptSequenceToSession({
      sessionId: session.id,
      text,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      deliveryContext: 'background',
      writeIntent: 'system',
      verifyDelivery: {
        label: 'Mess system reminder',
        delayMs: getDeliveryVerifyDelayMs(),
        retrySubmit: true,
        background: true,
        onComplete: result => options?.onVerification?.(
          result.status === 'confirmed' || result.status === 'retry_confirmed',
        ),
      },
    });
  }

  /**
   * Clear a session's context by delivering its configured clear command, then
   * optionally relay a "note to future self" so the freshly-cleared session
   * retains what matters. Targets any session by sessionId (required).
   *
   * The clear sequence is resolved from helmActions.clear, falling back to the
   * legacy clearCommand, then '/clear'. Large context notes are offloaded to a
   * temp file (same path as session_send_text).
   */
  async clearSession(
    sessionRef: string,
    options: { senderSessionId?: string; senderSessionName?: string; context?: string },
  ): Promise<{ ok: true; action: 'clear'; sessionId: string; contextRelayed: boolean; usedTempFile: boolean; note: string }> {
    const session = this.requireRunningSession(sessionRef);
    const entry = this.configLoader.getCliTypeEntry(session.cliType);
    // helmActions.clear is the modern mapping; clearCommand is the legacy fallback.
    const template = entry?.helmActions?.clear?.trim() || entry?.clearCommand?.trim() || DEFAULT_CLEAR_COMMAND;

    const by = options.senderSessionName ? ` by "${options.senderSessionName}"` : '';
    logger.info(`[HelmSessionDelivery] session_clear for "${session.name}" (${session.id})${by} using "${template}"`);
    await this.deliverActionSequence(session.id, template);

    // Give the CLI time to process the clear before relaying the note.
    await new Promise((resolve) => setTimeout(resolve, getClearSettleDelayMs()));

    const context = options.context?.trim();
    if (!context) {
      return { ok: true, action: 'clear', sessionId: session.id, contextRelayed: false, usedTempFile: false, note: ACTION_WAIT_NOTE };
    }

    const rawContext = options.context as string;
    const deliveryText = this.offloadIfLarge(
      session.cliType,
      rawContext,
      'session-clear-context',
      'session_clear context',
    );
    const usedTempFile = deliveryText !== rawContext;

    await deliverPromptSequenceToSession({
      sessionId: session.id,
      text: deliveryText,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      verifyDelivery: {
        label: 'session_clear context',
        delayMs: getDeliveryVerifyDelayMs(),
        retrySubmit: true,
      },
    });

    return { ok: true, action: 'clear', sessionId: session.id, contextRelayed: true, usedTempFile, note: ACTION_WAIT_NOTE };
  }

  /**
   * Compact a session's context via its configured helmActions.compact command.
   * $instruction is substituted with the caller's focus (empty if omitted).
   */
  async compactSession(
    sessionRef: string,
    options?: { instruction?: string; handover?: string },
  ): Promise<{ ok: true; action: 'compact'; sessionId: string; handoverPending: boolean; note: string }> {
    const session = this.requireRunningSession(sessionRef);
    const template = this.requireActionTemplate(session.cliType, 'compact');
    const sequence = substituteActionParams(template, { $instruction: options?.instruction?.trim() ?? '' });

    // Armed before the write, never after: the compact command's own output is
    // what drives the session back to `active`, and the delivery waits on the
    // *next* fall to silence. Arming late would miss that edge entirely.
    const handoverText = options?.handover?.trim();
    const handoverPending = Boolean(handoverText && this.handover);
    if (handoverText && this.handover) {
      this.handover.arm(
        session.id,
        this.offloadIfLarge(session.cliType, handoverText, 'session-compact-handover', 'session_compact handover'),
      );
    }

    logger.info(`[HelmSessionDelivery] session_compact for "${session.name}" (${session.id})`);
    await this.deliverActionSequence(session.id, sequence);

    return {
      ok: true,
      action: 'compact',
      sessionId: session.id,
      handoverPending,
      note: handoverPending
        ? `${ACTION_WAIT_NOTE} Your handover will be pasted back automatically once the session falls quiet.`
        : ACTION_WAIT_NOTE,
    };
  }

  /**
   * Swap oversized text for a pointer to a temp file holding it.
   *
   * A multi-thousand-character paste into a TUI composer is where delivery goes
   * wrong — partial writes, wrapped submits, mangled newlines. A one-line notice
   * always lands, and the CLI reads the file itself.
   */
  private offloadIfLarge(cliType: string, text: string, filePrefix: string, label: string): string {
    const enabled = this.configLoader.getCliTypeEntry(cliType)?.largeTextAsTempFile;
    if (!shouldSendLargeTextAsTempFile(enabled, text)) {
      return text;
    }
    const tempFilePath = writeLargeTextTempFile(text, filePrefix);
    logger.info(`[HelmSessionDelivery] Wrote large ${label} to temp file: ${tempFilePath}`);
    return buildLargeTextTempFileNotice(tempFilePath, label);
  }

  /**
   * Export a session's detail to a caller-supplied file path via its configured
   * helmActions.export command. $path is substituted; the path is echoed back so
   * the caller can read the file once the CLI finishes writing it.
   */
  async exportSession(
    sessionRef: string,
    options: { path: string },
  ): Promise<{ ok: true; action: 'export'; sessionId: string; path: string; note: string }> {
    const exportPath = options.path?.trim();
    if (!exportPath) {
      throw new Error('path is required for session_export');
    }
    const session = this.requireRunningSession(sessionRef);
    const template = this.requireActionTemplate(session.cliType, 'export');
    const sequence = substituteActionParams(template, { $path: exportPath });

    logger.info(`[HelmSessionDelivery] session_export for "${session.name}" (${session.id}) → ${exportPath}`);
    await this.deliverActionSequence(session.id, sequence);

    return {
      ok: true,
      action: 'export',
      sessionId: session.id,
      path: exportPath,
      note: `${ACTION_WAIT_NOTE} Then read the exported file at the returned path.`,
    };
  }

  /** Resolve a running session or throw a caller-friendly error. */
  private requireRunningSession(sessionRef: string): SessionInfo {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (!this.ptyManager.has(session.id)) {
      throw new Error(`Session PTY is not running: ${session.id}`);
    }
    return session;
  }

  /** Resolve the configured helmActions template for an action, or throw if unconfigured. */
  private requireActionTemplate(cliType: string, action: 'clear' | 'compact' | 'export'): string {
    const template = this.configLoader.getCliTypeEntry(cliType)?.helmActions?.[action]?.trim();
    if (!template) {
      throw new Error(
        `CLI type "${this.configLoader.getCliTypeLabel(cliType)}" has no "${action}" action configured. Set helmActions.${action} in its CLI config to enable session_${action}.`,
      );
    }
    return template;
  }

  /** Deliver an action sequence to a PTY with an implied submit ({NoSend} suppresses it). */
  private async deliverActionSequence(sessionId: string, sequence: string): Promise<void> {
    await deliverPromptSequenceToSession({
      sessionId,
      text: sequence,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      impliedSubmit: true,
    });
  }

  private findSession(sessionRef: string): SessionInfo | null {
    const nameMatches = this.sessionManager.getAllSessions().filter((session) => session.name === sessionRef);
    if (nameMatches.length > 1) {
      throw new Error(`Multiple sessions found with name: ${sessionRef}. Use sessionId instead.`);
    }
    // Names are user-facing handles, so resolve exact names before IDs to avoid
    // routing a handoff to an unrelated session when a ref could be interpreted both ways.
    if (nameMatches.length === 1) return nameMatches[0];
    return this.sessionManager.getSession(sessionRef);
  }
}
