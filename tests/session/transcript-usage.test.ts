import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptUsage } from '../../src/session/transcript-usage';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-transcript-usage-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: Array<Record<string, unknown> | string>): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

function claudeReply(usage: Record<string, number>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage }, ...extra };
}

function codexTokenCount(info: unknown): Record<string, unknown> {
  return { type: 'event_msg', payload: { type: 'token_count', info } };
}

describe('readTranscriptUsage', () => {
  it('sums a Claude reply\'s fresh, cached and output tokens into the context size', () => {
    const path = transcript([
      { type: 'user', message: { role: 'user', content: 'hi' } },
      claudeReply({ input_tokens: 2, cache_creation_input_tokens: 1462, cache_read_input_tokens: 59091, output_tokens: 1546 }),
    ]);
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 62101 });
  });

  it('reads Codex\'s last request size and the model window it reports', () => {
    const path = transcript([
      { type: 'session_meta', payload: {} },
      codexTokenCount({
        total_token_usage: { input_tokens: 3860865, output_tokens: 24075, total_tokens: 3884940 },
        last_token_usage: { input_tokens: 148620, cached_input_tokens: 147200, output_tokens: 79, total_tokens: 148699 },
        model_context_window: 258400,
      }),
    ]);
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 148699, contextWindow: 258400 });
  });

  it('takes the latest reply, not an earlier one', () => {
    const path = transcript([
      claudeReply({ input_tokens: 100, output_tokens: 10 }),
      { type: 'user', message: { role: 'user', content: 'more' } },
      claudeReply({ input_tokens: 5000, output_tokens: 50 }),
      { type: 'user', message: { role: 'user', content: 'tool result' } },
    ]);
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 5050 });
  });

  it('skips sub-agent replies and empty usage, which say nothing about the main context', () => {
    const path = transcript([
      claudeReply({ input_tokens: 4000, output_tokens: 40 }),
      claudeReply({ input_tokens: 900, output_tokens: 9 }, { isSidechain: true }),
      claudeReply({ input_tokens: 0, output_tokens: 0 }),
      codexTokenCount(null),
    ]);
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 4040 });
  });

  it('survives a torn final line by using the last complete record', () => {
    const path = transcript([
      claudeReply({ input_tokens: 700, output_tokens: 7 }),
      '{"type":"assistant","message":{"usage":{"input_tok',
    ]);
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 707 });
  });

  it('reads only the tail of a long log', () => {
    const path = transcript([
      claudeReply({ input_tokens: 111, output_tokens: 1 }),
      ...Array.from({ length: 200 }, () => ({ type: 'user', message: { role: 'user', content: 'x'.repeat(100) } })),
    ]);
    // The only usage sits well before the last 4 KB, so a bounded read cannot see it.
    expect(readTranscriptUsage(path, 4096)).toBeUndefined();
    expect(readTranscriptUsage(path)).toEqual({ contextTokens: 112 });
  });

  it('returns nothing for an unknown path, a missing file, or a log with no usage yet', () => {
    expect(readTranscriptUsage(undefined)).toBeUndefined();
    expect(readTranscriptUsage(join(dir, 'absent.jsonl'))).toBeUndefined();
    expect(readTranscriptUsage(transcript([{ type: 'user', message: { role: 'user', content: 'hi' } }]))).toBeUndefined();
  });
});
