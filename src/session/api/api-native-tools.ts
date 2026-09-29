/**
 * Native tools for API-tool sessions — Helm's own small take on the core
 * Claude Code tool set. Names and argument shapes deliberately mirror Claude
 * Code (Read/Write/Edit/Glob/Grep) because models are trained on those
 * schemas; small local models call familiar tools far more reliably.
 *
 * Every tool resolves relative paths against the session's working directory
 * and returns plain text. A failure is returned as text too (never thrown):
 * the model reads the error and corrects itself, exactly as with a CLI.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface NativeToolContext {
  cwd: string;
  /** Aborts a running Shell command when the turn is cancelled. */
  signal?: AbortSignal;
}

export interface NativeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: NativeToolContext): Promise<string>;
}

/** Bound every tool result so one huge file cannot blow the context window. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;
const DEFAULT_READ_LINES = 2000;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release']);

export function truncateOutput(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function resolvePath(ctx: NativeToolContext, p: string): string {
  return path.resolve(ctx.cwd, p);
}

const read: NativeTool = {
  name: 'Read',
  description: 'Read a text file. Returns numbered lines. Use offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or working-dir-relative path' },
      offset: { type: 'number', description: '1-based first line (default 1)' },
      limit: { type: 'number', description: `Max lines (default ${DEFAULT_READ_LINES})` },
    },
    required: ['file_path'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx, str(args, 'file_path'));
    const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || DEFAULT_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) return `(no lines at offset ${offset}; file has ${lines.length} lines)`;
    return slice.map((line, i) => `${offset + i}\t${line}`).join('\n');
  },
};

const write: NativeTool = {
  name: 'Write',
  description: 'Create or overwrite a file with the given content. Creates parent folders.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx, str(args, 'file_path'));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, str(args, 'content'), 'utf8');
    return `Wrote ${file}`;
  },
};

const edit: NativeTool = {
  name: 'Edit',
  description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx, str(args, 'file_path'));
    const oldString = str(args, 'old_string');
    const newString = str(args, 'new_string');
    if (!oldString) return 'Error: old_string is empty';
    const content = await fs.promises.readFile(file, 'utf8');
    const count = content.split(oldString).length - 1;
    if (count === 0) return 'Error: old_string not found in file';
    if (count > 1 && args.replace_all !== true) {
      return `Error: old_string occurs ${count} times; add context to make it unique or set replace_all`;
    }
    // Unique, or replace_all: either way every occurrence is replaced.
    await fs.promises.writeFile(file, content.split(oldString).join(newString), 'utf8');
    return `Edited ${file} (${count} replacement${count === 1 ? '' : 's'})`;
  },
};

/** Walk a tree yielding forward-slash paths relative to root, skipping build/vcs dirs. */
async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(root, child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

/** Glob → RegExp over forward-slash relative paths: `**` spans dirs, `*`/`?` do not. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += `(?:${pattern.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
      i = end;
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const glob: NativeTool = {
  name: 'Glob',
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/*.md". Skips node_modules, .git and build output.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Folder to search (default: working dir)' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const root = resolvePath(ctx, str(args, 'path') || '.');
    const matcher = globToRegExp(str(args, 'pattern').replace(/\\/g, '/'));
    const hits: string[] = [];
    for await (const file of walk(root)) {
      if (matcher.test(file)) hits.push(file);
      if (hits.length >= MAX_LIST_ENTRIES) break;
    }
    if (hits.length === 0) return 'No files found';
    return hits.join('\n') + (hits.length >= MAX_LIST_ENTRIES ? `\n… (stopped at ${MAX_LIST_ENTRIES})` : '');
  },
};

const grep: NativeTool = {
  name: 'Grep',
  description: 'Search file contents with a regular expression. Returns path:line:text matches.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path: { type: 'string', description: 'File or folder (default: working dir)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts"' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(str(args, 'pattern'), args.ignore_case === true ? 'i' : '');
    } catch (err) {
      return `Error: invalid regex — ${(err as Error).message}`;
    }
    const target = resolvePath(ctx, str(args, 'path') || '.');
    const filter = str(args, 'glob') ? globToRegExp(str(args, 'glob').replace(/\\/g, '/')) : null;
    const stat = await fs.promises.stat(target);
    const root = stat.isDirectory() ? target : path.dirname(target);
    const files = stat.isDirectory() ? walk(root) : (async function* () { yield path.basename(target); })();
    const hits: string[] = [];
    for await (const file of files) {
      if (filter && !filter.test(file)) continue;
      let text: string;
      try {
        text = await fs.promises.readFile(path.join(root, file), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // binary
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_LIST_ENTRIES; i++) {
        if (regex.test(lines[i])) hits.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
      if (hits.length >= MAX_LIST_ENTRIES) break;
    }
    return hits.length ? hits.join('\n') : 'No matches';
  },
};

const shell: NativeTool = {
  name: 'Shell',
  description: process.platform === 'win32'
    ? 'Run a PowerShell command in the working directory. Returns stdout, stderr and exit code.'
    : 'Run a bash command in the working directory. Returns stdout, stderr and exit code.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'number', description: `Default ${DEFAULT_SHELL_TIMEOUT_MS}` },
    },
    required: ['command'],
  },
  run(args, ctx) {
    const command = str(args, 'command');
    const timeoutMs = Math.max(1000, Number(args.timeout_ms) || DEFAULT_SHELL_TIMEOUT_MS);
    const [file, argv] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
      : ['bash', ['-lc', command]];
    return new Promise((resolve) => {
      const child = spawn(file, argv, { cwd: ctx.cwd, windowsHide: true, signal: ctx.signal });
      let out = '';
      const collect = (chunk: Buffer) => { if (out.length < MAX_TOOL_OUTPUT_CHARS * 2) out += chunk.toString('utf8'); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); resolve(`Error: ${err.message}`); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(`${out.trimEnd()}\n[exit ${code ?? 'killed'}]`.trimStart());
      });
    });
  },
};

export const NATIVE_TOOLS: readonly NativeTool[] = [read, write, edit, glob, grep, shell];

export function getNativeTool(name: string): NativeTool | undefined {
  return NATIVE_TOOLS.find((tool) => tool.name === name);
}
