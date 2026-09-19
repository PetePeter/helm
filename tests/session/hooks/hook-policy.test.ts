/**
 * HookPolicy — G2's decision function: (HookEvent, SessionInfo, rules) -> Decision.
 *
 * PURE by contract: real HookEvent and SessionInfo objects in, decision out,
 * no I/O, no mocks. The two load-bearing properties tested here:
 * 1. FAIL OPEN — unknown tools, malformed rules, bad regexes, missing data all
 *    allow. A confused policy must never brick a session.
 * 2. Every deny carries a reason that NAMES the Helm alternative, because the
 *    reason is fed back to the model and redirects it.
 */

import { describe, expect, it } from 'vitest';
import { decideHookPolicy, type HookDenyRule } from '../../../src/session/hooks/hook-policy';
import type { HookEvent } from '../../../src/session/hooks/hook-normaliser';
import type { SessionInfo } from '../../../src/types/session';

/** Mirrors the denyRules defaults shipped in cli-types.yaml. */
const DEFAULT_RULES: HookDenyRule[] = [
  {
    tools: ['AskUserQuestion', 'ask_user', 'askUserQuestion'],
    onlyWhenAway: true,
    reason: 'The user is away from the desk (phone/Telegram). Ask them with the Helm MCP tool chat_send instead — it reaches their phone.',
  },
  {
    tools: ['Artifact', 'artifact'],
    reason: 'Helm owns artifacts for this session. Use the Helm MCP tool session_artifact_create instead.',
  },
  {
    tools: ['Bash', 'bash', 'shell', 'Shell'],
    commandPattern: '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\b|\\bgit\\s+push\\b',
    reason: 'Guardrail: this command is blocked for Helm-spawned sessions.',
  },
  {
    tools: ['Write', 'Edit', 'NotebookEdit', 'write', 'edit', 'apply_patch'],
    outsideSessionDir: true,
    reason: 'Writes are limited to the session working directory.',
  },
];

function preToolUse(patch: Partial<HookEvent> = {}): HookEvent {
  return {
    cli: 'claude',
    event: 'PreToolUse',
    helmSessionId: 'hs-1',
    receivedAt: 0,
    raw: {},
    ...patch,
  };
}

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 'hs-1', name: 'worker', cliType: 'claude-code', processId: 42, ...patch };
}

describe('decideHookPolicy — the away-from-desk deny', () => {
  it('denies AskUserQuestion when the user is on the phone, naming chat_send', () => {
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'AskUserQuestion' }),
      session({ interactionChannel: 'telegram' }),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('chat_send');
  });

  it('allows AskUserQuestion on a desktop session', () => {
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'AskUserQuestion' }),
      session({ interactionChannel: 'desktop' }),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('allow');
    expect(decision.reason).toBeUndefined();
  });

  it('allows AskUserQuestion when no channel was ever set (fresh desktop session)', () => {
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'AskUserQuestion' }),
      session(),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('allow');
  });

  it('allows AskUserQuestion when the session cannot be resolved', () => {
    const decision = decideHookPolicy(preToolUse({ toolName: 'AskUserQuestion' }), null, DEFAULT_RULES);

    expect(decision.decision).toBe('allow');
  });
});

describe('decideHookPolicy — the native artifact deny', () => {
  it('denies a native Artifact tool regardless of channel, naming session_artifact_create', () => {
    for (const channel of ['desktop', 'telegram', undefined] as const) {
      const decision = decideHookPolicy(
        preToolUse({ toolName: 'Artifact' }),
        session({ interactionChannel: channel }),
        DEFAULT_RULES,
      );

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('session_artifact_create');
    }
  });
});

describe('decideHookPolicy — command guardrails', () => {
  const bash = (command: string): HookEvent =>
    preToolUse({ toolName: 'Bash', toolInput: { command } });

  it('denies rm -rf in either flag order', () => {
    expect(decideHookPolicy(bash('rm -rf build'), session(), DEFAULT_RULES).decision).toBe('deny');
    expect(decideHookPolicy(bash('rm -fr build'), session(), DEFAULT_RULES).decision).toBe('deny');
    expect(decideHookPolicy(bash('sudo rm -rf /'), session(), DEFAULT_RULES).decision).toBe('deny');
  });

  it('denies git push', () => {
    expect(decideHookPolicy(bash('git push origin master'), session(), DEFAULT_RULES).decision).toBe('deny');
  });

  it('allows an innocent rm and an innocent git command', () => {
    expect(decideHookPolicy(bash('rm build/old.txt'), session(), DEFAULT_RULES).decision).toBe('allow');
    expect(decideHookPolicy(bash('git status'), session(), DEFAULT_RULES).decision).toBe('allow');
  });

  it('flags rm -rf even inside an echoed string — the pattern is coarse on purpose', () => {
    // A substring match over-matches ("echo rm -rf" is text about the command).
    // That is the safe direction for a guardrail: a false deny costs one
    // rephrase; a false allow costs the filesystem. Pinned here so the
    // conservatism is a decision, not an accident.
    expect(decideHookPolicy(bash('echo "never run rm -rf /"'), session(), DEFAULT_RULES).decision).toBe('deny');
  });

  it('reads the command from cmd and script aliases too', () => {
    expect(
      decideHookPolicy(preToolUse({ toolName: 'shell', toolInput: { cmd: 'git push' } }), session(), DEFAULT_RULES)
        .decision,
    ).toBe('deny');
    expect(
      decideHookPolicy(preToolUse({ toolName: 'shell', toolInput: { script: 'rm -rf x' } }), session(), DEFAULT_RULES)
        .decision,
    ).toBe('deny');
  });
});

describe('decideHookPolicy — writes outside the session directory', () => {
  const workingDir = process.platform === 'win32' ? 'C:\\repo' : '/repo';

  it('denies a write outside the session working directory', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\system32\\evil.dll' : '/etc/passwd';
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'Write', toolInput: { file_path: outside } }),
      session({ workingDir }),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('deny');
  });

  it('allows a write inside the session working directory', () => {
    const inside = process.platform === 'win32' ? 'C:\\repo\\src\\new.ts' : '/repo/src/new.ts';
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'Write', toolInput: { file_path: inside } }),
      session({ workingDir }),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('allow');
  });

  it('allows a relative write that resolves inside the session directory', () => {
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'Edit', cwd: workingDir, toolInput: { file_path: 'src/app.ts' } }),
      session({ workingDir }),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('allow');
  });

  it('fails open when neither session dir nor cwd is known', () => {
    const decision = decideHookPolicy(
      preToolUse({ toolName: 'Write', toolInput: { file_path: '/some/where.txt' } }),
      session(),
      DEFAULT_RULES,
    );

    expect(decision.decision).toBe('allow');
  });
});

describe('decideHookPolicy — fail open, always', () => {
  it('allows a tool no rule mentions', () => {
    expect(decideHookPolicy(preToolUse({ toolName: 'Grep' }), session(), DEFAULT_RULES).decision).toBe('allow');
  });

  it('allows everything when there are no rules', () => {
    expect(decideHookPolicy(preToolUse({ toolName: 'AskUserQuestion' }), session({ interactionChannel: 'telegram' }), []).decision).toBe('allow');
  });

  it('skips malformed rule objects rather than throwing', () => {
    const rules: unknown[] = [null, 'string', 42, {}, { tools: 'not-an-array', reason: 'x' }];

    expect(decideHookPolicy(preToolUse({ toolName: 'Bash' }), session(), rules).decision).toBe('allow');
  });

  it('treats an uncompilable commandPattern as non-matching, not as a crash', () => {
    const rules: HookDenyRule[] = [{ tools: ['Bash'], commandPattern: '([unclosed', reason: 'never fires' }];

    expect(decideHookPolicy(preToolUse({ toolName: 'Bash', toolInput: { command: 'ls' } }), session(), rules).decision).toBe('allow');
  });

  it('decides nothing for events other than PreToolUse', () => {
    for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const) {
      const decision = decideHookPolicy(
        preToolUse({ event, toolName: 'Artifact' }),
        session({ interactionChannel: 'telegram' }),
        DEFAULT_RULES,
      );
      expect(decision.decision).toBe('allow');
    }
  });

  it('matches tool names case-insensitively', () => {
    expect(
      decideHookPolicy(preToolUse({ toolName: 'askuserquestion' }), session({ interactionChannel: 'telegram' }), DEFAULT_RULES)
        .decision,
    ).toBe('deny');
  });
});

describe('decideHookPolicy — purity', () => {
  it('returns the same decision for the same inputs', () => {
    const event = preToolUse({ toolName: 'AskUserQuestion' });
    const info = session({ interactionChannel: 'telegram' });

    const first = decideHookPolicy(event, info, DEFAULT_RULES);
    const second = decideHookPolicy(event, info, DEFAULT_RULES);

    expect(second).toEqual(first);
  });
});
