import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionContextSize } from '../../src/session/context-size.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-context-size-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: Array<Record<string, unknown>>): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n'));
  return path;
}

function claudeReply(tokens: number, timestamp: string): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [], usage: { input_tokens: tokens, output_tokens: 0 } },
  };
}

describe('resolveSessionContextSize', () => {
  it('uses Claude transcript tokens, the configured window, and the usage timestamp', () => {
    const path = transcript([claudeReply(100_000, '2026-10-10T09:30:00Z')]);

    expect(resolveSessionContextSize(
      { cliTranscriptPath: path },
      { contextWindow: 200_000 },
    )).toEqual({
      known: true,
      tokens: 100_000,
      window: 200_000,
      percent: 50,
      measuredAtIso: '2026-10-10T09:30:00.000Z',
      source: 'transcript',
    });
  });

  it('prefers Codex’s reported model window over the configured window', () => {
    const path = transcript([{
      type: 'event_msg',
      timestamp: '2026-10-10T09:31:00Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 125_000 }, model_context_window: 250_000 },
      },
    }]);

    expect(resolveSessionContextSize(
      { cliTranscriptPath: path },
      { contextWindow: 200_000 },
    )).toMatchObject({ known: true, tokens: 125_000, window: 250_000, percent: 50, source: 'transcript' });
  });

  it('distinguishes a missing transcript from a readable log without usage and never reports zero', () => {
    const emptyLog = transcript([{ type: 'user', message: { content: 'hello' } }]);
    const zeroLog = transcript([claudeReply(0, '2026-10-10T09:30:00Z')]);

    expect(resolveSessionContextSize({})).toEqual({ known: false, reason: 'no-transcript' });
    expect(resolveSessionContextSize({ cliTranscriptPath: emptyLog }))
      .toEqual({ known: false, reason: 'no-usage-yet' });
    expect(resolveSessionContextSize({ cliTranscriptPath: zeroLog }))
      .toEqual({ known: false, reason: 'no-usage-yet' });
  });

  it('uses a smaller usage record written after a compact', () => {
    const path = transcript([
      claudeReply(150_000, '2026-10-10T09:30:00Z'),
      claudeReply(45_000, '2026-10-10T09:45:00Z'),
    ]);

    expect(resolveSessionContextSize(
      { cliTranscriptPath: path },
      { contextWindow: 200_000 },
    )).toMatchObject({ known: true, tokens: 45_000, percent: 23, measuredAtIso: '2026-10-10T09:45:00.000Z' });
  });

  it('returns server-reported API usage and marks unsupported Copilot transcripts clearly', () => {
    const copilotLog = transcript([{ type: 'assistant', message: { content: 'done' } }]);

    expect(resolveSessionContextSize(
      { apiTool: true },
      { apiContext: { available: true, tokens: 321 }, contextWindow: 1_000 },
    )).toEqual({ known: true, tokens: 321, window: 1_000, percent: 32, source: 'api' });
    expect(resolveSessionContextSize(
      { cliTranscriptPath: copilotLog, provider: 'copilot' },
    )).toEqual({ known: false, reason: 'unsupported-cli' });
  });

  it('does not read a peer session transcript locally', () => {
    const path = transcript([claudeReply(80_000, '2026-10-10T09:30:00Z')]);

    expect(resolveSessionContextSize(
      { cliTranscriptPath: path, remote: { peerId: 'peer', sessionId: 'remote' } },
    )).toEqual({ known: false, reason: 'remote' });
  });
});
