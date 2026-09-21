/**
 * HookInstaller — install, update and remove Helm's hooks in each CLI's own
 * user-level config, system-wide, once per CLI (not per session).
 *
 * The FIRST code in Helm that writes to a directory Helm does not own
 * (~/.claude, ~/.codex, ~/.copilot). It is the user's own CLI config, not the
 * repo working tree — but the courtesy is the same: Helm writes ONE owned
 * block and never touches the rest. Helm-owned entries are identified by the
 * shim path inside their command, not by a marker field, so nothing depends
 * on the CLIs tolerating unknown keys.
 *
 * Python is NOT guaranteed on an end user's machine (Helm ships as a packaged
 * EXE). The installer probes for a working interpreter first: found → install;
 * not found → install NOTHING. A hook config pointing at an interpreter that
 * isn't there is a feature that silently does nothing, which is worse than
 * one that visibly refused.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { CliHooksIntegration } from '../../config/loader.js';
import type { HookProvider } from './hook-normaliser.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

export type HookIntegrationStatus = 'installed' | 'outdated' | 'not-installed' | 'interpreter-missing';

export interface ResolvedInterpreter {
  command: string;
  args: string[];
}

export interface HookInstallerDeps {
  homeDir(): string;
  shimPath: string;
  /**
   * Runs `<command> <args> --version`. Injectable so tests fake the probe
   * instead of the filesystem — the writes themselves are always real.
   */
  runCommand?(command: string, args: string[]): Promise<{ code: number }>;
}

export interface HookInstallResult {
  status: HookIntegrationStatus;
  written: boolean;
}

export interface HookUninstallResult {
  changed: boolean;
}

/** Probe order: PATH pythons first, then the Windows launcher. */
const INTERPRETER_CANDIDATES: ResolvedInterpreter[] = [
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
  { command: 'py', args: ['-3'] },
];

async function defaultRunCommand(command: string, args: string[]): Promise<{ code: number }> {
  try {
    await execFileAsync(command, [...args, '--version'], { timeout: 8_000 });
    return { code: 0 };
  } catch (error) {
    // A non-zero exit surfaces as error.code; ENOENT means no such command.
    const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 1;
    return { code };
  }
}

/** Resolve a working interpreter, or null when none of the candidates runs. */
export async function probeInterpreter(deps: HookInstallerDeps): Promise<ResolvedInterpreter | null> {
  const run = deps.runCommand ?? defaultRunCommand;
  for (const candidate of INTERPRETER_CANDIDATES) {
    try {
      const { code } = await run(candidate.command, candidate.args);
      if (code === 0) return candidate;
    } catch {
      // Candidate unusable on this machine — try the next.
    }
  }
  return null;
}

/**
 * One hook command line: interpreter, shim, provider, event.
 *
 * A part is quoted ONLY when it contains whitespace. Codex spawns hook
 * commands with no shell quote handling, so a quoted program name
 * (`"python" …`) fails to spawn outright — "Hook failed, exit 1" on every
 * event, all hook features silently dead. Claude Code and Copilot shell out
 * (cmd /C), where the quotes work when a path demands them.
 */
function hookCommand(deps: HookInstallerDeps, interpreter: ResolvedInterpreter, provider: HookProvider, event: string): string {
  const parts = [interpreter.command, ...interpreter.args, deps.shimPath, provider, event];
  const spaced = parts.some((part) => /\s/.test(part));
  if (spaced && provider === 'codex') {
    // Even quoted, codex cannot run this command — say so instead of
    // installing a hook that fails invisibly.
    logger.warn(
      `[HookInstaller] Shim path contains spaces and codex cannot spawn quoted hook programs — ${provider} hooks will fail until the shim lives at a space-free path: ${deps.shimPath}`,
    );
  }
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

/** The matcher-group shape Claude's and Codex's nested config expects. */
function desiredGroup(command: string): Record<string, unknown> {
  return { matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] };
}

/** The flat entry shape Copilot's hooks files expect. */
function desiredCopilotEntry(command: string): Record<string, unknown> {
  return { type: 'command', command, timeoutSec: 10 };
}

function isCopilot(hooks: CliHooksIntegration): boolean {
  return hooks.provider === 'copilot';
}

function resolveConfigFile(hooks: CliHooksIntegration, deps: HookInstallerDeps): string {
  const relative = hooks.configPath.replace(/^~[\\/]/, '');
  return path.join(deps.homeDir(), ...relative.split(/[\\/]/));
}

type JsonRecord = Record<string, unknown>;

function readConfigFile(file: string): JsonRecord | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Hook config file is not a JSON object: ${file}`);
  }
  return parsed as JsonRecord;
}

function writeConfigFile(file: string, obj: JsonRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** A nested matcher-group is ours when any of its handlers runs our shim. */
function isOurGroup(group: unknown, shimPath: string): boolean {
  if (!group || typeof group !== 'object') return false;
  const handlers = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some(
    (handler) =>
      !!handler &&
      typeof handler === 'object' &&
      typeof (handler as { command?: unknown }).command === 'string' &&
      ((handler as { command: string }).command as string).includes(shimPath),
  );
}

/** A flat Copilot entry is ours when its command runs our shim. */
function isOurEntry(entry: unknown, shimPath: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const command = (entry as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(shimPath);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Install or update Helm's hook block. Idempotent: an already-current file is
 * left untouched (written=false). Never installs without a working interpreter.
 */
export async function installCliHooks(hooks: CliHooksIntegration, deps: HookInstallerDeps): Promise<HookInstallResult> {
  const interpreter = await probeInterpreter(deps);
  if (!interpreter) {
    logger.warn(`[HookInstaller] No Python interpreter found — installing nothing for ${hooks.provider}`);
    return { status: 'interpreter-missing', written: false };
  }

  const file = resolveConfigFile(hooks, deps);
  const obj = readConfigFile(file) ?? {};
  const hooksBlock = (obj.hooks as JsonRecord | undefined) ?? {};
  obj.hooks = hooksBlock;
  if (isCopilot(hooks) && obj.version === undefined) obj.version = 1;

  let changed = false;
  for (const event of hooks.events) {
    const command = hookCommand(deps, interpreter, hooks.provider, event);
    const desired = isCopilot(hooks) ? desiredCopilotEntry(command) : desiredGroup(command);
    const existing = Array.isArray(hooksBlock[event]) ? (hooksBlock[event] as unknown[]) : [];
    const isOurs = isCopilot(hooks) ? isOurEntry : isOurGroup;
    const ours = existing.filter((entry) => isOurs(entry, deps.shimPath));
    const kept = existing.filter((entry) => !isOurs(entry, deps.shimPath));
    // Already current: exactly our desired entry and nothing stale of ours.
    if (ours.length === 1 && sameJson(ours[0], desired)) continue;
    hooksBlock[event] = [...kept, desired];
    changed = true;
  }

  if (!changed) return { status: 'installed', written: false };
  writeConfigFile(file, obj);
  logger.info(`[HookInstaller] Installed ${hooks.provider} hooks for ${hooks.events.length} events in ${file}`);
  return { status: 'installed', written: true };
}

/** Remove Helm's hook block and ONLY that block. Never throws on a clean state. */
export function uninstallCliHooks(hooks: CliHooksIntegration, deps: HookInstallerDeps): HookUninstallResult {
  const file = resolveConfigFile(hooks, deps);
  const obj = readConfigFile(file);
  if (!obj) return { changed: false };
  const hooksBlock = obj.hooks;
  if (!hooksBlock || typeof hooksBlock !== 'object' || Array.isArray(hooksBlock)) return { changed: false };

  const isOurs = isCopilot(hooks) ? isOurEntry : isOurGroup;
  let changed = false;
  for (const event of Object.keys(hooksBlock as JsonRecord)) {
    const existing = (hooksBlock as JsonRecord)[event];
    if (!Array.isArray(existing)) continue;
    const kept = existing.filter((entry) => !isOurs(entry, deps.shimPath));
    if (kept.length === existing.length) continue;
    changed = true;
    if (kept.length === 0) delete (hooksBlock as JsonRecord)[event];
    else (hooksBlock as JsonRecord)[event] = kept;
  }
  if (!changed) return { changed: false };

  if (Object.keys(hooksBlock as JsonRecord).length === 0) delete obj.hooks;

  // The Helm-owned Copilot file goes away entirely only when it holds nothing
  // of the user's — an empty `hooks` plus the version stamp is pure residue.
  if (isCopilot(hooks) && obj.hooks === undefined && Object.keys(obj).every((key) => key === 'version' || key === 'hooks')) {
    // The Helm-owned file holds nothing of the user's — take the whole file.
    unlinkSync(file);
    logger.info(`[HookInstaller] Removed the Helm-owned hook file ${file}`);
    return { changed: true };
  }

  writeConfigFile(file, obj);
  logger.info(`[HookInstaller] Removed Helm hooks from ${file}`);
  return { changed: true };
}

/**
 * Read the install state off DISK (never a stored flag), with the interpreter
 * probe ahead of file state: a missing interpreter is shown, not hidden, even
 * when a stale block is still on disk.
 */
export async function readHookIntegrationStatus(
  hooks: CliHooksIntegration,
  deps: HookInstallerDeps,
): Promise<HookIntegrationStatus> {
  const interpreter = await probeInterpreter(deps);
  if (!interpreter) return 'interpreter-missing';

  const file = resolveConfigFile(hooks, deps);
  const obj = readConfigFile(file);
  const hooksBlock = obj?.hooks;
  if (!hooksBlock || typeof hooksBlock !== 'object' || Array.isArray(hooksBlock)) return 'not-installed';

  const isOurs = isCopilot(hooks) ? isOurEntry : isOurGroup;
  let foundAny = false;
  let complete = true;
  for (const event of hooks.events) {
    const existing = Array.isArray((hooksBlock as JsonRecord)[event]) ? ((hooksBlock as JsonRecord)[event] as unknown[]) : [];
    const ours = existing.filter((entry) => isOurs(entry, deps.shimPath));
    if (ours.length === 0) {
      // A registered event with no Helm entry on disk: a partial (or trimmed)
      // install counts as outdated, never as installed.
      complete = false;
      continue;
    }
    foundAny = true;
    const command = hookCommand(deps, interpreter, hooks.provider, event);
    const desired = isCopilot(hooks) ? desiredCopilotEntry(command) : desiredGroup(command);
    if (!ours.some((entry) => sameJson(entry, desired))) complete = false;
  }
  if (!foundAny) return 'not-installed';
  return complete ? 'installed' : 'outdated';
}
