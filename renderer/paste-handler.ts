/**
 * Text delivery to a session's PTY — the one way bulk text reaches a CLI.
 *
 * Serves the user's Ctrl+V, the prompt editor, gamepad bindings, sequence
 * delivery and inter-session messages. Text is written to PTY stdin, framed in
 * DEC 2004 markers when the CLI has bracketed paste on, with the submit suffix
 * as a separate later write.
 *
 * Deciding WHICH keys get here is not this module's job — see
 * `keyboard/router.ts` and `keyboard/handlers/terminal-keys.ts`. This file used
 * to own a capture-phase `document` listener as well, which is how a stale
 * planner check in the middle of it could silently kill Escape and Ctrl+G.
 */

import { keyToPtyEscape } from './bindings.js';
import { parseSequence } from '../src/input/sequence-parser.js';
import { getTerminalManager } from './runtime/terminal-provider.js';
import { state } from './state.js';
import { resolveCliTypeRecord } from './utils.js';
import { keyboardClient, terminalClient } from './ipc/clients.js';
import {
  buildPastePayload,
  BRACKETED_PASTE_POLL_MS,
  BRACKETED_PASTE_READY_BUDGET_MS,
  SUBMIT_SETTLE_DELAY_MS,
  type DeliveryContext,
  type PtyWriteOptions,
} from '../src/session/delivery-context.js';

/**
 * Convert escape notation strings to actual characters.
 * Supports: \r (CR), \n (LF), \t (TAB), \r\n (CRLF), or full sequence syntax like {Enter}, {F1}, {Ctrl+C}, etc.
 * @param suffix - Undefined, empty string, escape notation like '\r', '\n', or sequence like {Enter}, {Send}
 * @returns Actual CR/LF/TAB characters, PTY escape sequences, or default '\r' if undefined/empty
 */
export function parseSubmitSuffix(suffix?: string): string {
  if (!suffix) return '\r';

  if (suffix === '\\r') return '\r';
  if (suffix === '\\n') return '\n';
  if (suffix === '\\t') return '\t';
  if (suffix === '\\r\\n') return '\r\n';

  if (suffix.includes('{')) {
    const actions = parseSequence(suffix);
    let result = '';

    for (const action of actions) {
      if (action.type === 'text') {
        result += action.value;
      } else if (action.type === 'key') {
        result += action.key === 'Enter' || action.key === 'Send'
          ? keyToPtyEscape('enter')
          : keyToPtyEscape(action.key);
      } else if (action.type === 'combo') {
        if (action.keys.length === 2 && action.keys[0].toLowerCase() === 'ctrl') {
          const k = action.keys[1].toUpperCase();
          if (k.length === 1 && k >= 'A' && k <= 'Z') {
            result += String.fromCharCode(k.charCodeAt(0) - 64);
          }
        }
      }
    }

    return result || suffix;
  }

  return suffix;
}

let clipboardPasteInFlight = false;

interface BracketedPasteReadable {
  isBracketedPasteEnabled: () => boolean;
}

/**
 * Whether to spend the readiness budget waiting for the CLI to turn bracketed
 * paste on before delivering.
 *
 * Only worth waiting when the payload has newlines to protect and the view can
 * actually report the mode — polling a session with no xterm view learns
 * nothing. Deliberately independent of delivery context: a programmatic send
 * needs the newline protection just as much as a typed one.
 */
export function shouldWaitForBracketedPaste(input: {
  readsBracketed: boolean;
  bracketedPasteEnabled: boolean;
  isMultiline: boolean;
}): boolean {
  return input.readsBracketed && !input.bracketedPasteEnabled && input.isMultiline;
}

async function waitForBracketedPasteReady(view: BracketedPasteReadable, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (view.isBracketedPasteEnabled()) return true;
    await new Promise(resolve => setTimeout(resolve, BRACKETED_PASTE_POLL_MS));
  }
  return view.isBracketedPasteEnabled();
}

function getConfiguredSubmitSuffix(sessionId: string, withReturn?: boolean, override?: string): string {
  if (override !== undefined) return override;
  if (!withReturn) return '';
  const session = state.sessions.find(s => s.id === sessionId);
  const configured = session ? resolveCliTypeRecord(session.cliType)?.submitSuffix : undefined;
  return configured ? parseSubmitSuffix(configured) : '\r';
}

function getPtyWriteOptions(deliveryContext: DeliveryContext): PtyWriteOptions | undefined {
  return deliveryContext === 'background' ? { inputOrigin: 'programmatic' } : undefined;
}

async function writePty(sessionId: string, data: string, options?: PtyWriteOptions): Promise<void> {
  if (options) {
    await terminalClient.ptyWrite(sessionId, data, options);
  } else {
    await terminalClient.ptyWrite(sessionId, data);
  }
}

async function writePtySubmitSuffix(sessionId: string, suffix: string, options?: PtyWriteOptions): Promise<void> {
  if (!suffix) return;
  await writePty(sessionId, suffix, options);
}

/**
 * Pause between the delivered text and its submit suffix.
 *
 * Full-screen TUIs ingest a paste asynchronously; an Enter that lands before the
 * composer has re-rendered is swallowed and the text sits unsent on the prompt.
 * Only used where text was just written — a submit-only delivery sends at once.
 */
async function settleBeforeSubmit(suffix: string): Promise<void> {
  if (!suffix) return;
  await new Promise(resolve => setTimeout(resolve, SUBMIT_SETTLE_DELAY_MS));
}

/**
 * Put text on the clipboard and press Ctrl+V at the OS level.
 *
 * Not a delivery mode — this is how the user's own paste reaches a terminal that
 * does not hold DOM focus. See deliverViaClipboardPaste.
 */
async function simulateClipboardPaste(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  await keyboardClient.keyboardSendKeyCombo(['ctrl', 'v']);
}

export async function deliverViaClipboardPaste(text: string): Promise<void> {
  if (!text || clipboardPasteInFlight) return;
  clipboardPasteInFlight = true;
  try {
    await simulateClipboardPaste(text);
    console.log(`[Paste] clipboard+Ctrl+V sent: ${text.length} chars`);
  } catch (err) {
    console.error('[Paste] clipboard paste failed:', err);
  } finally {
    clipboardPasteInFlight = false;
  }
}

/**
 * Deliver bulk text from the renderer to a session's PTY — the user's Ctrl+V,
 * the prompt editor, gamepad bindings and sequence delivery.
 *
 * Text is written to PTY stdin, framed in DEC 2004 markers when the CLI has
 * bracketed paste on, with the submit suffix as a separate later write. There is
 * one way to deliver text; the four alternative paste modes were removed once it
 * became clear nothing configured them and each was a slower, focus-sensitive
 * path to the same PTY.
 */
export async function deliverBulkText(sessionId: string, text: string, options?: { withReturn?: boolean; submitSuffix?: string; deliveryContext?: DeliveryContext }): Promise<void> {
  const session = state.sessions.find(s => s.id === sessionId);
  const suffix = getConfiguredSubmitSuffix(sessionId, options?.withReturn, options?.submitSuffix);
  const deliveryContext = options?.deliveryContext ?? 'interactive';
  const ptyWriteOptions = getPtyWriteOptions(deliveryContext);

  // Submit-only: no text but submitSuffix present.
  if (!text && suffix) {
    await writePtySubmitSuffix(sessionId, suffix, ptyWriteOptions);
    return;
  }

  if (!text) return;

  console.log(`[Paste] cliType=${session?.cliType} chars=${text.length}`);

  const tm = getTerminalManager();
  const view = tm?.getSession?.(sessionId)?.view;
  const readsBracketed = typeof view?.isBracketedPasteEnabled === 'function';
  let bracketedPasteEnabled = readsBracketed ? view!.isBracketedPasteEnabled() : false;

  // Multi-line delivery into a session that hasn't enabled bracketed paste yet
  // (typically just-spawned) — wait briefly for it so the whole block is wrapped
  // instead of submitted line-by-line. Background delivery needs this as much as
  // interactive: inter-session and Telegram envelopes are multi-line, and an
  // unwrapped one is submitted a line at a time, so only its last fragment
  // survives as the recipient's prompt.
  if (shouldWaitForBracketedPaste({ readsBracketed, bracketedPasteEnabled, isMultiline: text.includes('\n') })) {
    bracketedPasteEnabled = await waitForBracketedPasteReady(view!, BRACKETED_PASTE_READY_BUDGET_MS);
  }

  await writePty(sessionId, buildPastePayload(text, bracketedPasteEnabled), ptyWriteOptions);
  await settleBeforeSubmit(suffix);
  await writePtySubmitSuffix(sessionId, suffix, ptyWriteOptions);
}
