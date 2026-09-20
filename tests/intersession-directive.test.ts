/**
 * The inter-session directive text — one module, two delivery forms.
 *
 * The prepended form (per sender) and the injected form (static) must carry
 * the same guarantees: no interactive prompts, reply over the same wire,
 * visible standby state. Neither form may contain braces — the prepended path
 * travels through the sequence parser, which rewrites unrecognised groups.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHelmMsgDirective,
  HELM_MSG_HOOK_RULES,
  HELM_TELEGRAM_HOOK_RULES,
} from '../src/session/intersession-directive';

describe('buildHelmMsgDirective (prepended form)', () => {
  it('routes replies back to a session sender with session_send_text', () => {
    const directive = buildHelmMsgDirective('sender-1');
    expect(directive).toContain('[HELM_MSG_RULES]');
    expect(directive).toContain('session_send_text sessionId="sender-1"');
    expect(directive).toContain('Do NOT use AskUserQuestion');
    expect(directive).toContain('session_set_aiagent_state');
  });

  it('adds the chat_send-only rule for a phone sender', () => {
    const directive = buildHelmMsgDirective('mobile:device-7');
    expect(directive).toContain('The user reads ONLY chat_send');
    expect(directive).toContain('Reply to EVERY message from the phone');
    expect(directive).not.toContain('session_send_text sessionId=');
  });
});

describe('injected forms', () => {
  it('HELM_MSG_HOOK_RULES covers both reply routes without knowing the sender', () => {
    expect(HELM_MSG_HOOK_RULES).toContain('fromSessionId in the envelope');
    expect(HELM_MSG_HOOK_RULES).toContain('session_send_text');
    expect(HELM_MSG_HOOK_RULES).toContain('chat_send');
    expect(HELM_MSG_HOOK_RULES).toContain('Do NOT use AskUserQuestion');
    expect(HELM_MSG_HOOK_RULES).toContain('session_set_aiagent_state');
  });

  it('HELM_TELEGRAM_HOOK_RULES routes everything through telegram_chat', () => {
    expect(HELM_TELEGRAM_HOOK_RULES).toContain('telegram_chat');
    expect(HELM_TELEGRAM_HOOK_RULES).toContain('CANNOT see the terminal');
    expect(HELM_TELEGRAM_HOOK_RULES).toContain('do NOT use AskUserQuestion');
  });

  it('every form is brace-free — the sequence parser would rewrite them', () => {
    for (const text of [buildHelmMsgDirective('s'), buildHelmMsgDirective('mobile:d'), HELM_MSG_HOOK_RULES, HELM_TELEGRAM_HOOK_RULES]) {
      expect(text).not.toContain('{');
      expect(text).not.toContain('}');
    }
  });
});
