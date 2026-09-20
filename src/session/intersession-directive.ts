/**
 * The inter-session directive text, in its two delivery forms.
 *
 * The SAME rules reach a session two ways:
 * - PREPENDED into the message (the path that works everywhere, and the only
 *   path for CLIs whose hooks are not installed or cannot inject on
 *   UserPromptSubmit — Copilot's command-hook output for that event is
 *   dropped entirely by the CLI).
 * - INJECTED out-of-band via the UserPromptSubmit hook as additionalContext
 *   (G4). The transcript stays clean; the rules ride along with the message
 *   they govern instead of filling it.
 *
 * The injected texts are STATIC: the hook sees the prompt but not the sender
 * beyond what the envelope carries, so reply instructions are written
 * generically ("the fromSessionId in the envelope"). The dynamic per-sender
 * builder stays for the prepend path.
 *
 * NONE of these strings may contain { or }: the prepended path travels
 * through the sequence parser, which rewrites unrecognised brace groups.
 */

import { isMobileSessionId } from '../mobile/mobile-identity.js';

/**
 * Directive prepended into every enveloped inter-session message.
 *
 * Why: the recipient is driven by another LLM — local or across the fleet — and
 * nobody is watching its terminal. An AskUserQuestion modal there blocks
 * forever, unseen. Questions must travel back over the same wire the work came
 * in on. Mirrors the guarantee Telegram mode already gives (relay-service.ts).
 */
export function buildHelmMsgDirective(senderSessionId: string): string {
  // A phone sender cannot read the recipient's terminal at all. Observed
  // 2026-09-17: without a hard channel rule, interim updates went to the
  // terminal only and the phone user had to ask for replies. Local and fleet
  // peers CAN tail the terminal, so their directive stays unchanged.
  const mobileChannelRule = isMobileSessionId(senderSessionId)
    ? 'The user reads ONLY chat_send: your terminal output is invisible to them. ' +
      'Reply to EVERY message from the phone with chat_send — ack, plan, result, or error, not just questions.\n'
    : '';
  return (
    '[HELM_MSG_RULES]\n' +
    mobileChannelRule +
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

/**
 * The injected (hook-path) form of the same rules. Sender-agnostic: the
 * envelope JSON in the message itself carries the fromSessionId, and the
 * expectsResponse tag carries the exact reply syntax when one is expected.
 */
export const HELM_MSG_HOOK_RULES =
  '[HELM_MSG_RULES]\n' +
  'This message came from another Helm session or the user on a paired phone — not from a human at this terminal.\n' +
  'Nobody can see or answer an interactive prompt here.\n' +
  'Do NOT use AskUserQuestion or any other blocking prompt.\n' +
  'If you need a decision, send it back over the same wire: for a session sender, session_send_text with ' +
  'sessionId="<the fromSessionId in the envelope>", senderSessionId=<your HELM_SESSION_ID>, expectsResponse=true; ' +
  'for a phone sender (address starts with mobile:), chat_send instead — the user reads ONLY chat_send, ' +
  'so reply to EVERY phone message with it, and keep lines short because they are read on a phone.\n' +
  'Then stand by for the reply. Do not guess and do not proceed on assumptions.\n' +
  'While standing by, call session_set_aiagent_state with state="planning" so the wait is visible on your session row.\n' +
  '[/HELM_MSG_RULES]';

/**
 * The injected form of the per-message Telegram instruction
 * (the trailing line of relay-service's wrapTelegramEnvelope).
 */
export const HELM_TELEGRAM_HOOK_RULES =
  '[HELM_TELEGRAM_RULES]\n' +
  'This message came from the user on Telegram. The user CANNOT see the terminal.\n' +
  'ALL responses and ALL questions MUST go through the telegram_chat MCP tool — do NOT use AskUserQuestion.\n' +
  '[/HELM_TELEGRAM_RULES]';

/**
 * The Telegram-mode block, announced once per entry into Telegram mode.
 * ONE source of truth: the relay prepends it (reminder `telegramModeInstructions`
 * resolving to pty) and the ContextInjector injects it out-of-band (hook).
 * The wording is shared verbatim by both paths — they say the same thing,
 * only the delivery differs.
 */
export const HELM_TELEGRAM_MODE_INSTRUCTIONS =
  '[HELM_TELEGRAM_MODE]\n' +
  'This session is now in Telegram mode. The user is interacting via Telegram and CANNOT see the terminal.\n' +
  'ALL responses MUST go through the telegram_chat MCP tool.\n' +
  'ALL questions and confirmations MUST go through telegram_chat — do NOT use AskUserQuestion.\n' +
  'The user will return to their desk when they type in the terminal, which automatically exits Telegram mode.\n' +
  '[/HELM_TELEGRAM_MODE]';
