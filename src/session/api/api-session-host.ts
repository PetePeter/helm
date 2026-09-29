/**
 * ApiSessionHost — builds the in-process "process" behind an API-tool session
 * and wires it to Helm: ticked native + Helm MCP tools, the skills directory,
 * hook-equivalent activity events, persisted history (resume) and the
 * automatic chat reply.
 *
 * spawnConfiguredSession asks the registered host for a process whenever the
 * CLI type carries an `api` block; the session is then adopted into PtyManager
 * like a Remote row, so nothing downstream needs to know it is not a CLI.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ApiToolConfig } from '../../config/loader.js';
import type { AuthContext, McpTool } from '../../mcp/tools/types.js';
import { getToolReminder } from '../../mcp/tools/reminders.js';
import type { HookEvent } from '../hooks/hook-normaliser.js';
import { logger } from '../../utils/logger.js';
import { CHECKPOINT_TOOL, createOpenAiChatClient, FORGET_TOOL, ROLLBACK_TOOL, type ChatClient, type ChatMessage } from './api-agent-loop.js';
import { getNativeTool, truncateOutput } from './api-native-tools.js';
import {
  buildMutableContext,
  buildSystemPrompt,
  chunkForChat,
  listAvailableApiTools,
  AGENT_TOOL,
  buildHandover,
  isChatTool,
  parseSenderTag,
  REQUEST_TOOL,
  CHAT_HISTORY_TOOL,
  formatChatHistory,
  type ChatHistoryEntry,
  selectApiTools,
  type SkillSummary,
} from './api-prompt.js';
import { ApiSessionProcess, type ApiTurnOutcome } from './api-session-process.js';
import type { ChatTurnUsage } from '../chat/chat-bridge.js';

export interface ApiSessionHostDeps {
  /** Same dispatch path as the MCP server, under the session's own identity. */
  dispatchTool: (name: string, args: Record<string, unknown>, auth: AuthContext) => Promise<unknown>;
  mcpTools: () => readonly McpTool[];
  listSkills: (cwd: string | undefined) => SkillSummary[];
  getMission: (sessionId: string) => string | undefined;
  /** Create a memory owned by a session, with the first-party agentRun / summary flags. */
  createMemory: (sessionId: string, input: { tldr: string; content: string; agentRun: boolean; summary: boolean }) => { id: string };
  linkMemory: (sessionId: string, fromId: string, toId: string) => void;
  /** A session's count of subagents it is waiting on changed (0 = none) — drives the 🔥 badge. */
  onPendingSubagents?: (sessionId: string, count: number) => void;
  /** File a request_tool wish as skill feedback (see REQUEST_TOOL), under the session's identity. */
  recordToolRequest: (request: { name: string; purpose: string; example?: string }, auth: AuthContext) => void;
  /** Post an automatic reply to the user's chat surfaces, with the turn's cost for the bubble badge. */
  postChat: (sessionId: string, message: string, usage: ChatTurnUsage) => Promise<unknown>;
  /** Feed a synthetic hook event to the tracker, so dots/flash/plan settlement match a hooked CLI. */
  emitHook: (event: HookEvent) => void;
  /**
   * The per-prompt hook context (suggestions, mission, rules, nudges) a hooked
   * CLI would be injected with. `tools` = every tool the session is offered;
   * hints naming any other tool are dropped.
   */
  promptContext?: (sessionId: string, prompt: string, tools: ReadonlySet<string>) => Promise<string | null>;
  /** The session's chat messages (both sides), oldest first — backs chat_history. */
  chatHistory?: (sessionId: string) => ChatHistoryEntry[];
  /** Folder holding one history JSON per cliSessionName. */
  historyDir: string;
  env?: NodeJS.ProcessEnv;
  createClient?: (api: ApiToolConfig, apiKey: string | undefined) => ChatClient;
  now?: () => Date;
}

export interface ApiSessionSpawn {
  sessionId: string;
  /** The CLI type id — a subagent is spawned from the same one. */
  cliType?: string;
  sessionName: string;
  cliSessionName: string;
  cwd?: string;
  api: ApiToolConfig;
  /** The CLI type's resolved env entries; `apiKeyEnv` is looked up here before the process env. */
  env?: Record<string, string>;
}

const HISTORY_FILE_RE = /^[A-Za-z0-9-]+$/;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** The one extra turn a finished subagent is asked for: the header its parent receives. */
const SUMMARY_REQUEST = 'Summarise your result for the parent in at most 3 sentences: the answer and the key facts. Plain text only.';
/** How deep subagents may nest: parent → child → grandchild → great-grandchild. */
export const MAX_SUBAGENT_DEPTH = 3;
/** Subagents working at once under one top-level session, however deep — a runaway fan-out stops here. */
export const MAX_LIVE_SUBAGENTS_PER_ROOT = 20;
/** Reply-target key for the user's chat surfaces (session ids never collide with it). */
const CHAT_TARGET = 'chat';

/** Where a subagent sits: its depth below the top-level session, and that session's id. */
interface SubagentLineage {
  depth: number;
  root: string;
  parent: string;
}

export class ApiSessionHost {
  /** Where each session's model already replied itself this turn: 'chat' and/or peer session ids. */
  private readonly repliedThisTurn = new Map<string, Set<string>>();

  /** Live processes by session, so chat deletions can reach their history. */
  private readonly processes = new Map<string, ApiSessionProcess>();
  /** Subagents being spawned, by the name reserved for them: their place in the tree. */
  private readonly pendingSubagents = new Map<string, SubagentLineage>();
  /** Every subagent session's place in the tree (top-level sessions are absent: depth 0, own root). */
  private readonly lineage = new Map<string, SubagentLineage>();
  /** Subagents currently working, per top-level session. */
  private readonly liveByRoot = new Map<string, number>();
  /** Subagents each session is waiting on (direct children only). */
  private readonly pendingBySession = new Map<string, number>();
  /** Summary memories of the subagents a session has run — its pointers, once it is summarised itself. */
  private readonly childSummaries = new Map<string, string[]>();
  /** A subagent's next finished turn, awaited by its parent's Agent call. */
  private readonly subagentWaiters = new Map<string, (outcome: ApiTurnOutcome) => void>();
  /** Per API tool (CLI type): model requests in flight and those queued for a free slot. */
  private readonly slots = new Map<string, { running: number; queue: Array<() => void> }>();
  private subagentCounter = 0;

  constructor(private readonly deps: ApiSessionHostDeps) {}

  /**
   * The user deleted chat bubbles of an API session: drop what they stand for
   * from the model's history. `fromUser` bubbles are the user's own messages.
   */
  /** The session that spawned this subagent session, or undefined for a top-level session. */
  parentOf(sessionId: string): string | undefined {
    return this.lineage.get(sessionId)?.parent;
  }

  forgetMessages(sessionId: string, messages: ReadonlyArray<{ text: string; fromUser: boolean }>): void {
    this.processes.get(sessionId)?.forget(messages);
  }

  create(spawn: ApiSessionSpawn): ApiSessionProcess {
    const { api, sessionId, sessionName, cwd } = spawn;
    const auth: AuthContext = { sessionId, sessionName };
    const hasAgentTool = Boolean(spawn.cliType);
    // A subagent's result comes back as a memory header; memory_get is how the
    // caller follows its pointers, so it rides along with the Agent tool.
    const allowed = hasAgentTool ? [...new Set([...api.allowedTools, 'memory_get'])] : api.allowedTools;
    const tools = selectApiTools(listAvailableApiTools(this.deps.mcpTools()), allowed);
    const toolNames = tools.map((tool) => tool.name);
    // Every session is OFFERED the Agent tool, subagents included: system prompt
    // + tool block must be byte-identical to the parent's so the server's prefix
    // cache is shared. Depth and fan-out limits are enforced when a call runs.
    const pending = this.pendingSubagents.get(sessionName);
    if (pending) {
      this.pendingSubagents.delete(sessionName);
      this.lineage.set(sessionId, pending);
    }
    const builtins = [REQUEST_TOOL, CHAT_HISTORY_TOOL, CHECKPOINT_TOOL, ROLLBACK_TOOL, FORGET_TOOL, ...(hasAgentTool ? [AGENT_TOOL] : [])];
    const offered = new Set([...toolNames, ...builtins.map((tool) => tool.name)]);
    const system = buildSystemPrompt({
      toolNames,
      skills: toolNames.includes('skill_get') ? this.safeSkills(cwd) : [],
      extra: api.systemPrompt,
    });
    const apiKey = api.apiKeyEnv
      ? spawn.env?.[api.apiKeyEnv] || (this.deps.env ?? process.env)[api.apiKeyEnv]
      : undefined;
    const rawClient = this.deps.createClient?.(api, apiKey)
      ?? createOpenAiChatClient({ baseUrl: api.baseUrl, model: api.model, apiKey });
    // Every request of this API tool waits for one of its slots, so a burst of
    // subagents queues here instead of overrunning the server.
    const slotKey = spawn.cliType ?? sessionId;
    const slotCount = Math.max(1, api.slots ?? 1);
    const client: ChatClient = {
      complete: async (messages, toolSpecs, signal) => {
        await this.acquireSlot(slotKey, slotCount);
        try {
          return await rawClient.complete(messages, toolSpecs, signal);
        } finally {
          this.releaseSlot(slotKey);
        }
      },
    };
    const historyFile = this.historyFile(spawn.cliSessionName);
    const now = this.deps.now ?? (() => new Date());

    const proc = new ApiSessionProcess({
      client,
      system,
      tools: [...tools.map(({ name, description, parameters }) => ({ name, description, parameters })), ...builtins],
      maxToolRounds: api.maxToolRounds,
      history: this.loadHistory(historyFile),
      saveHistory: (history) => this.saveHistory(historyFile, history),
      mutableContext: () => buildMutableContext({
        now: now(),
        cwd,
        sessionId,
        sessionName,
      }),
      executeTool: (name, args, signal) => (name === AGENT_TOOL.name && hasAgentTool
        ? this.runSubagents(args, { auth, cwd, cliType: spawn.cliType!, signal })
        : this.executeTool(name, args, { cwd: cwd ?? process.cwd(), signal, auth, allowed: toolNames })),
      onTurnStart: (input) => {
        this.repliedThisTurn.set(sessionId, new Set());
        this.hook(sessionId, 'UserPromptSubmit', cwd);
        return this.promptContext(sessionId, input, offered);
      },
      onTurnEnd: (outcome) => this.onTurnEnd(sessionId, auth, cwd, outcome),
      stashSummary: (summary) => {
        try {
          return this.deps.createMemory(sessionId, { tldr: `[HANDOVER] ${sessionName} — compaction summary`, content: summary, agentRun: false, summary: true }).id;
        } catch (err) {
          logger.warn(`[ApiSession] Could not stash compaction summary for ${sessionId}: ${String(err)}`);
          return undefined;
        }
      },
      dropSummary: (memoryId) => {
        this.deps.dispatchTool('memory_delete', { id: memoryId }, auth)
          .catch((err) => logger.warn(`[ApiSession] Could not drop compaction summary ${memoryId}: ${String(err)}`));
      },
      // The badge on this note is the new context count; the next reply's badge is the server's truth.
      onContextShrunk: (reason, _before, after) => {
        if (after === undefined || this.lineage.has(sessionId)) return;
        this.deps.postChat(sessionId, reason === 'compacted' ? '(context compacted)' : '(deleted from context)', { contextTokens: after, toolCalls: 0 })
          .catch((err) => logger.warn(`[ApiSession] Could not post context update for ${sessionId}: ${String(err)}`));
      },
      banner: `API tool · ${api.model} @ ${api.baseUrl} · ${toolNames.length} tools`,
    });
    this.processes.set(sessionId, proc);
    proc.onExit(() => {
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      this.lineage.delete(sessionId);
      // A subagent closed mid-task answers its parent rather than leaving it waiting forever.
      this.subagentWaiters.get(sessionId)?.({ input: '', finalText: '', toolsUsed: [], error: 'subagent session closed' });
    });
    return proc;
  }

  /**
   * The Agent tool: spawn a fresh session of the same API tool (a visible row),
   * hand it the task, and return its final answer. Any number may be asked for;
   * their model requests share the API tool's slots, so they queue there.
   */
  /** One Agent call = one batch: every task runs in parallel, results come back in task order. */
  private async runSubagents(
    args: Record<string, unknown>,
    ctx: { auth: AuthContext; cwd?: string; cliType: string; signal: AbortSignal },
  ): Promise<string> {
    const tasks = Array.isArray(args.tasks) ? args.tasks.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object') : [];
    if (!tasks.length) return 'Error: tasks must be a non-empty array of {description, prompt}';
    const results = await Promise.all(tasks.map((task) => this.runSubagent(task, ctx)));
    return results.length === 1 ? results[0] : results.map((r, i) => `[${i + 1}] ${r}`).join('\n\n');
  }

  private async runSubagent(
    task: Record<string, unknown>,
    ctx: { auth: AuthContext; cwd?: string; cliType: string; signal: AbortSignal },
  ): Promise<string> {
    const description = typeof task.description === 'string' ? task.description.trim() : '';
    const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
    if (!description || !prompt) return 'Error: description and prompt are required';
    const parentId = ctx.auth.sessionId!;
    const parent = this.lineage.get(parentId) ?? { depth: 0, root: parentId, parent: '' };
    if (parent.depth >= MAX_SUBAGENT_DEPTH) {
      return `Error: subagents may nest only ${MAX_SUBAGENT_DEPTH} deep; do this part yourself.`;
    }
    const live = this.liveByRoot.get(parent.root) ?? 0;
    if (live >= MAX_LIVE_SUBAGENTS_PER_ROOT) {
      return `Error: ${MAX_LIVE_SUBAGENTS_PER_ROOT} subagents are already working in this tree; do this part yourself or wait for them.`;
    }
    this.liveByRoot.set(parent.root, live + 1);
    this.bumpPending(parentId, 1);
    try {
      return await this.delegate(description, prompt, parentId, { depth: parent.depth + 1, root: parent.root, parent: parentId }, ctx);
    } finally {
      this.bumpPending(parentId, -1);
      const left = (this.liveByRoot.get(parent.root) ?? 1) - 1;
      if (left > 0) this.liveByRoot.set(parent.root, left);
      else this.liveByRoot.delete(parent.root);
    }
  }

  private async delegate(
    description: string,
    prompt: string,
    parentId: string,
    place: SubagentLineage,
    ctx: { auth: AuthContext; cwd?: string; cliType: string; signal: AbortSignal },
  ): Promise<string> {
    const name = `${ctx.auth.sessionName} › ${description} #${++this.subagentCounter}`;
    this.pendingSubagents.set(name, place);
    const created = await this.deps.dispatchTool('session_create', {
      cliType: ctx.cliType,
      dirPath: ctx.cwd ?? process.cwd(),
      name,
    }, ctx.auth) as { id?: string };
    this.pendingSubagents.delete(name);
    const childId = created?.id;
    const child = childId ? this.processes.get(childId) : undefined;
    if (!childId || !child) return 'Error: the subagent session could not be started';
    const done = new Promise<ApiTurnOutcome>((resolve) => this.subagentWaiters.set(childId, resolve));
    const abort = () => child.abort();
    ctx.signal.addEventListener('abort', abort);
    const handover = buildHandover({
      parentName: ctx.auth.sessionName ?? parentId,
      mission: this.deps.getMission(parentId),
      description,
      prompt,
    });
    // The same bracketed paste + Enter any delivered message arrives as.
    child.write(`${PASTE_START}${handover}${PASTE_END}\r`);
    try {
      const outcome = await done;
      if (outcome.error) return `Subagent "${description}" failed: ${outcome.error}`;
      const detail = outcome.finalText.trim();
      if (!detail) return `Subagent "${description}" finished without a reply.`;
      return await this.recordResult(child, childId, parentId, description, detail);
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      this.subagentWaiters.delete(childId);
      // Its job is done once it has answered: the session closes. Until then it
      // is an ordinary session the user can watch and chat with.
      if (this.processes.has(childId)) {
        await this.deps.dispatchTool('session_close', { sessionId: childId }, ctx.auth)
          .catch((err) => logger.warn(`[ApiSession] Could not close subagent ${childId}: ${String(err)}`));
      }
    }
  }

  /**
   * File a finished subagent's result as a memory graph and hand the parent
   * only the header. The subagent itself writes the summary (one more short
   * turn, on a cached prefix). Summary node → detail node, and → the summaries
   * of the subagents IT ran: a description with pointers the parent can follow
   * with memory_get when the header is not enough.
   */
  private async recordResult(
    child: ApiSessionProcess,
    childId: string,
    parentId: string,
    description: string,
    detail: string,
  ): Promise<string> {
    const next = new Promise<ApiTurnOutcome>((resolve) => this.subagentWaiters.set(childId, resolve));
    child.write(`${PASTE_START}${SUMMARY_REQUEST}${PASTE_END}\r`);
    const summaryTurn = await next;
    const summary = summaryTurn.finalText.trim() || detail.slice(0, 400);
    let header: { id: string };
    try {
      const detailNode = this.deps.createMemory(childId, { tldr: `${description} — detail`, content: detail, agentRun: true, summary: false });
      header = this.deps.createMemory(childId, { tldr: description, content: summary, agentRun: true, summary: true });
      this.deps.linkMemory(childId, header.id, detailNode.id);
      for (const grandchild of this.childSummaries.get(childId) ?? []) this.deps.linkMemory(childId, header.id, grandchild);
    } catch (err) {
      logger.warn(`[ApiSession] Could not file subagent result as memory: ${String(err)}`);
      return detail;
    } finally {
      this.childSummaries.delete(childId);
    }
    this.childSummaries.set(parentId, [...(this.childSummaries.get(parentId) ?? []), header.id]);
    return [
      `Subagent "${description}" — result memory ${header.id}`,
      summary,
      `(Full detail and any nested results: memory_get id=${header.id} graphDepth=1)`,
    ].join('\n');
  }

  private bumpPending(sessionId: string, delta: number): void {
    const count = Math.max(0, (this.pendingBySession.get(sessionId) ?? 0) + delta);
    if (count) this.pendingBySession.set(sessionId, count);
    else this.pendingBySession.delete(sessionId);
    this.deps.onPendingSubagents?.(sessionId, count);
  }

  private acquireSlot(key: string, max: number): Promise<void> {
    const slots = this.slots.get(key) ?? { running: 0, queue: [] };
    this.slots.set(key, slots);
    if (slots.running < max) {
      slots.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => slots.queue.push(() => { slots.running++; resolve(); }));
  }

  private releaseSlot(key: string): void {
    const slots = this.slots.get(key);
    if (!slots) return;
    slots.running--;
    slots.queue.shift()?.();
    if (slots.running === 0 && slots.queue.length === 0) this.slots.delete(key);
  }

  private forgetTurns(sessionId: string, args: Record<string, unknown>): string {
    const messages = (Array.isArray(args.messages) ? args.messages : [])
      .filter((m): m is { text: string; fromUser: unknown } => !!m && typeof m === 'object' && typeof m.text === 'string' && !!m.text.trim())
      .map((m) => ({ text: m.text, fromUser: m.fromUser === true }));
    if (!messages.length) return 'Error: messages must be a non-empty array of {text, fromUser}';
    this.processes.get(sessionId)?.forget(messages);
    return `${messages.length} message(s) will be forgotten after this turn.`;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: { cwd: string; signal: AbortSignal; auth: AuthContext; allowed: string[] },
  ): Promise<string> {
    if (name === REQUEST_TOOL.name) return this.requestTool(args, ctx.auth);
    if (name === CHAT_HISTORY_TOOL.name) return formatChatHistory(this.deps.chatHistory?.(ctx.auth.sessionId!) ?? [], args);
    if (name === FORGET_TOOL.name) return this.forgetTurns(ctx.auth.sessionId!, args);
    // The model only ever sees ticked tools, but it can still hallucinate a name.
    if (!ctx.allowed.includes(name)) return `Error: tool "${name}" is not available in this session`;
    this.hook(ctx.auth.sessionId!, 'PreToolUse', ctx.cwd, name, args);
    let result: string;
    const native = getNativeTool(name);
    if (native) {
      result = await native.run(args, { cwd: ctx.cwd, signal: ctx.signal });
    } else {
      const raw = await this.deps.dispatchTool(name, args, ctx.auth);
      this.noteReply(ctx.auth.sessionId!, name, args);
      const reminder = getToolReminder(name);
      result = `${JSON.stringify(raw, null, 2)}${reminder ? `\n\n${reminder}` : ''}`;
    }
    this.hook(ctx.auth.sessionId!, 'PostToolUse', ctx.cwd, name, args);
    return truncateOutput(result);
  }

  private async requestTool(args: Record<string, unknown>, auth: AuthContext): Promise<string> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
    if (!name || !purpose) return 'Error: name and purpose are required';
    const example = typeof args.example === 'string' && args.example.trim() ? args.example.trim() : undefined;
    try {
      this.deps.recordToolRequest({ name, purpose, ...(example ? { example } : {}) }, auth);
      await this.deps.dispatchTool('chat_send', {
        message: chunkForChat(`${auth.sessionName} requests a new tool: ${name}\n${purpose}`)[0],
      }, auth);
    } catch (err) {
      logger.warn(`[ApiSession] Tool request could not be filed: ${String(err)}`);
    }
    return `Requested "${name}". It is not available now — carry on without it.`;
  }

  /** Remember a reply the model sent itself, so the automatic one is not doubled. */
  private noteReply(sessionId: string, tool: string, args: Record<string, unknown>): void {
    const replied = this.repliedThisTurn.get(sessionId);
    if (!replied) return;
    if (isChatTool(tool)) replied.add(CHAT_TARGET);
    if (tool === 'session_send_text' && typeof args.sessionId === 'string') replied.add(args.sessionId);
  }

  /**
   * Deliver the turn's final answer: back to a session that sent the input and
   * awaits a reply, otherwise to the user's chat — unless the model already
   * replied there itself.
   */
  private async onTurnEnd(sessionId: string, auth: AuthContext, cwd: string | undefined, outcome: ApiTurnOutcome): Promise<void> {
    this.hook(sessionId, outcome.error && outcome.error !== 'aborted' ? 'StopFailure' : 'Stop', cwd);
    const replied = this.repliedThisTurn.get(sessionId) ?? new Set<string>();
    this.repliedThisTurn.delete(sessionId);
    // A subagent's answer belongs to the parent that is waiting on it, not to the user's chat.
    const waiter = this.subagentWaiters.get(sessionId);
    if (waiter) {
      waiter(outcome);
      return;
    }
    const reply = outcome.finalText.trim() || (outcome.error ? `(turn failed: ${outcome.error})` : '');
    if (!reply) return;
    const sender = parseSenderTag(outcome.input);
    const target = sender?.awaitingReply ? sender.sessionId : CHAT_TARGET;
    if (replied.has(target)) return;
    try {
      if (target === CHAT_TARGET) {
        const usage: ChatTurnUsage = { contextTokens: outcome.contextTokens ?? 0, toolCalls: outcome.toolsUsed.length };
        for (const message of chunkForChat(reply)) await this.deps.postChat(sessionId, message, usage);
      } else {
        await this.deps.dispatchTool('session_send_text', { sessionId: target, senderSessionId: sessionId, text: reply }, auth);
      }
    } catch (err) {
      logger.warn(`[ApiSession] Auto reply to ${target} failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fail-open: a broken injector costs the turn its hints, never the turn. */
  private async promptContext(sessionId: string, input: string, tools: ReadonlySet<string>): Promise<string | null> {
    try {
      return (await this.deps.promptContext?.(sessionId, input, tools)) ?? null;
    } catch (err) {
      logger.warn(`[ApiSession] Prompt context failed for ${sessionId}: ${String(err)}`);
      return null;
    }
  }

  private hook(sessionId: string, event: HookEvent['event'], cwd?: string, toolName?: string, toolInput?: Record<string, unknown>): void {
    try {
      this.deps.emitHook({
        // API sessions speak no CLI dialect; the canonical events are what matter.
        cli: 'claude',
        event,
        helmSessionId: sessionId,
        ...(cwd ? { cwd } : {}),
        ...(toolName ? { toolName } : {}),
        ...(toolInput ? { toolInput } : {}),
        receivedAt: Date.now(),
        raw: { source: 'api-session' },
      });
    } catch (err) {
      logger.warn(`[ApiSession] Hook emit failed: ${String(err)}`);
    }
  }

  private safeSkills(cwd: string | undefined): SkillSummary[] {
    try {
      return this.deps.listSkills(cwd);
    } catch (err) {
      logger.warn(`[ApiSession] Skill listing failed: ${String(err)}`);
      return [];
    }
  }

  private historyFile(cliSessionName: string): string | null {
    // cliSessionName is a Helm UUID; refuse anything that could escape the folder.
    return HISTORY_FILE_RE.test(cliSessionName) ? path.join(this.deps.historyDir, `${cliSessionName}.json`) : null;
  }

  private loadHistory(file: string | null): ChatMessage[] {
    if (!file) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveHistory(file: string | null, history: ChatMessage[]): void {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(history), 'utf8');
    } catch (err) {
      logger.warn(`[ApiSession] Could not persist history: ${String(err)}`);
    }
  }
}

/** The single host, registered at startup; spawns before registration fail loudly. */
let registeredHost: ApiSessionHost | null = null;

export function registerApiSessionHost(host: ApiSessionHost | null): void {
  registeredHost = host;
}

export function getApiSessionHost(): ApiSessionHost {
  if (!registeredHost) throw new Error('API tool sessions are not available: no ApiSessionHost registered');
  return registeredHost;
}
