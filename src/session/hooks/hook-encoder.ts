/**
 * HookEncoder — the G4 reply shapes for the non-deny decisions.
 *
 * (encodeDenyResponse for PreToolUse lives in hook-normaliser.ts; this module
 * holds the injection and stop-block shapes so the G4 decisions stay in one
 * place without touching a file the compaction group is editing.)
 *
 * SHAPES, verified 2026-09-19/20 against the CLIs' own docs:
 * - additionalContext: Claude and Codex require it nested under
 *   hookSpecificOutput with hookEventName — Claude Code SILENTLY IGNORES a
 *   top-level additionalContext. Copilot wants it flat at the top level and
 *   drops command-hook output for userPromptSubmitted entirely, so injection
 *   is a SessionStart-only capability there.
 * - stop block: all three read the same flat {decision:"block", reason} for
 *   their stop events (Claude Stop and PostToolUse use the TOP-LEVEL decision
 *   field — only PermissionRequest nests decision; Codex Stop
 *   "continue-with-new-prompt" is exactly this; Copilot agentStop likewise).
 *   `reason` becomes the next turn's prompt, so it must stand alone.
 */

import type { HookEvent } from './hook-normaliser.js';

/**
 * One reply carrying extra context for this turn. An empty text must never
 * be encoded — callers decide no-op before reaching here.
 */
export function encodeAdditionalContext(event: HookEvent, text: string): Record<string, unknown> {
  switch (event.cli) {
    case 'claude':
    case 'codex':
      return {
        hookSpecificOutput: {
          hookEventName: event.event,
          additionalContext: text,
        },
      };
    case 'copilot':
      return { additionalContext: text };
  }
}

/**
 * Block a Stop so the turn continues with `reason` as the new prompt.
 * The reason IS the feature: it is fed to the model as a user prompt.
 */
export function encodeStopBlock(_event: HookEvent, reason: string): Record<string, unknown> {
  return { decision: 'block', reason };
}
