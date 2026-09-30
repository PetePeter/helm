/**
 * stripTranscript — a CLI's JSONL conversation log reduced to the markdown a
 * fresh session reads back on quick compact / CLI switch. Real fixtures in the
 * on-disk shapes Claude Code and Codex write.
 */

import { describe, it, expect } from 'vitest';
import { stripTranscript } from '../../src/session/transcript-strip.js';

const jsonl = (...records: unknown[]): string => records.map(r => JSON.stringify(r)).join('\n');

const ccUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', message: { role: 'user', content }, ...extra });
const ccAssistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });

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
