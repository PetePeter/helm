/**
 * How much context each sub-agent of a CLI session has used, for the token
 * ledger. A sub-agent's work never shows in the main context, so without this
 * the timesheet misses it entirely.
 *
 * Each CLI records sub-agents differently:
 * - Claude: one file per sub-agent in `<session>/subagents/`.
 * - Codex: a rollout file of its own beside the parent's, whose
 *   `session_meta` names the parent in `parent_thread_id`.
 * - Copilot: inside the parent's `events.jsonl`, tagged with an `agentId`.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChatTurnUsage } from './chat/chat-bridge.js';
import {
  claudeReplyUsage, codexUsage, copilotRecordUsage, copilotSubagentId, obj, tailLines, type Json,
} from './transcript-usage.js';

const TAIL_BYTES = 1024 * 1024;
/** session_meta comes first; this is enough to reach its parent_thread_id. */
const HEAD_BYTES = 64 * 1024;
const CODEX_ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Sub-agent key → its latest context tokens. Empty when there are none or nothing is readable. */
export function readSubagentContexts(transcriptPath: string | undefined): Map<string, number> {
  const result = new Map<string, number>();
  if (!transcriptPath) return result;
  try {
    const name = basename(transcriptPath);
    if (name === 'events.jsonl') readCopilot(transcriptPath, result);
    else if (CODEX_ROLLOUT.test(name)) readCodex(transcriptPath, result);
    else readClaude(transcriptPath, result);
  } catch {
    // Usage is optional; an unreadable log just adds nothing.
  }
  return result;
}

function parsed(lines: string[]): Json[] {
  const out: Json[] = [];
  for (const line of lines) {
    try {
      const value = obj(JSON.parse(line));
      if (value) out.push(value);
    } catch {
      // blank, or torn mid-write
    }
  }
  return out;
}

function latest(path: string, read: (line: Json) => ChatTurnUsage | undefined): number | undefined {
  const lines = parsed(tailLines(path, TAIL_BYTES));
  for (let i = lines.length - 1; i >= 0; i--) {
    const usage = read(lines[i]);
    if (usage) return usage.contextTokens;
  }
  return undefined;
}

function readClaude(transcriptPath: string, out: Map<string, number>): void {
  const dir = join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const tokens = latest(join(dir, file), claudeReplyUsage);
    if (tokens) out.set(file, tokens);
  }
}

/** A rollout's first line never changes, so its parent is looked up once. */
const codexParents = new Map<string, string | null>();

function codexParent(path: string): string | null {
  const cached = codexParents.get(path);
  if (cached !== undefined) return cached;
  const fd = openSync(path, 'r');
  let head: string;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    head = buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const parent = /"parent_thread_id"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null;
  // A first line still being written is read again next time.
  if (parent !== null || head.includes('\n')) codexParents.set(path, parent);
  return parent;
}

function readCodex(transcriptPath: string, out: Map<string, number>): void {
  const mainId = CODEX_ROLLOUT.exec(basename(transcriptPath))?.[1];
  if (!mainId) return;
  const dir = dirname(transcriptPath);
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    if (path === transcriptPath || !CODEX_ROLLOUT.test(file) || codexParent(path) !== mainId) continue;
    const tokens = latest(path, codexUsage);
    if (tokens) out.set(file, tokens);
  }
}

function readCopilot(transcriptPath: string, out: Map<string, number>): void {
  // Oldest to newest, so each sub-agent ends on its latest record.
  for (const line of parsed(tailLines(transcriptPath, TAIL_BYTES))) {
    const agent = copilotSubagentId(line);
    const usage = agent ? copilotRecordUsage(line) : undefined;
    if (agent && usage) out.set(agent, usage.contextTokens);
  }
}
