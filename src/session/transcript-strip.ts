/**
 * Reduce a CLI's JSONL conversation log to compact markdown a fresh session
 * can read back — the engine behind quick compact and CLI switch.
 *
 * Why strip rather than summarise: measured on a 157k-token Claude session,
 * stripping landed at 62k with full recall, while /compact (47–56k) and a
 * local-model fold (56k) both lost exact details. What goes is what a
 * successor never needs: thinking (only matters inside the turn that made
 * it), bulky tool output (re-readable from disk) and injected hook chatter.
 * What stays: every prompt, every reply, one line per tool call, and errors.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { SessionInfo } from '../types/session.js';
import { writeLargeTextTempFile } from './large-text-temp-file.js';
import { logger } from '../utils/logger.js';

const TOOL_ARGS_MAX = 200;
const ERROR_MAX = 300;

type Block = Record<string, unknown>;
type Line = Record<string, unknown>;

/** Injected wrappers a successor should never see as conversation. */
const NOISE_PREFIXES = ['<local-command', '<command-', '<environment_context', '<user_instructions', '<permissions'];

function cleanText(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function isNoise(text: string): boolean {
  return NOISE_PREFIXES.some(p => text.startsWith(p));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function toolLine(name: unknown, args: unknown): string {
  const argText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return `- tool: ${String(name)} ${clip(argText, TOOL_ARGS_MAX)}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof (b as Block)?.text === 'string' ? (b as Block).text : '')).join(' ');
}

function parse(jsonl: string): Line[] {
  const lines: Line[] = [];
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object') lines.push(value as Line);
    } catch {
      // A torn final line (log mid-write) or foreign noise — skip, never fail.
    }
  }
  return lines;
}

class MarkdownOut {
  private readonly parts: string[] = [];
  private role: string | null = null;

  add(role: 'User' | 'Assistant' | 'Earlier summary', text: string): void {
    if (!text) return;
    if (role !== this.role) {
      this.parts.push(`\n## ${role}\n`);
      this.role = role;
    }
    this.parts.push(text);
  }

  toString(): string {
    return this.parts.join('\n').trim() + '\n';
  }
}

function stripClaude(lines: Line[]): string {
  // Only what the model sees: everything after the last compaction boundary.
  let start = 0;
  lines.forEach((l, i) => {
    if (l.type === 'system' && l.subtype === 'compact_boundary') start = i + 1;
  });

  const out = new MarkdownOut();
  for (const l of lines.slice(start)) {
    if ((l.type !== 'user' && l.type !== 'assistant') || l.isMeta) continue;
    const content = (l.message as Block | undefined)?.content;

    if (l.type === 'user' && l.isCompactSummary) {
      out.add('Earlier summary', cleanText(resultText(content) || String(content ?? '')));
      continue;
    }
    if (typeof content === 'string') {
      const text = cleanText(content);
      if (!isNoise(text)) out.add(l.type === 'user' ? 'User' : 'Assistant', text);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content as Block[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = cleanText(block.text);
        if (!isNoise(text)) out.add(l.type === 'user' ? 'User' : 'Assistant', text);
      } else if (block.type === 'tool_use') {
        out.add('Assistant', toolLine(block.name, block.input));
      } else if (block.type === 'tool_result' && block.is_error) {
        out.add('Assistant', `- error: ${clip(resultText(block.content), ERROR_MAX)}`);
      }
    }
  }
  return out.toString();
}

function stripCodex(lines: Line[]): string {
  // Codex's `compacted` summary is encrypted, so unlike Claude and Copilot the
  // whole history is kept — the pre-compaction turns are the only readable record.
  const out = new MarkdownOut();
  // response_item is the canonical record; event_msg repeats it for the TUI.
  for (const l of lines) {
    if (l.type !== 'response_item') continue;
    const p = (l.payload ?? {}) as Block;

    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = cleanText(resultText(p.content));
      if (text && !isNoise(text)) out.add(p.role === 'user' ? 'User' : 'Assistant', text);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      out.add('Assistant', toolLine(p.name, p.arguments ?? p.input));
    }
  }
  return out.toString();
}

function stripCopilot(lines: Line[]): string {
  // Only what the model sees: everything after the last compaction, which carries its summary.
  let start = 0;
  let summary = '';
  lines.forEach((l, i) => {
    const d = (l.data ?? {}) as Block;
    if (l.type === 'session.compaction_complete' && d.success !== false) {
      start = i + 1;
      summary = typeof d.summaryContent === 'string' ? d.summaryContent.trim() : '';
    }
  });

  const out = new MarkdownOut();
  out.add('Earlier summary', summary);
  for (const l of lines.slice(start)) {
    const d = (l.data ?? {}) as Block;
    if (d.parentToolCallId) continue; // sub-agent chatter; the parent already logs the call
    if (l.type === 'user.message') {
      // content is what the user typed; transformedContent adds Copilot's injected context.
      out.add('User', cleanText(String(d.content ?? '')));
    } else if (l.type === 'assistant.message') {
      out.add('Assistant', cleanText(String(d.content ?? '')));
      for (const req of (Array.isArray(d.toolRequests) ? d.toolRequests : []) as Block[]) {
        out.add('Assistant', toolLine(req.name, req.arguments));
      }
    } else if (l.type === 'tool.execution_complete' && d.success === false) {
      out.add('Assistant', `- error: ${clip(String((d.error as Block | undefined)?.message ?? ''), ERROR_MAX)}`);
    }
  }
  return out.toString();
}

type TranscriptFormat = 'claude' | 'codex' | 'copilot';

function detectFormat(lines: Line[]): TranscriptFormat {
  if (lines.some(l => l.type === 'response_item' || l.type === 'session_meta')) return 'codex';
  if (lines.some(l => typeof l.type === 'string' && l.type.startsWith('session.'))) return 'copilot';
  return 'claude';
}

const STRIPPERS: Record<TranscriptFormat, (lines: Line[]) => string> = {
  claude: stripClaude,
  codex: stripCodex,
  copilot: stripCopilot,
};

/** Strip a Claude Code, Codex or Copilot CLI JSONL transcript to markdown. Format is auto-detected. */
export function stripTranscript(jsonl: string): string {
  const lines = parse(jsonl);
  return STRIPPERS[detectFormat(lines)](lines);
}

/**
 * Strip a session's hook-reported transcript into a Helm temp file.
 * Throws a caller-facing error when the log is unknown or unreadable: the
 * path only arrives through CLI hooks, so an unhooked session cannot do this.
 */
export function writeStrippedTranscript(session: Pick<SessionInfo, 'name' | 'cliTranscriptPath'>): string {
  const source = session.cliTranscriptPath;
  if (!source || !existsSync(source)) {
    logger.warn(`[TranscriptStrip] "${session.name}": no transcript (path=${source ?? 'unset'}, exists=${!!source && existsSync(source)})`);
    throw new Error(
      `No transcript known for "${session.name}". It comes from CLI hooks — install them ` +
        '(docs/cli-hooks.md) and let the session finish one turn, then retry.',
    );
  }
  // Logged in detail: a bad strip only shows up later, as a successor that forgot things.
  const started = Date.now();
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (err) {
    logger.error(`[TranscriptStrip] "${session.name}": reading ${source} failed: ${(err as Error).message}`);
    throw new Error(`Could not read the transcript for "${session.name}": ${(err as Error).message}`);
  }
  const lines = parse(raw);
  const format = detectFormat(lines);
  const md = STRIPPERS[format](lines);
  const file = writeLargeTextTempFile(md, 'transcript');
  const sections = (role: string) => md.split(`## ${role}
`).length - 1;
  logger.info(
    `[TranscriptStrip] "${session.name}": ${format} ${source} ` +
      `${raw.length} chars / ${lines.length} records → ${md.length} chars ` +
      `(compactions ${countCompactions(lines)}, user ${sections('User')}, assistant ${sections('Assistant')}, summary ${sections('Earlier summary')}) ` +
      `in ${Date.now() - started}ms → ${file}`,
  );
  if (md.trim().length === 0) {
    logger.warn(`[TranscriptStrip] "${session.name}": strip is EMPTY — unrecognised ${format} log shape? Record types: ` +
      JSON.stringify(countTypes(lines)));
  }
  return file;
}

function countCompactions(lines: Line[]): number {
  return lines.filter(
    l => l.type === 'compacted' || l.type === 'session.compaction_complete' || l.subtype === 'compact_boundary',
  ).length;
}

function countTypes(lines: Line[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of lines) {
    const key = String(l.type ?? '?');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The first prompt a cleared or freshly spawned session receives. */
export function buildTranscriptResumePrompt(transcriptFile: string, handover?: string): string {
  const note = handover?.trim();
  return [
    `Helm moved this conversation into a fresh context. The earlier conversation, stripped of`,
    `tool output and thinking, is at: ${transcriptFile}`,
    'Read that file in full first, then continue the work from where it left off.',
    ...(note ? ['', `Handover note: ${note}`] : []),
  ].join('\n');
}
