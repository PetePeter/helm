/**
 * HookEncoder — the wire shapes for injection and stop-block replies.
 *
 * Each fixture is the exact shape the target CLI's docs specify. The trap
 * under test: Claude Code silently ignores a TOP-LEVEL additionalContext —
 * it must nest under hookSpecificOutput with the event name.
 */

import { describe, expect, it } from 'vitest';
import { encodeAdditionalContext, encodeStopBlock } from '../../../src/session/hooks/hook-encoder';
import { normaliseHookEvent } from '../../../src/session/hooks/hook-normaliser';
import type { HookEvent } from '../../../src/session/hooks/hook-normaliser';

function event(cli: string, event: string): HookEvent {
  const normalised = normaliseHookEvent({ cli, event, payload: {} });
  if (!normalised) throw new Error(`fixture not normalisable: ${cli}/${event}`);
  return { ...normalised, helmSessionId: 's1', receivedAt: 1 };
}

describe('encodeAdditionalContext', () => {
  it('nests under hookSpecificOutput for Claude — top level is silently ignored', () => {
    expect(encodeAdditionalContext(event('claude', 'UserPromptSubmit'), 'the rules')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'the rules',
      },
    });
  });

  it('same nesting for Codex SessionStart', () => {
    expect(encodeAdditionalContext(event('codex', 'SessionStart'), 'resume context')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'resume context',
      },
    });
  });

  it('flat at the top level for Copilot', () => {
    expect(encodeAdditionalContext(event('copilot', 'sessionStart'), 'resume context')).toEqual({
      additionalContext: 'resume context',
    });
  });
});

describe('encodeStopBlock', () => {
  // One shape for all three stop events: the docs put the decision at the
  // top level for Claude's Stop (only PermissionRequest nests it), and Codex
  // and Copilot specify exactly this form for their continue-with-reason.
  for (const cli of ['claude', 'codex', 'copilot']) {
    it(`is the flat decision/block form for ${cli}`, () => {
      expect(encodeStopBlock(event(cli, 'Stop'), 'finish the claimed plan first')).toEqual({
        decision: 'block',
        reason: 'finish the claimed plan first',
      });
    });
  }
});
