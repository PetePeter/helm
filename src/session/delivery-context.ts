import type { WriteIntent } from './pty-manager.js';

export type DeliveryContext = 'background' | 'interactive';
export type InputOrigin = 'user' | 'programmatic';

export interface PtyWriteOptions {
  inputOrigin?: InputOrigin;
}

export interface TextDeliveryOptions {
  withReturn?: boolean;
  submitSuffix?: string;
  deliveryContext?: DeliveryContext;
  /** How the write should affect activity tracking. */
  writeIntent?: WriteIntent;
}

/**
 * Pause between the text write and the submit suffix.
 *
 * Ink-based full-screen TUIs (Copilot CLI) ingest a paste asynchronously and
 * only honour Enter once they have re-rendered their composer. An Enter that
 * lands mid-paste is swallowed and the text sits unsent on the prompt. Shared
 * by the main-process sequence delivery and the renderer paste path so both
 * halves of the pipeline settle for the same beat.
 */
export const SUBMIT_SETTLE_DELAY_MS = 400;

/**
 * How long to wait for a CLI to turn bracketed paste on before delivering
 * multi-line text to it.
 *
 * A freshly spawned CLI enables DEC 2004 a beat AFTER its prompt first appears.
 * Text delivered inside that window is written unframed, so a line editor reads
 * each embedded newline as Enter and submits line-by-line — leaving the
 * recipient only the final fragment. Shared by the renderer paste path (polling
 * xterm) and the main-process delivery (polling BracketedPasteTracker) so the
 * two halves cannot drift to different budgets.
 */
export const BRACKETED_PASTE_READY_BUDGET_MS = 1500;
export const BRACKETED_PASTE_POLL_MS = 40;

/**
 * How quiet a session's output must fall before a rename command is pasted
 * into it — and how long to keep waiting for that silence.
 *
 * A SessionStart hook reply re-renders a full-screen TUI mid-write; a paste
 * landing across the redraw is split and its tail goes out as a stray user
 * message. Waiting for a quiet window lands the paste on a settled screen.
 * The budget bounds the wait for a CLI that never stops talking: pasting
 * anyway beats dropping the rename, so exhaustion fails OPEN.
 */
export const RENAME_QUIET_WINDOW_MS = 400;
export const RENAME_QUIET_BUDGET_MS = 8_000;
export const RENAME_QUIET_POLL_MS = 100;

/**
 * Frame text in DEC 2004 markers when the CLI has bracketed paste enabled, so
 * the whole block lands in the composer as one paste. Without the framing a
 * line editor reads each embedded newline as Enter and submits line-by-line,
 * leaving the recipient only the final fragment.
 *
 * Never frame when the mode is off — the markers would be typed out literally,
 * and for a line-oriented shell like cmd.exe line-by-line IS the wanted
 * behaviour. Shared by the renderer paste path (mode read off xterm) and the
 * main-process fallback (mode read off BracketedPasteTracker) so both halves
 * make the same decision.
 */
export function buildPastePayload(text: string, bracketedPasteEnabled: boolean): string {
  return bracketedPasteEnabled ? `\x1b[200~${text}\x1b[201~` : text;
}

