/**
 * Pure prompt/tool assembly for API-tool sessions.
 *
 * Cache-first ordering (see api-agent-loop.ts): everything here that goes into
 * the system prompt must be CONSTANT for the life of the session — identity,
 * tool rules, the skills directory, the user's extra instructions. Anything
 * that drifts (clock, cwd) belongs in `buildMutableContext`, which is
 * appended to the end of each new user message.
 */

import type { McpTool } from '../../mcp/tools/types.js';
import type { ToolSpec } from './api-agent-loop.js';
import { NATIVE_TOOLS } from './api-native-tools.js';

export type ApiToolSource = 'native' | 'helm';

export interface ApiToolCatalogEntry extends ToolSpec {
  source: ApiToolSource;
}

/** Every tool an API tool could be ticked for: native first, then Helm MCP. */
export function listAvailableApiTools(mcpTools: readonly McpTool[]): ApiToolCatalogEntry[] {
  return [
    ...NATIVE_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, source: 'native' as const })),
    ...mcpTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema, source: 'helm' as const })),
  ];
}

/**
 * The ticked subset, in catalog order (not tick order) so the tool block —
 * which sits in the cached prefix — is byte-stable however the ticks were made.
 */
export function selectApiTools(catalog: readonly ApiToolCatalogEntry[], allowed: readonly string[]): ApiToolCatalogEntry[] {
  const ticked = new Set(allowed);
  return catalog.filter((tool) => ticked.has(tool.name));
}

export interface SkillSummary {
  id: string;
  name: string;
  triggerCondition?: string;
}

export function buildSystemPrompt(params: {
  toolNames: readonly string[];
  skills: readonly SkillSummary[];
  extra?: string;
  platform?: string;
}): string {
  const has = (name: string) => params.toolNames.includes(name);
  const parts = [
    'You are a coding and assistant agent running inside Helm, a desktop session manager.',
    `Platform: ${params.platform ?? process.platform}.`,
    'Work step by step. Use tools to look things up instead of guessing; read a file before editing it.',
    'Keep answers short and direct. When the task is done, reply with the result in plain text.',
    'Just answer in plain text: Helm delivers your final reply to the user chat (desktop, phone, Telegram) automatically.',
    'A message starting with [from <session> (<id>)] comes from another Helm session; when it says "awaiting reply",',
    'your final answer is sent back to that session automatically.',
  ];
  if (params.skills.length && has('skill_get')) {
    parts.push(
      '',
      'Skills (reusable instructions). When one applies, call skill_get with its id and follow it:',
      ...params.skills.map((skill) => `- ${skill.id}: ${skill.name}${skill.triggerCondition ? ` — ${skill.triggerCondition}` : ''}`),
    );
  }
  if (params.extra?.trim()) parts.push('', params.extra.trim());
  return parts.join('\n');
}

export function buildMutableContext(params: {
  now: Date;
  cwd?: string;
  sessionId: string;
  sessionName: string;
}): string {
  const lines = [
    `<helm_context>`,
    `time: ${params.now.toISOString()}`,
    `session: ${params.sessionName} (${params.sessionId})`,
    ...(params.cwd ? [`working directory: ${params.cwd}`] : []),
    `</helm_context>`,
  ];
  return lines.join('\n');
}

/**
 * Always offered, never ticked: a wishlist for capabilities that do not exist
 * yet. Each call lands as feedback on the "API tool requests" skill and pings
 * the user, so missing tools surface where skill feedback is already reviewed.
 */
export const REQUEST_TOOL: ToolSpec = {
  name: 'request_tool',
  description: 'Ask the user for a tool you need but do not have (one that does not exist yet). '
    + 'Describe what it should do; then carry on as best you can without it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Suggested tool name, e.g. "HttpGet"' },
      purpose: { type: 'string', description: 'What it would do and why you need it now' },
      example: { type: 'string', description: 'Example arguments or usage (optional)' },
    },
    required: ['name', 'purpose'],
  },
};

/** One chat message of this session, as the chat_history tool sees it. */
export interface ChatHistoryEntry {
  seq: number;
  at: number;
  fromUser: boolean;
  text: string;
}

/**
 * Always offered: the session's own chat (desktop pane, phone, Telegram) read
 * back on demand — the user's messages and the replies — so what was said
 * survives forget_turns, rollback and compaction.
 */
export const CHAT_HISTORY_TOOL: ToolSpec = {
  name: 'chat_history',
  description: 'Read your chat with the user (their messages and your replies), newest last. '
    + 'Optionally filter with query (case-insensitive text or regex) and page back with before (a # from an earlier result).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Only messages matching this text or regex' },
      limit: { type: 'number', description: 'How many messages (default 20, max 100)' },
      before: { type: 'number', description: 'Only messages older than this #' },
    },
  },
};

const CHAT_HISTORY_DEFAULT = 20;
const CHAT_HISTORY_MAX = 100;

/** Filter, page and render chat entries for the model: `#seq time who: text`, oldest first. */
export function formatChatHistory(entries: readonly ChatHistoryEntry[], args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  let matcher: (text: string) => boolean = () => true;
  if (query) {
    try {
      const re = new RegExp(query, 'i');
      matcher = (text) => re.test(text);
    } catch {
      const needle = query.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(needle);
    }
  }
  const before = typeof args.before === 'number' ? args.before : Infinity;
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || CHAT_HISTORY_DEFAULT)), CHAT_HISTORY_MAX);
  const hits = entries.filter((e) => e.seq < before && matcher(e.text));
  const page = hits.slice(-limit);
  if (!page.length) return query ? `No chat messages match "${query}".` : 'No chat messages.';
  const lines = page.map((e) => `#${e.seq} ${new Date(e.at).toISOString().slice(0, 16)} ${e.fromUser ? 'user' : 'you'}: ${e.text}`);
  const older = hits.length - page.length;
  return older > 0 ? `${lines.join('\n')}\n(${older} older — pass before: ${page[0].seq})` : lines.join('\n');
}

/**
 * Who sent an inter-session message to an API tool. Other Helm sessions get
 * their text prefixed with this tag instead of the [HELM_MSG] envelope; when
 * the sender awaits a reply, Helm routes the turn's final answer back to it.
 */
export interface SenderTag {
  sessionId: string;
  sessionName: string;
  awaitingReply: boolean;
}

const SENDER_TAG_RE = /^\[from (.*) \(([^()\s]+)\)(, awaiting reply)?\] /;

export function formatSenderTag(tag: SenderTag): string {
  return `[from ${tag.sessionName} (${tag.sessionId})${tag.awaitingReply ? ', awaiting reply' : ''}] `;
}

export function parseSenderTag(input: string): SenderTag | null {
  const match = SENDER_TAG_RE.exec(input);
  return match ? { sessionName: match[1], sessionId: match[2], awaitingReply: Boolean(match[3]) } : null;
}

/**
 * Offered when the API tool allows subagents: hand self-contained tasks to
 * fresh sessions of the same API tool and get their answers back. One call is
 * one batch — the tasks run in parallel (up to the live cap), and the loop
 * checkpoints before it so the model can roll the batch back once used.
 */
export const AGENT_TOOL: ToolSpec = {
  name: 'Agent',
  description: 'Delegate self-contained tasks to subagents (fresh sessions with their own context), all at once in parallel. '
    + 'Each sees only its prompt, so include every detail it needs. Each result is saved as a memory; '
    + 'you get its summary and memory id.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'A 3-6 word label for the task' },
            prompt: { type: 'string', description: 'The full task, with all context the subagent needs' },
          },
          required: ['description', 'prompt'],
        },
      },
    },
    required: ['tasks'],
  },
};

/** The opening message of a subagent: who handed it over, the parent's goal, then the task. */
export function buildHandover(params: { parentName: string; mission?: string; description: string; prompt: string }): string {
  return [
    `Handover from ${params.parentName} — subagent task: ${params.description}`,
    ...(params.mission ? [`Parent mission: ${params.mission}`] : []),
    '',
    params.prompt,
    '',
    'Work the task with your tools, then reply with the result in plain text. Your reply is returned to the parent.',
  ].join('\n');
}

const CHAT_TOOLS = new Set(['chat_send', 'telegram_chat']);

/**
 * Chat tools. An API session's conversation IS its chat (desktop chat pane,
 * phone, Telegram), so Helm posts every final answer there itself — unless the
 * model already replied through one of these. A small model never has to
 * remember the chat_send ritual.
 */
export function isChatTool(name: string): boolean {
  return CHAT_TOOLS.has(name);
}

export const CHAT_LINE_LIMIT = 140;
export const CHAT_MESSAGE_LIMIT = 1600;

/** Word-wrap to the chat surfaces' line limit, then split into messages under the size limit. */
export function chunkForChat(text: string, lineLimit = CHAT_LINE_LIMIT, messageLimit = CHAT_MESSAGE_LIMIT): string[] {
  const lines: string[] = [];
  for (const raw of text.trim().split(/\r?\n/)) {
    let rest = raw.trimEnd();
    while (rest.length > lineLimit) {
      const cut = rest.lastIndexOf(' ', lineLimit);
      const at = cut > lineLimit / 2 ? cut : lineLimit;
      lines.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    }
    lines.push(rest);
  }
  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > messageLimit && current) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) messages.push(current);
  return messages;
}
