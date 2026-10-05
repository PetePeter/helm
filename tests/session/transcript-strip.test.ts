/**
 * stripTranscript — a CLI's JSONL conversation log reduced to the markdown a
 * fresh session reads back on quick compact / CLI switch. Real fixtures in the
 * on-disk shapes Claude Code, Codex and Copilot CLI write.
 */

import { describe, it, expect } from 'vitest';
import { buildTranscriptResumePrompt, stripTranscript } from '../../src/session/transcript-strip.js';
import { KEEP_WARM_PROMPT, HEARTBEAT_OPEN, HEARTBEAT_CLOSE } from '../../src/session/keep-warmer.js';

const jsonl = (...records: unknown[]): string => records.map(r => JSON.stringify(r)).join('\n');

const ccUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', message: { role: 'user', content }, ...extra });
const ccAssistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });

describe('buildTranscriptResumePrompt', () => {
  it('keeps a one-shot handover distinct from persistent manifesto context', () => {
    const prompt = buildTranscriptResumePrompt('history.md', 'preserve these ids', 'Persistent manifesto context\n\n## Rules');
    expect(prompt).toContain('Handover note: preserve these ids');
    expect(prompt).toContain('Persistent manifesto context');
    expect(prompt.indexOf('Handover note: preserve these ids')).toBeLessThan(prompt.indexOf('Persistent manifesto context'));
  });
});

describe('stripTranscript — Claude Code', () => {
  it('keeps prompts and prose, reduces tool calls to one line and drops thinking and tool output', () => {
    const md = stripTranscript(jsonl(
      ccUser('Fix the login bug'),
      ccAssistant([
        { type: 'thinking', thinking: 'secret chain of thought' },
        { type: 'text', text: 'Looking at auth.ts' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/auth.ts' } },
      ]),
      ccUser([{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }]),
      ccAssistant([{ type: 'text', text: 'Fixed.' }]),
    ));

    expect(md).toContain('Fix the login bug');
    expect(md).toContain('Looking at auth.ts');
    expect(md).toContain('Read {"file_path":"src/auth.ts"}');
    expect(md).toContain('Fixed.');
    expect(md).not.toContain('secret chain of thought');
    expect(md).not.toContain('xxxxxxxxxx');
  });

  it('keeps failed tool results as a short error line', () => {
    const md = stripTranscript(jsonl(
      ccUser('run tests'),
      ccUser([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file' }]),
    ));
    expect(md).toContain('ENOENT: no such file');
  });

  it('starts from the last compaction and keeps its summary', () => {
    const md = stripTranscript(jsonl(
      ccUser('ancient prompt'),
      { type: 'system', subtype: 'compact_boundary' },
      ccUser('This session is being continued. Summary: we fixed auth', { isCompactSummary: true }),
      ccUser('next task'),
    ));
    expect(md).not.toContain('ancient prompt');
    expect(md).toContain('we fixed auth');
    expect(md).toContain('next task');
  });

  it('drops meta records, command caveats and injected system reminders', () => {
    const md = stripTranscript(jsonl(
      ccUser('meta noise', { isMeta: true }),
      ccUser('<local-command-caveat>Caveat</local-command-caveat>'),
      ccUser('real ask<system-reminder>hook chatter</system-reminder>'),
    ));
    expect(md).toContain('real ask');
    expect(md).not.toContain('meta noise');
    expect(md).not.toContain('Caveat');
    expect(md).not.toContain('hook chatter');
  });

  it('skips malformed lines instead of failing', () => {
    expect(stripTranscript(`not json\n${JSON.stringify(ccUser('ok'))}`)).toContain('ok');
  });
});

describe('stripTranscript — Codex', () => {
  const item = (payload: unknown) => ({ type: 'response_item', payload });

  it('keeps messages and one-line calls, drops reasoning, call output and injected context', () => {
    const md = stripTranscript(jsonl(
      { type: 'session_meta', payload: { id: 'thread' } },
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
      item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev rules' }] }),
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a test' }] }),
      item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] }),
      item({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' }),
      item({ type: 'function_call_output', call_id: 'c1', output: 'huge listing' }),
      item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Test added.' }] }),
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Test added.' } },
    ));

    expect(md).toContain('Add a test');
    expect(md).toContain('shell {"command":["ls"]}');
    expect(md.match(/Test added\./g)).toHaveLength(1);
    expect(md).not.toContain('private reasoning');
    expect(md).not.toContain('huge listing');
    expect(md).not.toContain('environment_context');
    expect(md).not.toContain('dev rules');
  });
});

const cp = (type: string, data: Record<string, unknown>) => ({ type, data });

describe('stripTranscript — Copilot CLI', () => {
  it('keeps prompts, replies, one line per tool call and failures; drops tool output and injected context', () => {
    const md = stripTranscript(jsonl(
      cp('session.start', { sessionId: 's1', producer: 'copilot-agent' }),
      cp('system.message', { role: 'system', content: 'You are the GitHub Copilot CLI' }),
      cp('user.message', { content: 'Fix the login bug', transformedContent: '<current_datetime>x</current_datetime> injected' }),
      cp('assistant.message', {
        content: 'Looking at auth.ts',
        reasoningOpaque: 'opaque-thinking',
        toolRequests: [{ toolCallId: 't1', name: 'view', arguments: { path: 'src/auth.ts' } }],
      }),
      cp('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'x'.repeat(5000) } }),
      cp('tool.execution_complete', { toolCallId: 't2', success: false, error: { message: 'rg: unrecognized file type' } }),
      cp('assistant.message', { content: 'Fixed.', toolRequests: [] }),
    ));

    expect(md).toContain('Fix the login bug');
    expect(md).toContain('Looking at auth.ts');
    expect(md).toContain('- tool: view {"path":"src/auth.ts"}');
    expect(md).toContain('- error: rg: unrecognized file type');
    expect(md).toContain('Fixed.');
    expect(md).not.toContain('xxxxxxxxxx');
    expect(md).not.toContain('opaque-thinking');
    expect(md).not.toContain('current_datetime');
    expect(md).not.toContain('GitHub Copilot CLI');
  });

  it('starts from the last compaction, keeping its summary', () => {
    const md = stripTranscript(jsonl(
      cp('session.start', { sessionId: 's1' }),
      cp('user.message', { content: 'ancient prompt' }),
      cp('session.compaction_complete', { success: true, summaryContent: 'the story so far' }),
      cp('user.message', { content: 'fresh prompt' }),
    ));

    expect(md).toContain('the story so far');
    expect(md).toContain('fresh prompt');
    expect(md).not.toContain('ancient prompt');
  });

  it('drops sub-agent chatter, keeping only the parent conversation', () => {
    const md = stripTranscript(jsonl(
      cp('session.start', { sessionId: 's1' }),
      cp('assistant.message', { content: 'inner reply', parentToolCallId: 'task-1', toolRequests: [] }),
      cp('tool.execution_complete', { parentToolCallId: 'task-1', toolCallId: 'x', success: false, error: { message: 'inner failure' } }),
      cp('assistant.message', { content: 'outer reply', toolRequests: [] }),
    ));

    expect(md).toContain('outer reply');
    expect(md).not.toContain('inner reply');
    expect(md).not.toContain('inner failure');
  });
});

/**
 * Helm plumbing baked into the log (envelopes, reply directives, hook context,
 * temp-file pointers) names the OLD session's ids. A successor that reads it
 * back replies to a dead id — so it goes, and only the human text stays.
 */
describe('stripTranscript — Helm plumbing', () => {
  const envelope = (from: string) =>
    `[HELM_MSG]{"type":"inter_llm_message","fromSessionId":"${from}","fromSessionName":"x","expectsResponse":false,"timestamp":"2026-09-30T09:20:20.025Z"}`;
  const strip = (...texts: string[]) => stripTranscript(jsonl(...texts.map(t => ccUser(t))));

  it('drops the [HELM_MSG] envelope and keeps the message body', () => {
    const md = strip(`${envelope('mobile:7a11')}session ids were stuffed`);
    expect(md).toContain('session ids were stuffed');
    expect(md).not.toMatch(/HELM_MSG|inter_llm_message|mobile:7a11/);
  });

  it('drops the expectsResponse reply directive and its old session id', () => {
    const md = strip(
      '[HELM_MSG: expectsResponse=true. To reply, call MCP tool mcp__helm__session_send_text with: ' +
        'sessionId="55e502aa", senderSessionId=<your env $HELM_SESSION_ID>, text="<your reply>". Your HELM_SESSION_ID is injected by Helm at startup.]' +
        '{"type":"inter_llm_message","fromSessionId":"55e502aa","fromSessionName":"Helm","expectsResponse":true,"timestamp":"t"}check P-0885',
    );
    expect(md).toContain('check P-0885');
    expect(md).not.toMatch(/55e502aa|HELM_SESSION_ID|expectsResponse/);
  });

  it('drops injected rules and mode blocks whole', () => {
    const md = strip('[HELM_MSG_RULES]\nDo NOT use AskUserQuestion\n[/HELM_MSG_RULES]\n[HELM_TELEGRAM_MODE]\nuse telegram_chat\n[/HELM_TELEGRAM_MODE]\nreal prompt');
    expect(md).toContain('real prompt');
    expect(md).not.toMatch(/AskUserQuestion|telegram_chat|HELM_/);
  });

  it('unwraps a Telegram envelope to its body', () => {
    const md = strip('[HELM_TELEGRAM from:oscar chat:-100123]\nship it\n[/HELM_TELEGRAM]');
    expect(md).toContain('ship it');
    expect(md).not.toMatch(/HELM_TELEGRAM|-100123/);
  });

  it('drops hook-injected context lines and Stop-hook feedback, keeping the real prompt', () => {
    const md = strip(
      'fix the strip\nUserPromptSubmit hook additional context: DRY, YAGNI\n' +
        '[HELM_MISSION] No mission set. Call session_mission_set\n' +
        '[HELM_MESS] joining — 90 earlier messages, optional — call mess_check\n' +
        'possibly related: memory/abc (Some memory)\n' +
        'Startable plan here: P-0837 "Voice" — claim it with session_plan_claim if you want the work.',
      'Stop hook feedback:\nYour AIAGENT state is unset — call session_set_aiagent_state',
      'Stop hook blocking error from command: "python shim.py claude Stop": Your AIAGENT state is unset',
    );
    expect(md).toContain('fix the strip');
    expect(md).not.toMatch(/hook|HELM_|possibly related|Startable plan|AIAGENT/);
  });

  it('drops large-text temp-file pointers', () => {
    const md = strip(
      `${envelope('mobile:7a11')}A large session_send_text payload was written to a Helm temp file.\n` +
        'Read the full file at: C:\tmp\helm-large-text-1.md\nDelete the temp file after processing.',
    );
    expect(md).not.toMatch(/temp file|helm-large-text/);
  });

  it('drops a message that was nothing but plumbing, leaving no empty section', () => {
    const md = strip('[HELM_MSG_RULES]\nrules\n[/HELM_MSG_RULES]');
    expect(md).not.toContain('## User');
  });

  it('drops a bounded keep-warm heartbeat whole, keeping the prompt before and after', () => {
    const md = strip(
      'fix the strip',
      `${HEARTBEAT_OPEN} heartbeat. brief housekeeping note ${HEARTBEAT_CLOSE}`,
      'keep working on the strip',
    );
    expect(md).toContain('fix the strip');
    expect(md).toContain('keep working on the strip');
    expect(md).not.toMatch(/HEARTBEAT|housekeeping/);
  });

  it('drops a keep-warm ping that only carries the default marker, e.g. a custom keepWarmPrompt', () => {
    const md = strip(`${HEARTBEAT_OPEN} poke: check my workers [ping]`);
    expect(md).not.toMatch(/HEARTBEAT|poke|ping/);
    expect(md).not.toContain('## User');
  });

  it('leaves ordinary bracketed text alone', () => {
    const md = strip('see [docs] and [HELM docs] and {"type":"x"}');
    expect(md).toContain('see [docs] and [HELM docs] and {"type":"x"}');
  });

  it('applies to Codex and Copilot logs too', () => {
    const codex = stripTranscript(jsonl(
      { type: 'session_meta', payload: {} },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${envelope('old-id')}codex body` }] } },
    ));
    const copilot = stripTranscript(jsonl(cp('session.start', {}), cp('user.message', { content: `${envelope('old-id')}copilot body` })));
    expect(codex).toContain('codex body');
    expect(copilot).toContain('copilot body');
    expect(codex + copilot).not.toContain('old-id');
  });

  it('drops default keep-warm heartbeats from every CLI format', () => {
    const claude = stripTranscript(jsonl(ccUser(KEEP_WARM_PROMPT), ccAssistant('real reply')));
    const codex = stripTranscript(jsonl(
      { type: 'session_meta', payload: {} },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: KEEP_WARM_PROMPT }] } },
    ));
    const copilot = stripTranscript(jsonl(cp('session.start', {}), cp('user.message', { content: KEEP_WARM_PROMPT })));

    expect(claude).toContain('real reply');
    expect(claude).not.toContain('heartbeat');
    expect(codex).not.toContain('heartbeat');
    expect(copilot).not.toContain('heartbeat');
    expect(claude).not.toContain('Quick Compact');
    expect(codex).not.toContain('Quick Compact');
    expect(copilot).not.toContain('Quick Compact');
  });
});
