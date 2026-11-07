/**
 * Unit tests for the bracketed-paste decision helpers.
 *
 * These are pure — they take the facts the caller already has (does the view
 * report the mode, is it on, is the text multiline) and return a decision, so
 * they need no terminal, no session state, and no mocks. The imperative
 * delivery path in paste-handler.ts consumes them.
 *
 * Regression origin: background delivery (inter-session MCP + remote chat) was
 * excluded from bracketed paste unconditionally, so a multi-line envelope went
 * in as raw PTY input. A TUI line editor reads each embedded newline as Enter,
 * submits line-by-line, and the recipient only ever sees the final fragment —
 * the "head of the message is lost, the tail arrives" bug.
 */

import { describe, it, expect } from 'vitest';
import { shouldWaitForBracketedPaste } from '../renderer/paste-handler.js';
// Framing is shared with the main-process fallback (PtyManager.deliverText),
// so it lives next to the other delivery constants rather than in the renderer.
import { buildPastePayload } from '../src/session/delivery-context.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('buildPastePayload', () => {
  it('wraps multiline text when the CLI has bracketed paste on', () => {
    expect(buildPastePayload('first\nsecond', true)).toBe(`${PASTE_START}first\nsecond${PASTE_END}`);
  });

  it('wraps single-line text too — the mode is on, framing stays consistent', () => {
    expect(buildPastePayload('hello', true)).toBe(`${PASTE_START}hello${PASTE_END}`);
  });

  it('leaves text raw when the CLI has NOT enabled bracketed paste', () => {
    // Wrapping a CLI that never enabled DEC 2004 would type the markers literally.
    expect(buildPastePayload('first\nsecond', false)).toBe('first\nsecond');
  });

  it('preserves the payload byte-for-byte inside the markers', () => {
    const envelope = '[HELM_MSG]\n{"a":1}\n\ntrailing';
    expect(buildPastePayload(envelope, true)).toBe(`${PASTE_START}${envelope}${PASTE_END}`);
  });
});

describe('shouldWaitForBracketedPaste', () => {
  it('waits for a multiline payload when the mode is readable but not yet on', () => {
    // Freshly spawned CLIs enable DEC 2004 a beat after their prompt appears.
    expect(shouldWaitForBracketedPaste({
      readsBracketed: true,
      bracketedPasteEnabled: false,
      isMultiline: true,
    })).toBe(true);
  });

  it('does not wait once the mode is already on', () => {
    expect(shouldWaitForBracketedPaste({
      readsBracketed: true,
      bracketedPasteEnabled: true,
      isMultiline: true,
    })).toBe(false);
  });

  it('does not wait for single-line text — no newline, nothing to mis-submit', () => {
    expect(shouldWaitForBracketedPaste({
      readsBracketed: true,
      bracketedPasteEnabled: false,
      isMultiline: false,
    })).toBe(false);
  });

  it('does not wait when the view cannot report the mode', () => {
    // A never-rendered session has no xterm view; polling would burn the budget
    // and still learn nothing.
    expect(shouldWaitForBracketedPaste({
      readsBracketed: false,
      bracketedPasteEnabled: false,
      isMultiline: true,
    })).toBe(false);
  });
});
