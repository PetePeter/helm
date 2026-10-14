/**
 * Auto memory for real CLI sessions (docs/auto-memory.md).
 *
 * Helm does not own a CLI's loop, so its turns are read back from the log the
 * CLI's hooks report: the same file Quick Compact strips. This file is the
 * adapter (log records in, the judge's turns out) and the trigger that runs a
 * pass when a Stop hook says a turn ended. The window, the prompt and the
 * parser are auto-memory-judge.ts, untouched.
 *
 * A turn starts at a user message the user (or Helm, on their behalf) sent.
 * Text a CLI or a hook injects under the user role does not start one.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { JUDGE_CONTEXT_TURNS, type JudgeOutcome, type JudgeTurn } from './auto-memory-judge.js';
import {
  cleanText, detectFormat, isNoise, parse, resultText,
  type Block, type Line, type TranscriptFormat,
} from './transcript-strip.js';
import { logger } from '../utils/logger.js';

/** Injected under the user role, mid-turn: a finished background task, an interrupt marker, hook feedback, the project rules. */
const NOT_A_REQUEST = ['<task-notification', '[Request interrupted', '<hook_prompt', '# AGENTS.md instructions'];

/** First read from the end of the log; grown fourfold until enough turns are in it. */
const TAIL_BYTES = 1024 * 1024;
/** A single turn larger than this is not judged. */
const MAX_TAIL_BYTES = 64 * 1024 * 1024;

class Turns {
  readonly list: JudgeTurn[] = [];

  /** A user message: starts a turn unless it is injected text. `id` is the record's own id, when it has one. */
  request(raw: string, id: unknown, line: Line): void {
    const text = cleanText(raw);
    if (!text || isNoise(text) || NOT_A_REQUEST.some((prefix) => text.startsWith(prefix))) return;
    const key = typeof id === 'string' && id
      ? id
      : createHash('sha1').update(`${String(line.timestamp ?? '')}\n${text}`).digest('hex').slice(0, 16);
    this.list.push({ key, request: text, steps: [], answer: '' });
  }

  call(name: unknown, args: unknown): void {
    this.list.at(-1)?.steps.push({ kind: 'call', name: String(name), args: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
  }

  result(text: string): void {
    this.list.at(-1)?.steps.push({ kind: 'result', text });
  }

  answer(raw: string): void {
    const text = cleanText(raw);
    const turn = this.list.at(-1);
    if (text && turn) turn.answer = text;
  }
}

function claudeTurns(lines: Line[], turns: Turns): void {
  for (const line of lines) {
    // Meta records are injected, sidechains are a sub-agent's own conversation, a compact summary is not a request.
    if ((line.type !== 'user' && line.type !== 'assistant') || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    const content = (line.message as Block | undefined)?.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (line.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') turns.answer(block.text);
        else if (block.type === 'tool_use') turns.call(block.name, block.input);
      }
      continue;
    }
    const results = blocks.filter((block) => block.type === 'tool_result');
    for (const block of results) turns.result(resultText(block.content));
    if (!results.length) turns.request(blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n'), line.uuid, line);
  }
}

function codexTurns(lines: Line[], turns: Turns): void {
  // response_item is the canonical record; event_msg repeats it for the TUI.
  for (const line of lines) {
    if (line.type !== 'response_item') continue;
    const payload = (line.payload ?? {}) as Block;
    if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      const text = resultText(payload.content);
      if (payload.role === 'user') turns.request(text, payload.id, line);
      else turns.answer(text);
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      turns.call(payload.name, payload.arguments ?? payload.input);
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      turns.result(resultText(payload.output));
    }
  }
}

function copilotTurns(lines: Line[], turns: Turns): void {
  for (const line of lines) {
    const data = (line.data ?? {}) as Block;
    if (data.parentToolCallId || data.parentAgentTaskId) continue; // a sub-agent's own records; the parent logs the call
    if (line.type === 'user.message') {
      // content is what the user typed; transformedContent adds Copilot's injected context.
      turns.request(String(data.content ?? ''), line.id, line);
    } else if (line.type === 'assistant.message') {
      turns.answer(String(data.content ?? ''));
      for (const request of (Array.isArray(data.toolRequests) ? data.toolRequests : []) as Block[]) turns.call(request.name, request.arguments);
    } else if (line.type === 'tool.execution_complete') {
      turns.result(data.success === false
        ? String((data.error as Block | undefined)?.message ?? '')
        : resultText((data.result as Block | undefined)?.content));
    }
  }
}

const READERS: Record<TranscriptFormat, (lines: Line[], turns: Turns) => void> = {
  claude: claudeTurns,
  codex: codexTurns,
  copilot: copilotTurns,
};

/** The turns in a stretch of a Claude Code, Codex or Copilot CLI log, oldest first. The last may be unfinished: no answer. */
export function transcriptTurns(lines: Line[]): JudgeTurn[] {
  const turns = new Turns();
  READERS[detectFormat(lines)](lines, turns);
  return turns.list;
}

/**
 * The newest turns of a transcript. Read from the end, because a judge pass
 * needs four turns and a log can be hundreds of megabytes: the tail grows
 * until it holds enough turns or the whole file. Enough is `wanted` turns,
 * or, given `target`, that turn with its context turns before it. `end`
 * reads the log as it stood at that size. Turn keys come from the records
 * themselves, so they do not depend on where the read started.
 */
export async function readTranscriptTurns(
  path: string,
  options: { wanted?: number; target?: string; end?: number; chunkBytes?: number; onRead?: (bytes: number) => void } = {},
): Promise<JudgeTurn[]> {
  const enough = (turns: JudgeTurn[]): boolean => (options.target === undefined
    ? turns.length >= (options.wanted ?? JUDGE_CONTEXT_TURNS + 1)
    : turns.findIndex((turn) => turn.key === options.target) >= JUDGE_CONTEXT_TURNS);
  const file = await open(path, 'r');
  try {
    const size = Math.min((await file.stat()).size, options.end ?? Infinity);
    for (let bytes = options.chunkBytes ?? TAIL_BYTES; ; bytes *= 4) {
      const whole = bytes >= size;
      // One byte early: the first line is then always a cut record, or empty when the read begins on a record.
      const start = whole ? 0 : Math.max(0, size - Math.min(bytes, MAX_TAIL_BYTES) - 1);
      const { buffer, bytesRead } = await file.read(Buffer.alloc(size - start), 0, size - start, start);
      options.onRead?.(bytesRead);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
      if (start > 0) lines.shift();
      const turns = transcriptTurns(parse(lines));
      if (start === 0 || enough(turns) || bytes >= MAX_TAIL_BYTES) return turns;
    }
  } finally {
    await file.close();
  }
}

export interface CliAutoMemoryDeps {
  /** Live read: auto-save is on and a recording model is picked. Off means the log is not even read. */
  isEnabled: () => boolean;
  /** The log a session's hooks reported. None for a session without hooks, and for an API session. */
  getTranscriptPath: (sessionId: string) => string | undefined;
  record: (sessionId: string, turns: JudgeTurn[]) => Promise<JudgeOutcome>;
  /** The pause before each read of the turn. Replaced in tests. */
  wait?: (ms: number) => Promise<void>;
  /** Reads tried before giving the turn up. Two is the least that can judge the newest turn. */
  attempts?: number;
}

const SETTLE_MS = 1000;
const ATTEMPTS = 4;

/** A turn as it stands: a later read that shows the same mark shows the same turn. */
const markOf = (turn: JudgeTurn): string => `${turn.key}\n${turn.steps.length}\n${turn.answer}`;

export class CliAutoMemory {
  /** The last turn the judge answered on per session, as it stood then. */
  private readonly judged = new Map<string, string>();
  /** The last Stop being handled per session: Stops of one session are judged one at a time, in order. */
  private readonly tails = new Map<string, Promise<JudgeOutcome>>();

  constructor(private readonly deps: CliAutoMemoryDeps) {}

  /**
   * A Stop hook: judge the turn it ended. That is the newest turn of the log
   * as it stands right now, so the log's size is taken before this returns:
   * the hook is answered after it, and only then can the next request be
   * written. Never throws.
   */
  turnEnded(sessionId: string): Promise<JudgeOutcome> {
    const path = this.deps.isEnabled() ? this.deps.getTranscriptPath(sessionId) : undefined;
    if (!path) return Promise.resolve('off');
    let end: number;
    try {
      end = statSync(path).size;
    } catch {
      return Promise.resolve('off');
    }
    // An unreadable log names no turn; it must not reject while the Stop before it is still being judged.
    const stopped = readTranscriptTurns(path, { wanted: 1, end }).then((turns) => turns.at(-1)?.key, () => undefined);
    const pass = Promise.allSettled([this.tails.get(sessionId)])
      .then(async () => this.judgeTurn(sessionId, path, await stopped))
      .catch((err): JudgeOutcome => {
        logger.warn(`[AutoMemory] Could not read the transcript of ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        return 'off';
      });
    this.tails.set(sessionId, pass);
    void pass.then(() => { if (this.tails.get(sessionId) === pass) this.tails.delete(sessionId); });
    return pass;
  }

  forget(sessionId: string): void {
    this.judged.delete(sessionId);
  }

  private async judgeTurn(sessionId: string, path: string, key: string | undefined): Promise<JudgeOutcome> {
    if (key === undefined) return 'off';
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    /** The turn's mark at the previous read. */
    let seen: string | undefined;
    for (let attempt = 0; attempt < (this.deps.attempts ?? ATTEMPTS); attempt++) {
      await wait(SETTLE_MS);
      const turns = await readTranscriptTurns(path, { target: key });
      const index = turns.findIndex((turn) => turn.key === key);
      if (index < 0) return 'off';
      const turn = turns[index];
      const mark = markOf(turn);
      // The turn is finished once a later one began, or once two reads agree on it: the
      // Stop hook can fire before the CLI has written the final answer, and text written
      // before a tool call looks like an answer.
      const finished = index < turns.length - 1 || seen === mark;
      seen = mark;
      if (!finished) continue;
      // No answer: cut short. The same mark: a Stop that added nothing to a turn already judged.
      if (!turn.answer || this.judged.get(sessionId) === mark) return 'off';
      // A turn before it with no answer was cut short too; it is no context.
      const outcome = await this.deps.record(sessionId, turns.slice(0, index + 1).filter((earlier) => earlier.answer));
      // A pass that got no answer from the judge leaves the turn for its next Stop.
      if (outcome !== 'off' && outcome !== 'failed') this.judged.set(sessionId, mark);
      return outcome;
    }
    return 'off';
  }
}
