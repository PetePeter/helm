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
  prompt?: string;
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
  return {
    cli: input.cli,
    event,
    helmSessionId: null,
    cliSessionId: str(input.payload, ['session_id', 'sessionId']),
    cwd: str(input.payload, ['cwd']),
    toolName: str(input.payload, ['tool_name', 'toolName']),
    prompt: str(input.payload, ['prompt']),
    receivedAt: now(),
    raw: input.payload,
  };
}
