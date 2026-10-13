/**
 * Auto memory's judge: after a finished turn, a silent pass decides whether
 * the conversation now holds a key memory (docs/auto-memory.md).
 *
 * It identifies, it does not summarise: "nothing to keep" is the normal
 * answer. This file is the pure part (the window the judge is shown, its
 * prompt, and the parser for its reply) plus the recorder that runs a pass
 * and writes at most one session-bound memory.
 */

import { createHash } from 'node:crypto';
import type { SilentRunner } from './silent-model-runner.js';
import type { ChatMessage } from './api/api-agent-loop.js';
import { logger } from '../utils/logger.js';

/** Context turns shown before the target. A ceiling: the token budget may allow fewer. */
export const JUDGE_CONTEXT_TURNS = 3;
/** Budget for the whole window. Small on purpose: the judge is a small model run on every turn. */
export const JUDGE_WINDOW_TOKENS = 3000;
/** Tool-result caps tried in turn when the window is over budget; 0 leaves only a marker. */
const TOOL_RESULT_CAPS = [1500, 400, 0];
const TOOL_ARGS_CAP = 300;
/** A context turn only has to resolve a reference; it is never shown whole. */
const CONTEXT_TEXT_CAP = 1200;
const MIN_TARGET_TEXT = 200;
const TLDR_MAX = 200;
const CONTENT_MAX = 600;
/** Helm appends its per-turn context to the user message after this marker. */
const HELM_CONTEXT_MARKER = '\n\n<helm_context>';

export type JudgeStep =
  | { kind: 'call'; name: string; args: string }
  | { kind: 'result'; text: string }
  /** Something the user (or a rollback) added while the turn was running. */
  | { kind: 'user'; text: string };

/** One turn of an API session: the user's request and everything done in answer. */
export interface JudgeTurn {
  /** Stable id of the turn, from its own user message; survives earlier turns being forgotten. */
  key: string;
  request: string;
  /** Tool calls, their results and mid-turn user messages, in order. */
  steps: JudgeStep[];
  /** The last text the model wrote in the turn. */
  answer: string;
}

/** A session-bound memory as the judge needs it. `sourceTurn` is absent on one the judge did not save. */
export interface SavedMemory {
  id: string;
  tldr: string;
  sourceTurn?: string;
  updatedAt: number;
}

export interface JudgeWindow {
  mission?: string;
  context: Array<{ request: string; answer: string }>;
  target: { request: string; steps: JudgeStep[]; answer: string };
  /** Memories saved from the turns shown, newest first. The judge names them by position, from 1. */
  saved: Array<{ id: string; tldr: string }>;
  targetKey: string;
}

export type JudgeVerdict =
  | { kind: 'nothing' }
  | { kind: 'new'; tldr: string; content: string }
  /** `index` counts from 1 into the window's `saved` list. */
  | { kind: 'update'; index: number; tldr: string; content: string };

export const JUDGE_SYSTEM_PROMPT = [
  'You are a memory judge. You are shown a transcript of a working session between a USER and another ASSISTANT.',
  'You are not part of that conversation: never answer the user and never continue the work.',
  'Decide whether the transcript holds a key memory worth saving for future sessions. You do NOT summarise it.',
  'Most turns hold nothing worth keeping, and NOTHING is the normal, correct answer.',
  '',
  'A key memory is one of:',
  '- a fact about the system (a port, a path, a setting, how two parts connect)',
  '- a decision and its reason',
  '- a fix for an error',
  '- a preference of the user',
  '',
  'Ignore: greetings, plans and progress reports, what the assistant is about to do, restated questions,',
  'file contents and command output as such, guesses, and anything in ALREADY SAVED.',
  '',
  'Read MISSION, CONTEXT and TARGET together as one picture. The memory may come from any part of it;',
  'TARGET is only the newest piece. MISSION is framing: never save the mission itself.',
  'Tool results are evidence for a finding, not findings in themselves.',
  'A finding the assistant already told the user is NOT saved yet. Only the entries under ALREADY SAVED are saved.',
  '',
  'Reply in exactly one of these three forms, with no other text:',
  '',
  'NOTHING',
  '',
  'NEW',
  'TLDR: <the fact itself in one line, with the specific terms someone would search for>',
  'CONTENT: <the fact with what is needed to use it, about 300 characters>',
  '',
  'UPDATE <number from ALREADY SAVED>',
  'TLDR: <the fuller fact in one line>',
  'CONTENT: <the fuller fact, about 300 characters>',
  '',
  'A good TLDR: "RS485 on the EG004 needs 9600 baud". A bad TLDR: "Baud rate finding".',
  'Use UPDATE only when the picture got fuller than a memory in ALREADY SAVED. If it is already covered, answer NOTHING.',
].join('\n');

/** A rough size: about four characters to a token. The server reports the truth; this only has to cap. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Keep the head and the tail; the middle of a long text carries the least. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = ' …[trimmed]… ';
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`.slice(0, max);
}

function userRequest(content: string | null): string {
  const text = content ?? '';
  const cut = text.indexOf(HELM_CONTEXT_MARKER);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

/**
 * A turn starts at a user message carrying Helm's per-turn context: only a
 * submitted request has it. A message injected while a turn runs, or a
 * rollback note, has none and stays inside its turn. Before the first such
 * request (a compaction handover, the manifesto) every user message starts one.
 */
export function splitTurns(history: readonly ChatMessage[]): JudgeTurn[] {
  const isRequest = (message: ChatMessage) => message.role === 'user' && (message.content ?? '').includes(HELM_CONTEXT_MARKER);
  const firstRequest = history.findIndex(isRequest);
  const starts = history.flatMap((message, index) => (
    isRequest(message) || (message.role === 'user' && (firstRequest < 0 || index < firstRequest)) ? [index] : []));
  return starts.map((start, turn) => {
    const messages = history.slice(start, starts[turn + 1] ?? history.length);
    const steps: JudgeStep[] = [];
    let answer = '';
    for (const message of messages.slice(1)) {
      if (message.role === 'tool') steps.push({ kind: 'result', text: message.content ?? '' });
      if (message.role === 'user') steps.push({ kind: 'user', text: message.content ?? '' });
      if (message.role !== 'assistant') continue;
      for (const call of message.tool_calls ?? []) steps.push({ kind: 'call', name: call.function.name, args: call.function.arguments });
      if (message.content?.trim()) answer = message.content.trim();
    }
    return {
      // The raw message carries Helm's per-turn context (a timestamp), which keeps repeats apart.
      key: createHash('sha1').update(messages[0].content ?? '').digest('hex').slice(0, 16),
      request: userRequest(messages[0].content),
      steps,
      answer,
    };
  });
}

export function renderJudgePrompt(window: JudgeWindow): string {
  const parts: string[] = [];
  if (window.mission) parts.push(`MISSION (framing only, never save it):\n${window.mission}`);
  if (window.context.length) {
    parts.push(['CONTEXT (earlier turns, oldest first):', ...window.context.map((turn) => `USER: ${turn.request}\nASSISTANT: ${turn.answer}`)].join('\n\n'));
  }
  parts.push([
    'TARGET (the newest turn):',
    `USER: ${window.target.request}`,
    ...window.target.steps.map((step) => (step.kind === 'call' ? `TOOL CALL: ${step.name} ${step.args}`
      : step.kind === 'result' ? `TOOL RESULT: ${step.text}` : `USER: ${step.text}`)),
    `ASSISTANT: ${window.target.answer}`,
  ].join('\n'));
  parts.push([
    'ALREADY SAVED (from the turns above, newest first):',
    ...(window.saved.length ? window.saved.map((memory, index) => `[${index + 1}] ${memory.tldr}`) : ['(none)']),
  ].join('\n'));
  parts.push('Your verdict on this transcript: NOTHING, NEW or UPDATE <number>.');
  return parts.join('\n\n');
}

/**
 * What one pass is shown: the mission, up to three earlier turns as user
 * message + final answer, the newest turn whole, and the memories already
 * saved from those turns. Over budget, tool results shrink first, then the
 * oldest context turn goes; the mission is never dropped. A turn that cannot
 * be made to fit is not judged: null.
 */
export function buildJudgeWindow(params: {
  history: readonly ChatMessage[];
  mission?: string;
  bound: readonly SavedMemory[];
  budgetTokens?: number;
}): JudgeWindow | null {
  const turns = splitTurns(params.history);
  const target = turns.at(-1);
  if (!target) return null;
  const budget = params.budgetTokens ?? JUDGE_WINDOW_TOKENS;
  const mission = params.mission?.trim() || undefined;
  let shown = turns.slice(-(JUDGE_CONTEXT_TURNS + 1), -1);
  let request = target.request;
  let answer = target.answer;

  /** Mid-turn user messages are the target's own text: whole until the last resort. */
  let midTurnCap = Infinity;

  const assemble = (resultCap: number): JudgeWindow => {
    const keys = new Set([...shown.map((turn) => turn.key), target.key]);
    return {
      ...(mission ? { mission } : {}),
      context: shown.map((turn) => ({ request: clip(turn.request, CONTEXT_TEXT_CAP), answer: clip(turn.answer, CONTEXT_TEXT_CAP) })),
      target: {
        request,
        answer,
        steps: target.steps.map((step): JudgeStep => (step.kind === 'call' ? { ...step, args: clip(step.args, TOOL_ARGS_CAP) }
          : step.kind === 'user' ? { ...step, text: clip(step.text, midTurnCap) }
            : { kind: 'result', text: resultCap ? clip(step.text, resultCap) : '[trimmed]' })),
      },
      saved: params.bound
        .filter((memory) => memory.sourceTurn !== undefined && keys.has(memory.sourceTurn))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, tldr }) => ({ id, tldr })),
      targetKey: target.key,
    };
  };
  const overBy = (window: JudgeWindow): number => renderJudgePrompt(window).length - budget * 4;

  let window = assemble(TOOL_RESULT_CAPS[0]);
  for (const cap of TOOL_RESULT_CAPS.slice(1)) {
    if (overBy(window) <= 0) return window;
    window = assemble(cap);
  }
  while (overBy(window) > 0 && shown.length) {
    shown = shown.slice(1);
    window = assemble(0);
  }
  // Last resort: the target's own text is too long for the budget.
  if (overBy(window) > 0) {
    midTurnCap = CONTEXT_TEXT_CAP;
    window = assemble(0);
  }
  for (let over = overBy(window); over > 0; over = overBy(window)) {
    const cutAnswer = answer.length >= request.length;
    const text = cutAnswer ? answer : request;
    if (text.length <= MIN_TARGET_TEXT) break;
    const clipped = clip(text, Math.max(MIN_TARGET_TEXT, text.length - over));
    if (cutAnswer) answer = clipped;
    else request = clipped;
    window = assemble(0);
  }
  // What is left is fixed (the mission, the step list, the saved list): too big to judge.
  return overBy(window) > 0 ? null : window;
}

const NOTHING: JudgeVerdict = { kind: 'nothing' };

/**
 * Strict on purpose: the first line must be the verdict, then TLDR, then
 * CONTENT. A small model that wraps its answer in chat has not answered, and
 * anything unreadable saves nothing.
 */
export function parseJudgeReply(reply: string, savedCount: number): JudgeVerdict {
  const lines = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'));
  const verdict = /^(NOTHING|NEW|UPDATE)(?:\s+\[?(\d+)\]?)?[.:]?$/i.exec(lines[0] ?? '');
  if (!verdict) return NOTHING;
  const kind = verdict[1].toUpperCase();
  if (kind === 'NOTHING') return NOTHING;
  const index = verdict[2] === undefined ? undefined : Number(verdict[2]);
  if (kind === 'NEW' ? index !== undefined : index === undefined || index < 1 || index > savedCount) return NOTHING;

  const tldr = /^TLDR:\s*(.*)$/i.exec(lines[1] ?? '')?.[1].trim();
  const first = /^CONTENT:\s*(.*)$/i.exec(lines[2] ?? '')?.[1];
  if (!tldr || first === undefined) return NOTHING;
  const content = [first, ...lines.slice(3)].join('\n').trim();
  if (!content) return NOTHING;
  const atom = { tldr: tldr.slice(0, TLDR_MAX), content: content.slice(0, CONTENT_MAX) };
  return index === undefined ? { kind: 'new', ...atom } : { kind: 'update', index, ...atom };
}

export interface AutoMemoryWrite {
  tldr: string;
  content: string;
  /** The turn the memory was drawn from; an update moves it to the turn that completed the picture. */
  sourceTurn: string;
}

export interface AutoMemoryRecorderDeps {
  runner: SilentRunner;
  /** Live read of the auto-save switch. */
  isEnabled: () => boolean;
  /** Whether the session still exists: a pass that outlives its session writes nothing. */
  isLive: (sessionId: string) => boolean;
  getMission: (sessionId: string) => string | undefined;
  /** The session's own bound memories. */
  listBound: (sessionId: string) => SavedMemory[];
  create: (sessionId: string, memory: AutoMemoryWrite) => void;
  update: (sessionId: string, id: string, memory: AutoMemoryWrite) => void;
  budgetTokens?: number;
}

/** What a pass did; `off` = no request was made. */
export type JudgeOutcome = 'off' | 'nothing' | 'created' | 'updated' | 'failed';

export class AutoMemoryRecorder {
  /** The last pass queued per session: passes over one session run one at a time, in turn order. */
  private readonly tails = new Map<string, Promise<JudgeOutcome>>();

  constructor(private readonly deps: AutoMemoryRecorderDeps) {}

  /**
   * Judge the newest turn of `history`. Queued behind the session's earlier
   * passes, so each one sees what the one before saved. Never throws.
   */
  recordTurn(sessionId: string, history: readonly ChatMessage[]): Promise<JudgeOutcome> {
    const pass = (this.tails.get(sessionId) ?? Promise.resolve<JudgeOutcome>('off'))
      .then(() => this.judge(sessionId, history))
      .catch((err): JudgeOutcome => {
        logger.warn(`[AutoMemory] Judge pass failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
      });
    this.tails.set(sessionId, pass);
    void pass.then(() => { if (this.tails.get(sessionId) === pass) this.tails.delete(sessionId); });
    return pass;
  }

  private async judge(sessionId: string, history: readonly ChatMessage[]): Promise<JudgeOutcome> {
    if (!this.deps.isEnabled() || !this.deps.isLive(sessionId)) return 'off';
    const window = buildJudgeWindow({
      history,
      mission: this.deps.getMission(sessionId),
      bound: this.deps.listBound(sessionId),
      budgetTokens: this.deps.budgetTokens,
    });
    if (!window) return 'off';
    const result = await this.deps.runner.runSilently({ system: JUDGE_SYSTEM_PROMPT, prompt: renderJudgePrompt(window) });
    if (result.status === 'inert') return 'off';
    if (result.status === 'failed') return 'failed';
    const verdict = parseJudgeReply(result.text, window.saved.length);
    if (verdict.kind === 'nothing') return 'nothing';
    // The model took its time: the session may have closed, and its memories been purged, meanwhile.
    if (!this.deps.isLive(sessionId)) return 'off';
    const memory: AutoMemoryWrite = { tldr: verdict.tldr, content: verdict.content, sourceTurn: window.targetKey };
    if (verdict.kind === 'new') {
      this.deps.create(sessionId, memory);
      return 'created';
    }
    this.deps.update(sessionId, window.saved[verdict.index - 1].id, memory);
    return 'updated';
  }
}
