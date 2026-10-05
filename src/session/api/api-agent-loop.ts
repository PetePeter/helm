/**
 * The agent loop of an API-tool session: one user turn = ask the model, run
 * any tool calls it makes, feed results back, repeat until it answers in plain
 * text (or the round cap is hit).
 *
 * Prompt layout is cache-first: [system (constant)] + [history (append-only)]
 * + [new user message]. Anything that changes per turn — time, cwd, hook context —
 * rides at the END of the new user message, never in the system prompt, so the
 * server's prefix cache (llama.cpp slot reuse, provider prompt caching) keeps
 * everything before it.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface CompletionResult {
  message: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string };
  finishReason?: string;
  usage?: CompletionUsage;
}

export interface ChatClient {
  complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<CompletionResult>;
}

export type AgentEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'rollback'; label: string; dropped: number };

export interface AgentTurnParams {
  client: ChatClient;
  system: string;
  tools: ToolSpec[];
  /** Prior conversation; never mutated — the turn returns the extended copy. */
  history: ChatMessage[];
  userContent: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onEvent?: (event: AgentEvent) => void;
  maxToolRounds?: number;
  signal?: AbortSignal;
  /**
   * Messages the user sent while this turn was running. Polled after each
   * round of tool results: anything returned joins the conversation right
   * there, so the model reads it before its next step instead of after the
   * whole turn. Returns null when nothing is waiting.
   */
  takeInjected?: () => string | null;
  /**
   * Named checkpoints into the conversation (label → history index of the
   * assistant message that set it). Owned by the session so they outlive a
   * turn; the loop reads and writes it for the checkpoint/rollback tools.
   */
  checkpoints?: Map<string, number>;
  /**
   * Tools named in the system prompt but not offered until the model loads
   * them with load_tools. What is loaded is read back from the history, so it
   * survives a resume and vanishes with a forgotten or compacted load.
   */
  deferredTools?: ToolSpec[];
}

export interface AgentTurnResult {
  history: ChatMessage[];
  finalText: string;
  toolsUsed: string[];
  /** Tokens in the model's context after the turn (last request's prompt + reply), when the server reports usage. */
  contextTokens?: number;
}

function contextSize(usage: CompletionUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) || undefined);
}

export const DEFAULT_MAX_TOOL_ROUNDS = 25;

/**
 * Forgetting on purpose. `checkpoint` marks the conversation; `rollback`
 * cuts everything after that mark from the model's own context and leaves a
 * short note in its place — go on a journey, save what matters (a memory),
 * roll back, carry on with only the note. The cut lands on a message boundary
 * before the checkpoint call, so no tool call is ever left unanswered, and the
 * prefix before it stays byte-identical for the server's cache.
 */
export const CHECKPOINT_TOOL: ToolSpec = {
  name: 'checkpoint',
  description: 'Mark this point in the conversation so you can roll back to it later with rollback.',
  parameters: {
    type: 'object',
    properties: { label: { type: 'string', description: 'A short name for the checkpoint' } },
    required: ['label'],
  },
};

export const ROLLBACK_TOOL: ToolSpec = {
  name: 'rollback',
  description: 'Forget everything since a checkpoint (your own context only; files and memories you wrote stay). '
    + 'Leave yourself a note of what to keep, e.g. "found X, saved as memory <id>".',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'The checkpoint to return to' },
      note: { type: 'string', description: 'What to remember after rolling back' },
    },
    required: ['label', 'note'],
  },
};

/**
 * Selective forgetting of past turns — rollback's sibling for old history.
 * Matching reuses the chat bubble-delete rules (dropTurns), and the cut
 * happens after the current turn, so this turn's messages stay coherent.
 */
export const FORGET_TOOL: ToolSpec = {
  name: 'forget_turns',
  description: 'Drop past turns you no longer need from your own context (files and memories stay). '
    + 'Quote the start of each message; a user message drops its whole turn, your answer drops just the answer and its tool calls. '
    + 'Takes effect after this turn.',
  parameters: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The first words of the message, verbatim' },
            fromUser: { type: 'boolean', description: 'true for a user message, false for your own answer' },
          },
          required: ['text', 'fromUser'],
        },
      },
    },
    required: ['messages'],
  },
};

/**
 * Progressive disclosure: the system prompt names the deferred tools, this
 * returns their descriptions, and from the next step on their full schemas are
 * offered. Loading changes the tool block, so it costs one prefix-cache miss.
 */
export const LOAD_TOOLS_TOOL: ToolSpec = {
  name: 'load_tools',
  description: 'Load tools listed in the system prompt as "load before use" so you can call them. Returns what each does.',
  parameters: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names to load' } },
    required: ['names'],
  },
};

/** The builtin a model reaches for when it thinks a tool is missing. */
const REQUEST_TOOL_NAME = 'request_tool';

/**
 * Tool names loaded so far. load_tools is a convenience, not a gate: a tool
 * also counts as loaded once it was asked for with request_tool or simply
 * called by name — small models skip the load step, and should not be punished.
 */
export function loadedToolNames(history: readonly ChatMessage[]): Set<string> {
  const loaded = new Set<string>();
  for (const message of history) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function.name;
      const args = parseToolArguments(call.function.arguments);
      if (name === LOAD_TOOLS_TOOL.name) {
        const names = args?.names;
        if (Array.isArray(names)) for (const n of names) if (typeof n === 'string') loaded.add(n);
      } else if (name === REQUEST_TOOL_NAME) {
        if (typeof args?.name === 'string') loaded.add(args.name.trim());
      } else {
        loaded.add(name);
      }
    }
  }
  return loaded;
}

/** The tools offered this step: the always-on set, load_tools, and whatever has been loaded. */
function offeredTools(params: AgentTurnParams, history: readonly ChatMessage[]): ToolSpec[] {
  const deferred = params.deferredTools ?? [];
  if (!deferred.length) return params.tools;
  const loaded = loadedToolNames(history);
  return [...params.tools, LOAD_TOOLS_TOOL, ...deferred.filter((tool) => loaded.has(tool.name))];
}

function describeLoaded(deferred: readonly ToolSpec[], names: unknown): string {
  if (!Array.isArray(names) || !names.length) return 'Error: names must be a non-empty array of tool names';
  return names.map((name) => {
    const tool = deferred.find((t) => t.name === name);
    return tool ? `${tool.name} — loaded. ${tool.description}` : `${String(name)} — not available`;
  }).join('\n');
}

/** Tools whose calls in one step may run concurrently (each subagent is its own session). */
const PARALLEL_TOOLS = new Set(['Agent']);

/**
 * A subagent batch is a journey by definition: the loop checkpoints before it,
 * so the model can use the results, then roll the whole batch out of context.
 */
const AUTO_CHECKPOINT_TOOLS = new Set(['Agent']);

/** Arguments arrive as a JSON string; a model that emits junk gets `{}` and an error result, not a crash. */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Windows-1252's 0x80–0x9F block: the characters UTF-8 continuation bytes turn into when misread as cp1252. */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
/** A UTF-8 lead byte (Â–ô) misread as cp1252/latin-1, followed by a misread continuation byte. */
const MOJIBAKE_RE = /[Â-ô][\u0080-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/;
/** C0/C1 controls except tab and newline, plus the replacement character. */
const JUNK_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F�]/g;

/**
 * Clean model text before anyone sees it (terminal, chat, history). Local
 * models behind some servers emit UTF-8 decoded as cp1252 ("donâ€™t" for
 * "don't"): when the text looks like that, re-encode it to bytes and decode as
 * UTF-8 — kept only if the result is clean. Then drop stray control chars and
 * U+FFFD, which no reader can use.
 */
export function cleanModelText(text: string): string {
  let out = text;
  if (MOJIBAKE_RE.test(out)) {
    const bytes: number[] = [];
    let encodable = true;
    for (const ch of out) {
      const code = ch.codePointAt(0)!;
      const high = CP1252_HIGH.indexOf(ch);
      if (high >= 0 && code > 0xff) bytes.push(0x80 + high);
      else if (code <= 0xff) bytes.push(code);
      else { encodable = false; break; }
    }
    if (encodable) {
      const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      if (!decoded.includes('�')) out = decoded;
    }
  }
  return out.replace(/\r\n?/g, '\n').replace(JUNK_RE, '');
}

export async function runAgentTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
  const maxRounds = params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const history: ChatMessage[] = [...params.history, { role: 'user', content: params.userContent }];
  const toolsUsed: string[] = [];
  let contextTokens: number | undefined;

  for (let round = 0; ; round++) {
    // On the last allowed round, offer no tools: the model must answer in text.
    const offerTools = round < maxRounds ? offeredTools(params, history) : [];
    const { message, usage } = await params.client.complete(
      [{ role: 'system', content: params.system }, ...history],
      offerTools,
      params.signal,
    );
    contextTokens = contextSize(usage) ?? contextTokens;
    if (message.reasoning_content) params.onEvent?.({ type: 'reasoning', text: cleanModelText(message.reasoning_content) });
    const text = cleanModelText(message.content ?? '');
    const calls = offerTools.length ? message.tool_calls ?? [] : [];
    history.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    const stepStart = history.length - 1;
    if (text) params.onEvent?.({ type: 'text', text });
    if (calls.length === 0) return { history, finalText: text, toolsUsed, ...(contextTokens !== undefined ? { contextTokens } : {}) };

    // A rollback rewinds the conversation instead of answering: the assistant
    // message that asked for it (and everything since the checkpoint) is cut.
    const rollback = calls.find((call) => call.function.name === ROLLBACK_TOOL.name);
    if (rollback && params.checkpoints) {
      const args = parseToolArguments(rollback.function.arguments) ?? {};
      const label = typeof args.label === 'string' ? args.label : '';
      const mark = params.checkpoints.get(label);
      if (mark !== undefined && mark < history.length) {
        const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : '(no note)';
        const dropped = history.length - mark;
        history.splice(mark);
        for (const [name, index] of params.checkpoints) if (index > mark) params.checkpoints.delete(name);
        toolsUsed.push(ROLLBACK_TOOL.name);
        params.onEvent?.({ type: 'rollback', label, dropped });
        history.push({ role: 'user', content: `[Rolled back to checkpoint "${label}". Your note: ${note}]` });
        continue;
      }
    }

    const run = async (call: ToolCall): Promise<string> => {
      const name = call.function.name;
      const args = parseToolArguments(call.function.arguments);
      toolsUsed.push(name);
      params.onEvent?.({ type: 'tool_call', name, args: args ?? {} });
      if (!args) return `Error: arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`;
      if (name === LOAD_TOOLS_TOOL.name) return describeLoaded(params.deferredTools ?? [], args.names);
      // Asking for a tool it already has: hand it over instead of filing a request with the user.
      const requested = name === REQUEST_TOOL_NAME && typeof args.name === 'string' ? args.name.trim() : '';
      if (requested && params.deferredTools?.some((tool) => tool.name === requested)) {
        return `You already have it. ${describeLoaded(params.deferredTools, [requested])} Call it now.`;
      }
      if (name === CHECKPOINT_TOOL.name && params.checkpoints) {
        const label = typeof args.label === 'string' ? args.label.trim() : '';
        if (!label) return 'Error: label is required';
        // The mark sits BEFORE this step's assistant message, so a rollback removes the call too.
        params.checkpoints.set(label, stepStart);
        return `Checkpoint "${label}" set. rollback(label, note) returns here.`;
      }
      if (name === ROLLBACK_TOOL.name) return 'Error: no such checkpoint — set one with checkpoint first';
      try {
        const result = await params.executeTool(name, args);
        if (!AUTO_CHECKPOINT_TOOLS.has(name) || !params.checkpoints) return result;
        const label = `agents-${stepStart}`;
        params.checkpoints.set(label, stepStart);
        return `${result}\n\n[Checkpoint "${label}" was set before this batch. Once you have used these results, `
          + `rollback("${label}", note) with the memory ids you still need, to free your context.]`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    // Parallel only when the step is purely read-only fan-out (subagents);
    // anything else runs in order, since a later call may depend on an earlier edit.
    const parallel = calls.length > 1 && calls.every((call) => PARALLEL_TOOLS.has(call.function.name));
    const results = parallel ? await Promise.all(calls.map(run)) : [];
    for (const [i, call] of calls.entries()) {
      const result = parallel ? results[i] : await run(call);
      params.onEvent?.({ type: 'tool_result', name: call.function.name, result });
      history.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    // After the LAST pending tool result, never between a call and its result:
    // the API requires every tool call to be answered before a new user turn.
    const injected = params.takeInjected?.();
    if (injected) history.push({ role: 'user', content: injected });
  }
}

/** OpenAI-compatible chat-completions client (llama-server, LM Studio, OpenRouter, ...). */
export function createOpenAiChatClient(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sampling temperature; omitted from the request when unset so the server default applies. */
  temperature?: number;
  fetchImpl?: typeof fetch;
}): ChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async complete(messages, tools, signal) {
      // Streamed so slow local models (long first prefill) never hit undici's ~300 s headers/body timeout.
      const body: Record<string, unknown> = { model: options.model, messages, stream: true, stream_options: { include_usage: true } };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (tools.length) {
        body.tools = tools.map((tool) => ({ type: 'function', function: tool }));
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        // Server ignored stream:true and replied with a plain completion.
        const json = await response.json() as {
          choices?: Array<{ message?: CompletionResult['message']; finish_reason?: string }>;
          usage?: CompletionUsage;
        };
        const choice = json.choices?.[0];
        if (!choice?.message) throw new Error('API returned no choices');
        return { message: choice.message, finishReason: choice.finish_reason, ...(json.usage ? { usage: json.usage } : {}) };
      }
      return readCompletionStream(response);
    },
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: CompletionUsage | null;
}

/** Folds an OpenAI SSE chat-completion stream into one CompletionResult. */
async function readCompletionStream(response: Response): Promise<CompletionResult> {
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let usage: CompletionUsage | undefined;
  const calls: ToolCall[] = [];

  const apply = (chunk: StreamChunk): void => {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (delta.content) content += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  const flushLines = (final: boolean): void => {
    const lines = buffer.split('\n');
    buffer = final ? '' : lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') apply(JSON.parse(data) as StreamChunk);
    }
  };
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    flushLines(false);
  }
  buffer += decoder.decode();
  flushLines(true);

  const toolCalls = calls.filter(Boolean);
  if (!content && !reasoning && !toolCalls.length) throw new Error('API returned no choices');
  return {
    message: {
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    },
    finishReason,
    ...(usage ? { usage } : {}),
  };
}
