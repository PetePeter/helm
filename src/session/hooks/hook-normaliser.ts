/**
 * HookNormaliser — collapse the three CLIs' hook payloads into ONE shape.
 *
 * The event NAME never comes from the payload: Helm wrote it into the hook
 * command's arguments when it installed the hook (`… shim.py <cli> <event>`),
 * so the shim forwards it explicitly. That keeps name extraction immune to
 * each CLI's field-naming whims (Copilot's camelCase payloads don't even carry
 * the name the same way).
 *
 * Only the COMMON CORE events — the ones all three CLIs support — are known
 * here. Anything else is G1 noise: the receiver logs and ignores it.
 */

/** The CLI families Helm can receive hooks from. */
export type HookProvider = 'claude' | 'codex' | 'copilot';

/** The common-core events shared by all three CLIs (canonical, PascalCase). */
export const CANONICAL_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  // Claude-only, but Helm registers it just for Claude: the turn died on an
  // API error (the usage-limit stall) reported as fact rather than guessed
  // from silence. Codex and Copilot never spell this event, so their
  // normalisation returns null and the timing fallback covers the case.
  'StopFailure',
] as const;

export type CanonicalHookEvent = (typeof CANONICAL_HOOK_EVENTS)[number];

/** What the shim POSTs: the envelope it built from argv, stdin and its env. */
export interface HookInboundBody {
  cli: string;
  event: string;
  payload: Record<string, unknown>;
}

/** The one shape every inbound hook becomes, whatever CLI sent it. */
export interface HookEvent {
  cli: HookProvider;
  event: CanonicalHookEvent;
  /** The Helm session the hook correlates to; null when uncorrelated. */
  helmSessionId: string | null;
  /** The CLI's own session id, when the payload carries one. */
  cliSessionId?: string;
  cwd?: string;
  toolName?: string;
  /** The tool's arguments object (tool_input / toolInput), when present. */
  toolInput?: Record<string, unknown>;
  prompt?: string;
  /** PreCompact only: "auto" (context filled) or "manual" (/compact command). */
  trigger?: string;
  receivedAt: number;
  /** The raw payload, kept for logging and future groups. */
  raw: Record<string, unknown>;
}

/** Copilot spells its events in camelCase; map them onto the canonical set. */
const COPILOT_EVENT_ALIASES: Record<string, CanonicalHookEvent> = {
  sessionStart: 'SessionStart',
  userPromptSubmitted: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  preCompact: 'PreCompact',
  agentStop: 'Stop',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
};

const CANONICAL_SET = new Set<string>(CANONICAL_HOOK_EVENTS);

function canonicalEventName(cli: HookProvider, event: string): CanonicalHookEvent | null {
  if (CANONICAL_SET.has(event)) return event as CanonicalHookEvent;
  if (cli === 'copilot') return COPILOT_EVENT_ALIASES[event] ?? null;
  return null;
}

/** Pick the first string value under any of the given keys (snake or camel). */
function str(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Pick the first object value under any of the given keys (snake or camel). */
function obj(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (!!value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Normalise one shim envelope into a HookEvent, or return null when the CLI
 * or event is not one Helm knows. Never throws: a malformed payload yields a
 * sparse event, not a failure — fail-open is the transport's contract.
 */
export function normaliseHookEvent(
  input: HookInboundBody,
  now: () => number = Date.now,
): HookEvent | null {
  const event = canonicalEventName(input.cli as HookProvider, input.event);
  if (input.cli !== 'claude' && input.cli !== 'codex' && input.cli !== 'copilot') return null;
  if (event === null) return null;
  // StopFailure is Claude's alone — the others never send it, and Helm only
  // registers it in Claude's config, so a stray one elsewhere is noise.
  if (event === 'StopFailure' && input.cli !== 'claude') return null;
  return {
    cli: input.cli,
    event,
    helmSessionId: null,
    cliSessionId: str(input.payload, ['session_id', 'sessionId']),
    cwd: str(input.payload, ['cwd']),
    toolName: str(input.payload, ['tool_name', 'toolName']),
    toolInput: obj(input.payload, ['tool_input', 'toolInput']),
    prompt: str(input.payload, ['prompt']),
    trigger: str(input.payload, ['trigger']),
    receivedAt: now(),
    raw: input.payload,
  };
}

/**
 * Wrap one deny decision in the wire shape the sending CLI's docs specify for
 * a PreToolUse reply. The decision is identical everywhere; only the envelope
 * differs. This is what /hooks returns as its body — the shim prints it on
 * stdout and the CLI reads its deny (and the reason) from there.
 */
export function encodeDenyResponse(event: HookEvent, reason: string): Record<string, unknown> {
  switch (event.cli) {
    case 'claude':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    case 'copilot':
      return { permissionDecision: 'deny', permissionDecisionReason: reason };
    case 'codex':
      // Codex's PreToolUse block form — the same shape its UserPromptSubmit
      // decision:"block" uses.
      return { decision: 'block', reason };
  }
}
