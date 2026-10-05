/**
 * ApiSessionProcess — an API-tool session presented as a PtyProcess.
 *
 * Like RemotePtyProcess, it is adopted into PtyManager, so everything
 * downstream (xterm view, activity dots, read_terminal, session_send_text,
 * chat inbound, bindings) works unchanged. Instead of a CLI, the "process" is a
 * tiny line editor in front of the in-process agent loop:
 *   - bytes written to it are keystrokes / bracketed pastes;
 *   - CR outside a paste submits the line as one user turn;
 *   - Ctrl+C or Esc aborts the running turn;
 *   - `/clear` (session_clear's default) wipes the conversation;
 *   - the turn's reasoning, tool calls and answer are rendered back as ANSI.
 */

import type { PtyProcess } from '../pty-manager.js';
import {
  runAgentTurn,
  type AgentEvent,
  type ChatClient,
  type ChatMessage,
  type ToolSpec,
} from './api-agent-loop.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Announce bracketed paste so Helm's delivery pipeline frames multi-line text as one paste. */
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const PROMPT = '\x1b[1;36m›\x1b[0m ';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const MAX_REASONING_PREVIEW = 400;
const MAX_RESULT_PREVIEW_LINES = 4;
const CLEAR_COMMAND = '/clear';
const COMPACT_COMMAND = '/compact';
/** The one tool-less turn a compaction asks for; its answer becomes the whole new history. */
const COMPACT_REQUEST = 'Compact your context: write a handover summary of this conversation for yourself — '
  + 'the goal, decisions made, facts and ids you still need, open work and next steps. Plain text only.';
const HANDSHAKE_NOTE = 'This is the first message of the conversation: tools are off for this reply. '
  + 'Reply briefly with what you understood and what you plan to do; tools unlock once the user confirms.';
const HANDOVER_PREFIX = '[Handover — your summary of the conversation before compaction]';

export interface ApiTurnOutcome {
  input: string;
  finalText: string;
  toolsUsed: string[];
  contextTokens?: number;
  thoughtCount?: number;
  error?: string;
}

/** Identifies deleted chat bubbles: the user's own text, or one of the model's answers. */
export interface ForgottenMessage {
  text: string;
  fromUser: boolean;
}

export interface ApiSessionDeps {
  client: ChatClient;
  system: string;
  tools: ToolSpec[];
  /** Named in the system prompt, offered once loaded with load_tools (see runAgentTurn). */
  deferredTools?: ToolSpec[];
  /**
   * No tools on a fresh conversation's first turn: the model restates what it
   * understood, and the user's next message (the confirmation) unlocks tools.
   */
  handshake?: boolean;
  executeTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  maxToolRounds?: number;
  history: ChatMessage[];
  saveHistory: (history: ChatMessage[]) => void;
  /** Per-turn context (time, cwd) appended to the END of the user message. */
  mutableContext: () => string;
  /** A turn begins; may resolve per-prompt context to append after the mutable context. */
  onTurnStart?: (input: string) => Promise<string | null> | void;
  onTurnEnd?: (outcome: ApiTurnOutcome) => void;
  /**
   * Compaction handover, in the user's order: stash the summary as a memory
   * (it survives a crash mid-swap), and once pasted back, drop it again.
   */
  stashSummary?: (summary: string) => string | undefined;
  dropSummary?: (memoryId: string) => void;
  /**
   * History shrank outside a turn's reply (compaction, deleted chat bubbles):
   * why, and the old and estimated new context size, so the count can update.
   */
  onContextShrunk?: (reason: 'compacted' | 'deleted', before: number | undefined, after: number | undefined) => void;
  banner?: string;
}

/**
 * Remove what deleted chat bubbles stand for. A turn runs from a user message
 * up to the next one.
 *   - A user bubble matches the turn whose user message starts with its text
 *     (Helm appends mutable context after it): the whole turn goes — the
 *     question, the tool calls and results it caused, and the answer.
 *   - A model bubble matches the turn whose answer starts with its text (the
 *     chat copy may be the first chunk of a longer answer): the answer goes
 *     with every tool call and result it was built on; the question stays.
 */
export function dropTurns(history: readonly ChatMessage[], messages: readonly ForgottenMessage[]): ChatMessage[] {
  const starts = history.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  const doomed = new Set<number>();
  starts.forEach((start, t) => {
    const end = starts[t + 1] ?? history.length;
    const turn = history.slice(start, end);
    const userText = turn[0].content ?? '';
    const answers = turn.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content!.trim());
    const matches = (m: ForgottenMessage) => {
      const text = m.text.trim();
      if (!text) return false;
      return m.fromUser ? userText.startsWith(text) : answers.some((a) => a.startsWith(text.slice(0, 200)));
    };
    const first = messages.some((m) => m.fromUser && matches(m)) ? start
      : messages.some((m) => !m.fromUser && matches(m)) ? start + 1
        : end;
    for (let i = first; i < end; i++) doomed.add(i);
  });
  return history.filter((_, i) => !doomed.has(i));
}

/** Trims tried on one turn before a context-full error is reported. */
const MAX_OVERFLOW_TRIMS = 3;

/** The server refused the request because the history no longer fits its context. */
export function isContextOverflow(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /exceeds? the (available )?context|context (length|size|window)|maximum context|too many tokens/i.test(text);
}

/**
 * Compaction for a full context, with no model call (a full context cannot
 * summarise itself): forget every tool call and its result — the bulk, and
 * re-doable — then the oldest third of turns. The prose of the rest survives.
 */
export function trimForOverflow(history: readonly ChatMessage[]): ChatMessage[] {
  const prose = history
    .filter((m) => m.role !== 'tool')
    .map((m) => (m.tool_calls ? { role: m.role, content: m.content } : m))
    .filter((m) => m.role === 'user' || (m.content ?? '').trim());
  const starts = prose.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  const cut = starts[Math.ceil(starts.length / 3)] ?? prose.length;
  return prose.slice(cut);
}

/** Past turns before the first forget nudge, then the gap between nudges — a reminder, not a nag. */
export const FORGET_NUDGE_AFTER = 20;
export const FORGET_NUDGE_EVERY = 10;

/** Once history is long, ask the model every few turns to prune what it no longer needs. */
export function forgetNudge(history: readonly ChatMessage[]): string | null {
  const turns = history.filter((m) => m.role === 'user').length;
  if (turns < FORGET_NUDGE_AFTER || (turns - FORGET_NUDGE_AFTER) % FORGET_NUDGE_EVERY !== 0) return null;
  return `Your context holds ${turns} past turns. Drop the ones you no longer need with forget_turns `
    + '(save anything worth keeping as a memory first).';
}

/**
 * Estimate the context size after history shrank, from the last size the
 * server reported: scaled by characters. The next request reports the truth.
 */
export function rescaleTokens(tokens: number | undefined, before: readonly ChatMessage[], after: readonly ChatMessage[]): number | undefined {
  if (tokens === undefined) return undefined;
  const size = (history: readonly ChatMessage[]) => history.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const was = size(before);
  return was ? Math.round(tokens * size(after) / was) : tokens;
}

export function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function isCompact(text: string): boolean {
  return text === COMPACT_COMMAND || text.startsWith(`${COMPACT_COMMAND} `);
}

function preview(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, maxLines).map((line) => line.slice(0, 200)).join('\n');
  return lines.length > maxLines ? `${head}\n… (+${lines.length - maxLines} lines)` : head;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

export class ApiSessionProcess implements PtyProcess {
  /** No OS process exists; 0 marks "not a local child" wherever a pid is shown. */
  readonly pid = 0;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private line = '';
  private inPaste = false;
  private pending = '';
  private queue: string[] = [];
  private running: AbortController | null = null;
  private history: ChatMessage[];
  private exited = false;
  private pendingForget: ForgottenMessage[] = [];
  /** Input submitted mid-turn, fed to the model after its current tool step. */
  private injected: string[] = [];
  /** The model's own checkpoints (label → history index); any rewrite of history invalidates them. */
  private readonly checkpoints = new Map<string, number>();
  /** The context size the server last reported (or its estimate after a shrink). */
  private contextTokens: number | undefined;

  constructor(private readonly deps: ApiSessionDeps) {
    this.history = [...deps.history];
  }

  onData = (callback: (data: string) => void): void => {
    this.dataCallbacks.push(callback);
  };

  onExit = (callback: (e: { exitCode: number; signal?: number }) => void): void => {
    this.exitCallbacks.push(callback);
  };

  /** Paint the banner and prompt. Called once adopted, so the first frame reaches PtyManager. */
  start(): void {
    this.emit(ENABLE_BRACKETED_PASTE);
    if (this.deps.banner) this.emit(`${DIM}${toTerminal(this.deps.banner)}${RESET}\r\n`);
    if (this.history.length) this.emit(`${DIM}(resumed — ${this.history.length} messages of history)${RESET}\r\n`);
    this.emit(PROMPT);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  write(data: string): void {
    // A paste marker can straddle writes; keep an incomplete escape for the next one.
    let input = this.pending + data;
    this.pending = '';
    while (input.length) {
      if (input.startsWith(PASTE_START)) { this.inPaste = true; input = input.slice(PASTE_START.length); continue; }
      if (input.startsWith(PASTE_END)) { this.inPaste = false; input = input.slice(PASTE_END.length); continue; }
      const ch = input[0];
      if (ch === '\x1b') {
        // A lone Esc is a keypress; only a longer fragment can be a split paste marker.
        if (input.length > 1 && (PASTE_START.startsWith(input) || PASTE_END.startsWith(input))) { this.pending = input; return; }
        // A lone Esc aborts; any other escape sequence (arrows, focus) is swallowed.
        const seq = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(input)![0];
        if (seq === '\x1b') this.abort();
        input = input.slice(seq.length);
        continue;
      }
      input = input.slice(1);
      if (this.inPaste) { this.line += ch; this.echo(ch); continue; }
      if (ch === '\r') { this.submit(); continue; }
      if (ch === '\x03') { this.abort(); continue; }
      if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) { this.line = this.line.slice(0, -1); this.emit('\b \b'); }
        continue;
      }
      if (ch === '\n' || ch >= ' ') { this.line += ch; this.echo(ch); }
    }
  }

  resize(): void {}

  kill(): void {
    if (this.exited) return;
    this.abort();
    this.exited = true;
    // Exit is reported on a later tick, as a real process's is: callers such as
    // session close kill the PTY and then remove the session themselves, and a
    // synchronous exit would remove it under them ("session not found").
    setTimeout(() => { for (const cb of this.exitCallbacks) cb({ exitCode: 0 }); }, 0);
  }

  /** Abort the running turn, if any. Queued input is kept. */
  abort(): void {
    this.running?.abort();
  }

  private echo(ch: string): void {
    this.emit(ch === '\n' ? '\r\n' : ch);
  }

  private submit(): void {
    const text = this.line.trim();
    this.line = '';
    this.emit('\r\n');
    if (!text) { if (!this.running) this.emit(PROMPT); return; }
    if (this.running && text !== CLEAR_COMMAND && !isCompact(text)) {
      this.injected.push(text);
      this.emit(`${DIM}(queued — the model reads it after its current step)${RESET}\r\n`);
      return;
    }
    this.queue.push(text);
    if (!this.running) void this.drain();
    else this.emit(`${DIM}(queued — runs after the current turn)${RESET}\r\n`);
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.exited) {
      const input = this.queue.shift()!;
      if (input === CLEAR_COMMAND) this.clearHistory();
      else if (isCompact(input)) await this.compact(input.slice(COMPACT_COMMAND.length).trim());
      else await this.runTurn(input);
    }
    if (!this.exited) this.emit(PROMPT);
  }

  /**
   * Drop whole turns (a user message and everything the model did in answer)
   * matching deleted chat bubbles. Deferred while a turn runs, so the running
   * turn's history does not resurrect them when it lands.
   */
  forget(messages: readonly ForgottenMessage[]): void {
    this.pendingForget.push(...messages);
    if (!this.running) this.applyForget();
  }

  /**
   * `idle` = the user deleted bubbles between turns: nothing else will carry
   * the new size, so report it. At a turn's end the reply's badge carries it.
   */
  private applyForget(idle = true): void {
    if (!this.pendingForget.length) return;
    const messages = this.pendingForget.splice(0);
    const next = dropTurns(this.history, messages);
    if (next.length === this.history.length) return;
    const before = this.contextTokens;
    this.contextTokens = rescaleTokens(before, this.history, next);
    this.history = next;
    this.checkpoints.clear();
    this.deps.saveHistory(this.history);
    this.emit(`${DIM}(deleted from context)${RESET}\r\n`);
    if (idle) this.deps.onContextShrunk?.('deleted', before, this.contextTokens);
  }

  /** `/clear` — what session_clear sends by default — starts a fresh conversation. */
  private clearHistory(): void {
    this.history = [];
    this.contextTokens = undefined;
    this.checkpoints.clear();
    this.deps.saveHistory(this.history);
    this.emit(`${DIM}(history cleared)${RESET}\r\n`);
  }

  /**
   * `/compact [focus]` — what session_compact sends. The model writes a
   * handover summary in one tool-less turn; the summary is stashed as a
   * memory, becomes the entire new history, then the memory is dropped.
   */
  private async compact(focus: string): Promise<void> {
    if (!this.history.length) { this.emit(`${DIM}(nothing to compact)${RESET}\r\n`); return; }
    const controller = new AbortController();
    this.running = controller;
    this.emit(`${DIM}(compacting…)${RESET}\r\n`);
    try {
      const result = await runAgentTurn({
        client: this.deps.client,
        system: this.deps.system,
        tools: [],
        history: this.history,
        userContent: focus ? `${COMPACT_REQUEST}\nFocus on: ${focus}` : COMPACT_REQUEST,
        executeTool: async () => 'Error: no tools during compaction',
        signal: controller.signal,
      });
      const summary = result.finalText.trim();
      if (!summary) throw new Error('the model returned an empty summary');
      const memoryId = this.deps.stashSummary?.(summary);
      const next: ChatMessage[] = [
        { role: 'user', content: `${HANDOVER_PREFIX}\n${summary}` },
        { role: 'assistant', content: 'Understood — continuing from the summary.' },
      ];
      const before = result.contextTokens ?? this.contextTokens;
      this.contextTokens = rescaleTokens(before, result.history, next);
      this.history = next;
      this.checkpoints.clear();
      this.deps.saveHistory(this.history);
      if (memoryId) this.deps.dropSummary?.(memoryId);
      this.emit(`${DIM}(context compacted)${RESET}\r\n`);
      this.deps.onContextShrunk?.('compacted', before, this.contextTokens);
    } catch (err) {
      const reason = controller.signal.aborted ? 'interrupted' : err instanceof Error ? err.message : String(err);
      this.emit(`${RED}Compaction failed (${toTerminal(reason)}) — history kept${RESET}\r\n`);
    } finally {
      this.running = null;
    }
  }

  /**
   * Run a request; when the server says the context is full, compact the
   * history (trimForOverflow) and retry the same turn — the history is ours,
   * so the retry simply continues from the smaller one.
   */
  private async withOverflowTrim<T>(controller: AbortController, request: () => Promise<T>): Promise<T> {
    for (let trims = 0; ; trims++) {
      try {
        return await request();
      } catch (err) {
        if (controller.signal.aborted || trims >= MAX_OVERFLOW_TRIMS || !isContextOverflow(err)) throw err;
        const before = this.contextTokens;
        const next = trimForOverflow(this.history);
        this.contextTokens = rescaleTokens(before, this.history, next);
        this.history = next;
        this.checkpoints.clear();
        this.deps.saveHistory(this.history);
        this.emit(`${DIM}(context full — forgot tool calls and the oldest third of the conversation)${RESET}\r\n`);
        this.deps.onContextShrunk?.('compacted', before, this.contextTokens);
      }
    }
  }

  private async runTurn(input: string): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    const hints = await this.deps.onTurnStart?.(input);
    const gated = Boolean(this.deps.handshake) && this.history.length === 0;
    const context = [this.deps.mutableContext(), hints, forgetNudge(this.history), gated ? HANDSHAKE_NOTE : null]
      .filter(Boolean).join('\n\n');
    const outcome: ApiTurnOutcome = { input, finalText: '', toolsUsed: [] };
    try {
      const result = await this.withOverflowTrim(controller, () => runAgentTurn({
        client: this.deps.client,
        system: this.deps.system,
        tools: gated ? [] : this.deps.tools,
        deferredTools: gated ? undefined : this.deps.deferredTools,
        history: this.history,
        userContent: context ? `${input}\n\n${context}` : input,
        executeTool: (name, args) => this.deps.executeTool(name, args, controller.signal),
        onEvent: (event) => this.render(event),
        maxToolRounds: this.deps.maxToolRounds,
        signal: controller.signal,
        takeInjected: () => (this.injected.length ? this.injected.splice(0).join('\n\n') : null),
        checkpoints: this.checkpoints,
      }));
      this.history = result.history;
      this.deps.saveHistory(this.history);
      outcome.finalText = result.finalText;
      outcome.toolsUsed = result.toolsUsed;
      outcome.thoughtCount = result.thoughtCount;
      this.contextTokens = result.contextTokens ?? this.contextTokens;
    } catch (err) {
      outcome.error = controller.signal.aborted ? 'aborted' : err instanceof Error ? err.message : String(err);
      this.emit(`${RED}${controller.signal.aborted ? '(interrupted)' : `Error: ${toTerminal(outcome.error)}`}${RESET}\r\n`);
    } finally {
      this.running = null;
    }
    // Sent too late to join (the model answered without another tool step):
    // it runs as the next turn instead of being lost.
    this.queue.unshift(...this.injected.splice(0));
    // Forget first, so the reply's context badge already shows the shrunk size.
    this.applyForget(false);
    if (this.contextTokens !== undefined) outcome.contextTokens = this.contextTokens;
    this.deps.onTurnEnd?.(outcome);
  }

  private render(event: AgentEvent): void {
    switch (event.type) {
      case 'reasoning': {
        const text = event.text.trim();
        const shown = text.length > MAX_REASONING_PREVIEW ? `${text.slice(0, MAX_REASONING_PREVIEW)}…` : text;
        if (shown) this.emit(`${DIM}✻ ${toTerminal(shown)}${RESET}\r\n`);
        return;
      }
      case 'text':
        this.emit(`${toTerminal(event.text.trim())}\r\n`);
        return;
      case 'tool_call':
        this.emit(`${CYAN}● ${event.name}${RESET}${DIM}(${toTerminal(summarizeArgs(event.args))})${RESET}\r\n`);
        return;
      case 'rollback':
        this.emit(`${CYAN}↺ rolled back to "${event.label}"${RESET}${DIM} (${event.dropped} messages forgotten)${RESET}\r\n`);
        return;
      case 'tool_result':
        this.emit(`${DIM}  ⎿ ${toTerminal(preview(event.result, MAX_RESULT_PREVIEW_LINES)).replace(/\r\n/g, '\r\n    ')}${RESET}\r\n`);
        return;
    }
  }

  private emit(data: string): void {
    if (this.exited || !data) return;
    for (const cb of this.dataCallbacks) cb(data);
  }
}
