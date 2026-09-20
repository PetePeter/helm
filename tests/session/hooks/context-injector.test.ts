/**
 * ContextInjector — G4's injection, nudge and one-shot stop decisions.
 *
 * Binding decisions under test (plan P-0785):
 * - SILENT when nothing to say: null, not "small"
 * - rules ride along with the envelope they govern, never on plain prompts
 * - Copilot's UserPromptSubmit is never answered (its CLI drops the output)
 * - nudges fire once per thing per session — nagging is the failure mode
 * - Stop nudge is capped at 1 and is NOT configurable; second Stop passes
 * - StopFailure is NEVER answered
 * - size-capped, deterministic, never mid-line
 *
 * Deps are plain functions over real-shaped data — no mocks beyond winston.
 */

import { describe, expect, it, vi } from 'vitest';
import { ContextInjector, type ContextInjectorDeps } from '../../../src/session/hooks/context-injector';
import type { HookEvent } from '../../../src/session/hooks/hook-normaliser';
import { SuggestionService } from '../../../src/session/hooks/suggestion-scorer';
import type { SessionInfo } from '../../../src/types/session';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    name: 'worker',
    cliType: 'claude-code',
    processId: 42,
    workingDir: 'x:/repo',
    aiagentState: 'implementing',
    ...patch,
  };
}

function hookEvent(patch: Partial<HookEvent> = {}): HookEvent {
  return {
    cli: 'claude',
    event: 'SessionStart',
    helmSessionId: 's1',
    receivedAt: 1,
    raw: {},
    ...patch,
  };
}

function makeInjector(overrides: Partial<ContextInjectorDeps> = {}, base: Partial<SessionInfo> = {}) {
  const calls: { suggest: Array<[string, string, string | null]> } = { suggest: [] };
  const deps: ContextInjectorDeps = {
    getSession: () => session(base),
    getClaimedPlan: () => null,
    getStartablePlans: () => [],
    getDrafts: () => [],
    getHandover: () => undefined,
    suggest: async (sessionId, prompt, projectId) => {
      calls.suggest.push([sessionId, prompt, projectId]);
      return null;
    },
    getProjectIdForDirectory: () => 'project-1',
    ...overrides,
  };
  return { injector: new ContextInjector(deps), deps, calls };
}

function contextOf(body: unknown): string {
  const nested = (body as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput;
  return (nested?.additionalContext ?? (body as { additionalContext?: string }).additionalContext) ?? '';
}

describe('SessionStart injection', () => {
  it('sends NOTHING when there is no plan, draft or handover', async () => {
    const { injector } = makeInjector();
    expect(await injector.respond(hookEvent())).toBeNull();
  });

  it('injects plan, drafts and handover in one additionalContext', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
      getDrafts: () => [{ label: 'apply next', text: 'run the lint pass first' }],
      getHandover: () => 'you were mid-checkpoint on the encoders',
    });
    const result = await injector.respond(hookEvent());
    const context = contextOf(result!.body);
    expect(context).toContain('Working plan: P-0785 "Hook G4" (coding)');
    expect(context).toContain('Draft memo "apply next": run the lint pass first');
    expect(context).toContain('Handover note');
    expect(context).toContain('mid-checkpoint');
  });

  it('truncates an oversized source deterministically and caps the whole payload', async () => {
    const { injector } = makeInjector({
      getDrafts: () => [1, 2, 3, 4].map((n) => ({ label: `big-${n}`, text: 'x'.repeat(5000) })),
    });
    const result = await injector.respond(hookEvent());
    const context = contextOf(result!.body);
    expect(context.length).toBeLessThanOrEqual(2500);
    for (const n of [1, 2, 3]) expect(context).toContain(`Draft memo "big-${n}"`);
    // Deterministic precedence: the draft is kept whole-at-cap, the handover
    // that no longer fits is dropped WHOLE — no half-cut lines.
    expect(context).not.toContain('big-4');
  });

  it('still injects for Copilot (flat shape) on SessionStart', async () => {
    const { injector } = makeInjector(
      { getClaimedPlan: () => ({ title: 'T', status: 'ready' }) },
      { cliType: 'copilot-cli' },
    );
    const result = await injector.respond(hookEvent({ cli: 'copilot', event: 'SessionStart' }));
    expect(result!.body).toEqual({ additionalContext: expect.stringContaining('Working plan') });
  });
});

describe('UserPromptSubmit', () => {
  it('sends NOTHING for a plain prompt with no hint and nothing outstanding', async () => {
    const { injector } = makeInjector();
    expect(await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'rename the variable' }))).toBeNull();
  });

  it('injects the rules for a [HELM_MSG] envelope', async () => {
    const { injector } = makeInjector();
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: '[HELM_MSG]{"type":"inter_llm_message"}do the thing' }),
    );
    const context = contextOf(result!.body);
    expect(context).toContain('[HELM_MSG_RULES]');
    expect(context).toContain('fromSessionId in the envelope');
    expect(context).not.toContain('telegram_chat');
  });

  it('injects the Telegram rules for a [HELM_TELEGRAM] envelope', async () => {
    const { injector } = makeInjector();
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: '[HELM_TELEGRAM from:u chat:1]\nhello\n[/HELM_TELEGRAM]' }),
    );
    const context = contextOf(result!.body);
    expect(context).toContain('[HELM_TELEGRAM_RULES]');
    expect(context).toContain('telegram_chat');
    expect(context).not.toContain('[HELM_MSG_RULES]');
  });

  it('appends the suggester pointer to the same payload', async () => {
    const { injector, calls } = makeInjector({
      suggest: async (sessionId, prompt, projectId) => {
        calls.suggest.push([sessionId, prompt, projectId]);
        return 'possibly related: skill/graphify';
      },
    });
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: 'turn this repo into a knowledge graph' }),
    );
    const context = contextOf(result!.body);
    expect(context).toBe('possibly related: skill/graphify');
    // Candidates pre-filtered by the session's project.
    expect(calls.suggest[0]).toEqual(['s1', 'turn this repo into a knowledge graph', 'project-1']);
  });

  it('passes the rules AND the pointer together for an envelope prompt', async () => {
    const { injector } = makeInjector({ suggest: async () => 'possibly related: memory/x' });
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: '[HELM_MSG]{"type":"inter_llm_message"}hi' }),
    );
    const context = contextOf(result!.body);
    expect(context).toContain('[HELM_MSG_RULES]');
    expect(context).toContain('possibly related: memory/x');
  });

  it('never answers a Copilot UserPromptSubmit — its CLI drops the output', async () => {
    const { injector } = makeInjector(
      { suggest: async () => 'possibly related: skill/graphify' },
      { cliType: 'copilot-cli' },
    );
    expect(
      await injector.respond(hookEvent({ cli: 'copilot', event: 'UserPromptSubmit', prompt: '[HELM_MSG]hi' })),
    ).toBeNull();
  });

  it('nudges an unset AIAGENT state exactly once', async () => {
    const { injector } = makeInjector({}, { aiagentState: undefined });
    const first = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'do something' }));
    expect(contextOf(first!.body)).toContain('AIAGENT state is unset');
    const second = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'do more' }));
    expect(second).toBeNull(); // silent afterwards — nagging is the failure mode
  });

  it('nudges a startable plan once, and never while one is claimed', async () => {
    const startable = [{ humanId: 'P-0090', title: 'Later thing', status: 'ready' }];
    const { injector } = makeInjector({ getStartablePlans: () => startable });
    const first = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'hmm what next' }));
    const context = contextOf(first!.body);
    expect(context).toContain('Startable plan here: P-0090 "Later thing"');
    expect(context).toContain('session_plan_claim');
    expect(await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'hmm what next' }))).toBeNull();
  });

  it('does not nudge startable plans when the session has one claimed', async () => {
    const { injector } = makeInjector({
      getStartablePlans: () => [{ humanId: 'P-0090', title: 'Later thing', status: 'ready' }],
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Mine', status: 'coding' }),
    });
    expect(await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'working' }))).toBeNull();
  });

  it('drives the real SuggestionService through the scorer seam (fake scorer)', async () => {
    // The interface holds end to end: the injector only knows suggest(),
    // the service only knows score(), the fake scorer stands in for BM25.
    const service = new SuggestionService({
      getCandidates: () => [{ type: 'skill', id: 'graphify', name: 'graphify', description: 'knowledge graphs' }],
      scorer: {
        async score(_prompt, candidates) {
          return candidates.map((candidate) => ({ ...candidate, score: 10 }));
        },
      },
    });
    const { injector } = makeInjector({ suggest: (sid, prompt, pid) => service.suggest(sid, prompt, pid) });
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: 'build me a knowledge graph thing' }),
    );
    expect(contextOf(result!.body)).toBe('possibly related: skill/graphify');
  });
});

describe('Stop — the one-shot nudge', () => {
  it('blocks ONCE when a claimed plan is still open; the second Stop always passes', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    const first = await injector.respond(hookEvent({ event: 'Stop' }));
    expect(first!.body).toEqual({
      decision: 'block',
      reason: expect.stringContaining('P-0785 "Hook G4" still claimed and open'),
    });
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
  });

  it('allows a Stop straight away when nothing is outstanding', async () => {
    const { injector } = makeInjector();
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
  });

  it('blocks once for an unset AIAGENT state alone', async () => {
    const { injector } = makeInjector({}, { aiagentState: undefined });
    const first = await injector.respond(hookEvent({ event: 'Stop' }));
    expect(contextOf(first!.body) ?? '').toBe('');
    expect((first!.body as { reason: string }).reason).toContain('session_set_aiagent_state');
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
  });

  it('NEVER answers StopFailure — a died turn is not something to retry', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    expect(await injector.respond(hookEvent({ event: 'StopFailure' }))).toBeNull();
    expect(await injector.respond(hookEvent({ event: 'StopFailure' }))).toBeNull();
  });

  it('says nothing for an uncorrelated hook', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    expect(await injector.respond(hookEvent({ event: 'Stop', helmSessionId: null }))).toBeNull();
    expect(await injector.respond(hookEvent({ event: 'SessionStart', helmSessionId: null }))).toBeNull();
  });

  it('forgets a session with its ledgers', async () => {
    const { injector } = makeInjector(
      { getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }) },
    );
    expect((await injector.respond(hookEvent({ event: 'Stop' })))!.body).toHaveProperty('decision', 'block');
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
    injector.forgetSession('s1');
    // A (re)started session may be nudged again — the ledger died with it.
    expect((await injector.respond(hookEvent({ event: 'Stop' })))!.body).toHaveProperty('decision', 'block');
  });
});
