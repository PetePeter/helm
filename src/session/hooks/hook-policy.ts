/**
 * HookPolicy — G2's decision function for PreToolUse.
 *
 * PURE: (HookEvent, SessionInfo, rules) -> Decision. No I/O, no clocks, no
 * lookups — everything it needs arrives as arguments, so it tests with real
 * objects and no mocks. The receiver owns all I/O (session lookup, rule
 * source) and catches anything that escapes: fail-open is the contract on
 * BOTH sides of this boundary, because a hook must never brick a session.
 *
 * The deny REASON is the feature, not an afterthought: the CLI feeds it back
 * to the model, so a reason that names the Helm alternative (chat_send,
 * session_artifact_create) redirects the agent instead of merely failing it.
 */

import * as path from 'node:path';
import type { SessionInfo } from '../../types/session.js';
import type { HookEvent } from './hook-normaliser.js';

/**
 * One deny rule, as shipped in cli-types.yaml under `hooks.denyRules`.
 * A rule denies only when EVERY present condition matches; absent conditions
 * don't constrain. Rules are user data, so the policy treats them as untrusted.
 */
export interface HookDenyRule {
  /** Tool names this rule applies to, compared case-insensitively. */
  tools: string[];
  /** Deny only while the user is away (interactionChannel === 'telegram'). */
  onlyWhenAway?: boolean;
  /** Deny only when the shell command matches this regex source. */
  commandPattern?: string;
  /** Deny only writes whose target resolves outside the session directory. */
  outsideSessionDir?: boolean;
  /** Fed back to the model — name the Helm alternative here. */
  reason: string;
}

export interface HookPolicyDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

const ALLOW: HookPolicyDecision = { decision: 'allow' };

/** Tool-input keys holding a shell command, in preference order. */
const COMMAND_KEYS = ['command', 'cmd', 'script'];
/** Tool-input keys holding a written file path, in preference order. */
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'notebook_path', 'notebookPath'];

/**
 * The decision. First matching rule wins; nothing matched — or anything
 * looking wrong along the way — means allow. Unknown events are none of the
 * policy's business (it speaks only on PreToolUse; other groups own the rest).
 */
export function decideHookPolicy(
  event: HookEvent,
  session: SessionInfo | null,
  rules: readonly unknown[],
): HookPolicyDecision {
  if (event.event !== 'PreToolUse') return ALLOW;
  for (const candidate of rules) {
    const rule = asDenyRule(candidate);
    if (!rule) continue;
    if (!matchesTool(rule, event.toolName)) continue;
    if (rule.onlyWhenAway && session?.interactionChannel !== 'telegram') continue;
    if (rule.commandPattern !== undefined && !matchesCommand(rule.commandPattern, event)) continue;
    if (rule.outsideSessionDir && !writesOutsideSessionDir(event, session)) continue;
    return { decision: 'deny', reason: rule.reason };
  }
  return ALLOW;
}

/** Coerce untrusted yaml into a rule, or null when the shape is wrong. */
function asDenyRule(value: unknown): HookDenyRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<HookDenyRule>;
  if (!Array.isArray(candidate.tools) || candidate.tools.length === 0) return null;
  if (typeof candidate.reason !== 'string' || candidate.reason.length === 0) return null;
  if (candidate.commandPattern !== undefined && typeof candidate.commandPattern !== 'string') return null;
  return candidate as HookDenyRule;
}

function matchesTool(rule: HookDenyRule, toolName: string | undefined): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return rule.tools.some((tool) => typeof tool === 'string' && tool.toLowerCase() === lower);
}

/**
 * Regex compile happens here, not at config load, so a bad pattern in user
 * yaml degrades to "never matches" instead of crashing anything. That is the
 * fail-open direction.
 */
function matchesCommand(patternSource: string, event: HookEvent): boolean {
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternSource, 'i');
  } catch {
    return false;
  }
  const command = toolString(event, COMMAND_KEYS);
  return command !== undefined && pattern.test(command);
}

/**
 * True when the event writes to a path that resolves outside the session's
 * directory. Relative targets resolve against the CLI's own cwd (that is how
 * the CLI will interpret them too). When neither a session dir nor a cwd is
 * known there is nothing to compare against — allow.
 */
function writesOutsideSessionDir(event: HookEvent, session: SessionInfo | null): boolean {
  const target = toolString(event, FILE_PATH_KEYS);
  if (!target) return false;
  const base = session?.workingDir ?? event.cwd;
  if (!base) return false;
  const resolvedTarget = path.resolve(event.cwd ?? base, target);
  const resolvedBase = path.resolve(base);
  return !isInside(resolvedBase, resolvedTarget);
}

function isInside(base: string, candidate: string): boolean {
  const rel = path.relative(normCase(base), normCase(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Windows paths compare case-insensitively; everywhere else, exactly. */
function normCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function toolString(event: HookEvent, keys: string[]): string | undefined {
  const input = event.toolInput;
  if (!input) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
