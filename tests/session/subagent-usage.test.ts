import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubagentContexts } from '../../src/session/subagent-usage.js';

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const dir = () => mkdtempSync(join(tmpdir(), 'helm-subagent-'));

describe('readSubagentContexts', () => {
  it("reads each Claude sub-agent file's latest reply context", () => {
    const root = dir();
    const main = join(root, 'sess-1.jsonl');
    writeFileSync(main, jsonl([{ type: 'assistant', message: { usage: { input_tokens: 9_000, output_tokens: 1 } } }]));
    mkdirSync(join(root, 'sess-1', 'subagents'), { recursive: true });
    const reply = (input: number, output: number) =>
      ({ isSidechain: true, agentId: 'ab2f', type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: input, output_tokens: output } } });
    writeFileSync(join(root, 'sess-1', 'subagents', 'agent-ab2f.jsonl'), jsonl([
      { isSidechain: true, type: 'user', message: { role: 'user', content: 'go' } },
      reply(10_000, 50),
      reply(30_000, 100),
    ]));

    expect(readSubagentContexts(main)).toEqual(new Map([['agent-ab2f.jsonl', 30_102]]));
  });

  it("reads Codex child rollouts by parent_thread_id, not other sessions' rollouts", () => {
    const day = dir();
    const mainId = '01a13aa9-6827-7b80-a976-e8ea05a041ed';
    const main = join(day, `rollout-2026-10-15T00-45-43-${mainId}.jsonl`);
    writeFileSync(main, jsonl([{ type: 'session_meta', payload: { id: mainId } }]));
    const tokenCount = (total: number) =>
      ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
    const child = 'rollout-2026-10-15T00-58-11-01a13ab4-d1bd-73b2-a38b-7b1a8b678186.jsonl';
    writeFileSync(join(day, child), jsonl([
      { type: 'session_meta', payload: { id: '01a13ab4-d1bd-73b2-a38b-7b1a8b678186', parent_thread_id: mainId, source: { subagent: { thread_spawn: { parent_thread_id: mainId } } } } },
      tokenCount(12_000),
      tokenCount(48_000),
    ]));
    writeFileSync(join(day, 'rollout-2026-10-15T01-00-00-01a13ab9-0000-7000-8000-000000000000.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: '01a13ab9-0000-7000-8000-000000000000', parent_thread_id: 'someone-else' } },
      tokenCount(99_000),
    ]));

    expect(readSubagentContexts(main)).toEqual(new Map([[child, 48_000]]));
  });

  it('reads the latest Copilot usage record per sub-agent from the main event log', () => {
    const main = join(dir(), 'events.jsonl');
    const record = (input: number, output: number, agentId?: string) => ({
      type: 'session.usage_record',
      ...(agentId ? { agentId } : {}),
      data: { usage: { inputTokens: input, outputTokens: output, maxPromptTokens: 272_000, interactionType: agentId ? 'conversation-subagent' : 'conversation-agent' } },
    });
    writeFileSync(main, jsonl([
      record(40_000, 100),
      record(29_211, 296, 'dc127fa9'),
      record(31_000, 400, 'dc127fa9'),
      record(5_000, 10, 'f4da0e31'),
      record(41_000, 100),
    ]));

    expect(readSubagentContexts(main)).toEqual(new Map([['dc127fa9', 31_400], ['f4da0e31', 5_010]]));
  });

  it('finds nothing for a session that spawned no sub-agents', () => {
    const main = join(dir(), 'sess-2.jsonl');
    writeFileSync(main, jsonl([{ type: 'assistant', message: { usage: { input_tokens: 9_000 } } }]));
    expect(readSubagentContexts(main).size).toBe(0);
    expect(readSubagentContexts(undefined).size).toBe(0);
  });
});
