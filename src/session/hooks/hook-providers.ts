/**
 * The canonical hookable CLIs — owned by CODE, not by cli-types.yaml.
 *
 * The hooks block used to live on each CLI type entry, so a machine whose CLI
 * types are custom UUIDs (shipped defaults never overwrite an existing
 * config) lost its hook rows, its capability, and its deny-rule association.
 * The three user-level config paths and their event spellings are invariant
 * facts about the CLIs themselves, so they live here: the install/uninstall
 * surface is per PROVIDER and always shows exactly these three.
 *
 * Deny rules stay user-editable in cli-types.yaml `hooks.denyRules` — that is
 * policy, not transport, and policy is the user's to change.
 */

import type { HookProvider } from './hook-normaliser.js';

export interface HookProviderConfig {
  provider: HookProvider;
  label: string;
  /** User-level config file, `~`-relative, in the CLI's own config dir. */
  configPath: string;
  /** Event names registered, spelled the way this CLI spells them. */
  events: string[];
}

export const HOOK_PROVIDERS: HookProviderConfig[] = [
  {
    provider: 'claude',
    label: 'Claude Code',
    configPath: '~/.claude/settings.json',
    // StopFailure is Claude's alone — the turn died on an API error (the
    // usage-limit stall), reported as fact instead of guessed from silence.
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'StopFailure'],
  },
  {
    provider: 'codex',
    label: 'Codex',
    configPath: '~/.codex/hooks.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'],
  },
  {
    provider: 'copilot',
    label: 'GitHub Copilot CLI',
    configPath: '~/.copilot/hooks/helm.json',
    events: ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'preCompact', 'agentStop'],
  },
];

export function getHookProviderConfig(provider: string): HookProviderConfig | null {
  return HOOK_PROVIDERS.find((entry) => entry.provider === provider) ?? null;
}

/** The fields of a CLI type a provider can plausibly be inferred from.
 *  `provider: null` is an explicit "Not mapped" — evidence of absence, never re-inferred over. */
export interface CliProviderHint {
  provider?: HookProvider | null;
  displayName?: string;
  name?: string;
  spawnCommand?: string;
  resumeCommand?: string;
  continueCommand?: string;
  hooks?: { provider?: HookProvider };
}

const PROVIDER_WORDS: Array<[RegExp, HookProvider]> = [
  [/\bclaude\b/i, 'claude'],
  [/\bcodex\b/i, 'codex'],
  [/\bcopilot\b/i, 'copilot'],
];

/**
 * Which CLI family does this tool actually speak? The auto-migration feeds
 * this: an explicit setting (top-level `provider`, then the legacy hooks
 * block) is authoritative; otherwise name and commands are evidence, spelled
 * conservatively — word-boundary matches only, so "Claudia" or "codexify"
 * infer nothing. null = unmapped (a plain shell, or genuinely ambiguous).
 */
export function inferCliProvider(hint: CliProviderHint): HookProvider | null {
  if (hint.provider) return hint.provider;
  if (hint.hooks?.provider) return hint.hooks.provider;

  const label = `${hint.displayName ?? ''} ${hint.name ?? ''}`;
  for (const [pattern, provider] of PROVIDER_WORDS) {
    if (pattern.test(label)) return provider;
  }
  const commands = [hint.spawnCommand, hint.resumeCommand, hint.continueCommand]
    .filter((command): command is string => typeof command === 'string');
  for (const [pattern, provider] of PROVIDER_WORDS) {
    if (commands.some((command) => pattern.test(command))) return provider;
  }
  return null;
}
