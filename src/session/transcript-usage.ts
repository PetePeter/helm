/**
 * Read how full a CLI's context is from the JSONL log the CLI itself writes.
 *
 * Why the log: Helm hosts an API tool's loop and sees the server's `usage`
 * first-hand, but a CLI in a PTY reports nothing. Its transcript does — Claude
 * stamps `usage` on every reply and Codex emits a `token_count` event — so the
 * same badge can be filled without asking the CLI anything.
 *
 * Copilot is absent on purpose: it writes its context size only at
 * `session.shutdown`, so mid-session the number would be a previous run's.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ChatTurnUsage } from './chat/chat-bridge.js';

type Json = Record<string, unknown>;

/** Enough to hold the last reply even behind a large tool result; logs run to hundreds of MB. */
const TAIL_BYTES = 1024 * 1024;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Claude: the request's fresh + cached prompt, plus the reply it produced. */
function claudeUsage(line: Json): ChatTurnUsage | undefined {
  // A sub-agent's reply measures the sub-agent's context, not this session's.
  if (line.type !== 'assistant' || line.isSidechain) return undefined;
  const usage = obj(obj(line.message)?.usage);
  if (!usage) return undefined;
  const contextTokens =
    num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens) + num(usage.output_tokens);
  return contextTokens > 0 ? { contextTokens } : undefined;
}

/** Codex: `last_token_usage` is the latest request; `total_token_usage` is the running bill. */
function codexUsage(line: Json): ChatTurnUsage | undefined {
  const payload = obj(line.payload);
  if (line.type !== 'event_msg' || payload?.type !== 'token_count') return undefined;
  const info = obj(payload.info);
  const contextTokens = num(obj(info?.last_token_usage)?.total_tokens);
  if (contextTokens <= 0) return undefined;
  const contextWindow = num(info?.model_context_window);
  return { contextTokens, ...(contextWindow > 0 ? { contextWindow } : {}) };
}

const READERS = [claudeUsage, codexUsage];

/** The last `maxBytes` of a file as lines; a line cut by the window's start is dropped. */
function tailLines(path: string, maxBytes: number): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString('utf8').split(/\r?\n/);
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * The context size after the session's latest reply, or undefined when the log
 * is unknown, unreadable or holds no usage yet. Never throws: this decorates a
 * chat message, and a missing badge must not cost the message.
 */
export function readTranscriptUsage(path: string | undefined, tailBytes = TAIL_BYTES): ChatTurnUsage | undefined {
  if (!path) return undefined;
  let lines: string[];
  try {
    lines = tailLines(path, tailBytes);
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let line: Json | undefined;
    try {
      line = obj(JSON.parse(lines[i]));
    } catch {
      continue; // blank, or a final line torn mid-write
    }
    if (!line) continue;
    for (const read of READERS) {
      const usage = read(line);
      if (usage) return usage;
    }
  }
  return undefined;
}
