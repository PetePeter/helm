import * as path from 'path';

export interface SpawnConfig {
  command: string;
  args: string[];
}

export interface EnvVarEntry {
  name: string;
  value: string;
  /** How to merge with existing process env. Default: 'replace'. */
  mode?: 'replace' | 'append' | 'prepend';
}

/**
 * Per-CLI mapping from Helm's three worker-control actions to the CLI's own
 * built-in commands, in sequence-parser syntax. A blank/absent value means the
 * action is unsupported and its MCP tool returns an error.
 */
export interface HelmActionMap {
  /** Reset/clear context. No parameters. Example: "/clear{Enter}". When blank, falls back to
   *  legacy clearCommand then '/clear' (unlike compact/export, clear is never "unsupported"). */
  clear?: string;
  /** Compact context. $instruction is replaced with the caller's focus. Example: "/compact $instruction{Enter}". */
  compact?: string;
  /** Export session detail to a file. $path is replaced with the caller-supplied path. Example: "/export $path{Enter}". */
  export?: string;
}

export type CliTypeOptions = {
  env?: EnvVarEntry[];
  renameCommand?: string;
  spawnCommand?: string;
  resumeCommand?: string;
  continueCommand?: string;
  helmPreambleForInterSession?: boolean;
  largeTextAsTempFile?: boolean;
  messReminders?: boolean;
  submitSuffix?: string;
  helmActions?: HelmActionMap;
};

export function parseCliArgs(argsText?: string): string[] {
  if (!argsText) return [];

  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}

/**
 * Resolve an array of EnvVarEntry into a flat env record.
 * Handles append/prepend by joining with the OS path delimiter.
 */
export function resolveEnvWithMode(
  entries: EnvVarEntry[],
  existingEnv: Record<string, string | undefined>,
  resolveValue: (raw: string) => string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.name.trim()) continue;
    const name = entry.name.trim();
    const value = resolveValue(entry.value);
    const mode = entry.mode ?? 'replace';
    if (mode === 'prepend') {
      const existing = existingEnv[name] ?? '';
      env[name] = value ? `${value}${path.delimiter}${existing}` : existing;
    } else if (mode === 'append') {
      const existing = existingEnv[name] ?? '';
      env[name] = value ? `${existing}${path.delimiter}${value}` : existing;
    } else {
      env[name] = value;
    }
  }
  return env;
}

export function isCliTypeOptions(value: unknown): value is CliTypeOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildLegacySpawnCommand(command: unknown, args: unknown): string {
  const commandText = typeof command === 'string' ? command.trim() : '';
  const argsText = typeof args === 'string' ? args.trim() : '';
  return [commandText, argsText].filter(Boolean).join(' ');
}

export function normalizeToolConfig(tool: any): boolean {
  if (!tool || typeof tool !== 'object') return false;

  let changed = false;

  if (typeof tool.initialPrompt === 'string') {
    tool.initialPrompt = tool.initialPrompt.trim()
      ? [{ label: 'Prompt', sequence: tool.initialPrompt }]
      : [];
    changed = true;
  } else if (tool.initialPrompt != null && !Array.isArray(tool.initialPrompt)) {
    tool.initialPrompt = [];
    changed = true;
  }

  if (tool.env != null) {
    const nextEnv = Array.isArray(tool.env)
      ? tool.env
        .map((entry: any) => ({
          name: typeof entry?.name === 'string' ? entry.name.trim() : '',
          value: typeof entry?.value === 'string' ? entry.value : '',
          ...(entry.mode === 'append' || entry.mode === 'prepend' ? { mode: entry.mode } : {}),
        }))
        .filter((entry: EnvVarEntry) => entry.name.length > 0)
      : [];
    if (JSON.stringify(nextEnv) !== JSON.stringify(tool.env)) {
      changed = true;
    }
    tool.env = nextEnv;
  }

  const legacySpawnCommand = buildLegacySpawnCommand(tool.command, tool.args);
  if (typeof tool.spawnCommand === 'string' && tool.spawnCommand.trim()) {
    if (tool.command !== undefined || tool.args !== undefined) {
      delete tool.command;
      delete tool.args;
      changed = true;
    }
  } else if (legacySpawnCommand) {
    tool.spawnCommand = legacySpawnCommand;
    delete tool.command;
    delete tool.args;
    changed = true;
  } else if (tool.command !== undefined || tool.args !== undefined) {
    delete tool.command;
    delete tool.args;
    changed = true;
  }

  return changed;
}

export function parseCommandTemplate(commandText?: string): SpawnConfig {
  const parts = parseCliArgs(commandText);
  if (parts.length === 0) {
    return { command: '', args: [] };
  }
  const [command, ...args] = parts;
  return { command, args };
}

export function normalizeMcpPort(value: unknown, fallbackPort = 47373): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallbackPort;
  }
  return parsed;
}

/** Coerce a value to a valid TCP port, defaulting to the fleet port. */
export function normalizeFleetPort(value: unknown, fallbackPort = 47474): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallbackPort;
  }
  return parsed;
}

/** Coerce a value to a valid TCP port, defaulting to the phone LAN port. */
export function normalizeMobileLanPort(value: unknown, fallbackPort = 47475): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallbackPort;
  }
  return parsed;
}

/** Derive a URL-safe slug from a display name */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

