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
import type { SessionTodo } from '../../../src/types/todo';

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
  const value = body && typeof body === 'object' ? body as { hookSpecificOutput?: { additionalContext?: string }; additionalContext?: string } : {};
  const nested = value.hookSpecificOutput;
  return (nested?.additionalContext ?? value.additionalContext) ?? '';
}

describe('SessionStart injection', () => {
  it('reminds the OPERATOR of its pending ring-me requests', async () => {
    const { injector } = makeInjector(
      { getRingRequests: () => ['[RING-ME] call when P-0850 finishes'] },
      { role: 'operator' },
    );
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context).toContain('[RING-ME] call when P-0850 finishes');
    expect(context).toContain('ring_user');
  });

  it('never gives ring-me reminders to a non-operator session', async () => {
    const getRingRequests = vi.fn(() => ['[RING-ME] call when done']);
    const { injector } = makeInjector({ getRingRequests });
    expect(await injector.respond(hookEvent())).toBeNull();
    expect(getRingRequests).not.toHaveBeenCalled();
  });

  it('says nothing about ring-me when the operator has none pending', async () => {
    const { injector } = makeInjector({ getRingRequests: () => [] }, { role: 'operator' });
    expect(contextOf((await injector.respond(hookEvent()))!.body)).not.toContain('ring-me');
  });

  it('repeats the OPERATOR its mantra after every compaction, first in line', async () => {
    const { injector } = makeInjector({ getOpenTasks: () => ['P-0901 "build G"'] }, { role: 'operator' });
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context.startsWith('You are Helm, the operator')).toBe(true);
    expect(context).toContain('initialPrompt');
    expect(context).toContain('task');
  });

  it('re-lists the OPERATOR its open tasks so a compaction never drops one', async () => {
    const { injector } = makeInjector(
      { getOpenTasks: () => ['P-0901 "build G" (waiting on: coder finishes)'] },
      { role: 'operator' },
    );
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context).toContain('P-0901 "build G" (waiting on: coder finishes)');
    expect(context).toContain('plan_complete');
  });

  it('never lists operator tasks to a non-operator session', async () => {
    const getOpenTasks = vi.fn(() => ['P-0901 "build G"']);
    const { injector } = makeInjector({ getOpenTasks });
    expect(await injector.respond(hookEvent())).toBeNull();
    expect(getOpenTasks).not.toHaveBeenCalled();
  });

  it('sends NOTHING when there is no plan or handover', async () => {
    const { injector } = makeInjector();
    expect(await injector.respond(hookEvent())).toBeNull();
  });

  it('injects plan and handover in one additionalContext', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
      getHandover: () => 'you were mid-checkpoint on the encoders',
    });
    const result = await injector.respond(hookEvent());
    const context = contextOf(result!.body);
    expect(context).toContain('Working plan: P-0785 "Hook G4" (coding)');
    expect(context).toContain('Handover note');
    expect(context).toContain('mid-checkpoint');
  });

  it('includes every manifesto beside the one-shot handover, even above the ordinary context cap', async () => {
    const { injector } = makeInjector({
      getHandover: () => 'explicit next step',
      getManifestos: () => [
        { title: 'Rules', content: 'r'.repeat(1800) },
        { title: 'Decisions', content: 'all decisions are kept' },
      ],
    });
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context).toContain('explicit next step');
    expect(context).toContain('Persistent manifesto context');
    expect(context).toContain('## Rules');
    expect(context).toContain('## Decisions');
    expect(context).toContain('all decisions are kept');
  });

  it('truncates an oversized source deterministically and caps the whole payload', async () => {
    const big = 'x'.repeat(5000);
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-1', title: big, status: 'coding' }),
      getOpenTasks: () => [big],
      getRingRequests: () => [big],
      getHandover: () => big,
    }, { role: 'operator' });
    const result = await injector.respond(hookEvent());
    const context = contextOf(result!.body);
    expect(context.length).toBeLessThanOrEqual(2500);
    expect(context).toContain('Working plan: P-1');
    expect(context).toContain('Your open tasks');
    // Deterministic precedence: each source is cut at its own cap, and the
    // trailing one that no longer fits is dropped WHOLE — no half-cut lines.
    expect(context).not.toContain('Handover note');
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
  it('adds one ETA instruction beside the todo reminder', async () => {
    const { injector } = makeInjector({ getTodos: () => [] });
    const context = await injector.promptContext(
      's1',
      'Take on a multi-step task',
      new Set(['session_todo_add', 'session_eta_set']),
    );

    expect(context).toContain('[HELM_TODOS]');
    expect(context).toContain('[HELM_ETA]');
    expect(context!.match(/\[HELM_ETA\]/g)).toHaveLength(1);
    expect(context).toContain('session_eta_set');
    expect(context).toContain('multi-step work');
  });

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

  it('promptContext returns the injection as plain text (the API-tool path)', async () => {
    const { injector } = makeInjector({ suggest: async () => 'possibly related: memory/x' });
    const text = await injector.promptContext('s1', '[HELM_MSG]{"type":"inter_llm_message"}hi');
    expect(text).toContain('[HELM_MSG_RULES]');
    expect(text).toContain('possibly related: memory/x');
  });

  // Regression: a local model spent ~100 s of tool calls hunting for
  // session_mission_set / session_set_aiagent_state before answering "hi".
  it('promptContext drops hints whose tool the session cannot call', async () => {
    const { injector } = makeInjector(
      {
        suggest: async () => 'possibly related: memory/x',
        getMission: () => undefined,
        getStartablePlans: () => [{ humanId: 'P-1', title: 'plan', status: 'planned' }],
      },
      { aiagentState: undefined },
    );
    expect(await injector.promptContext('s1', 'hi', new Set(['Read']))).toBeNull();
    const withTools = await injector.promptContext('s1', 'hi', new Set(['memory_get', 'session_mission_set', 'session_set_aiagent_state', 'session_plan_claim']));
    expect(withTools).toContain('possibly related: memory/x');
    expect(withTools).toContain('No mission set');
    expect(withTools).toContain('session_set_aiagent_state');
    expect(withTools).toContain('P-1');
  });

  it('promptContext keeps a set mission as a plain fact when the session cannot change it', async () => {
    const { injector } = makeInjector({ getMission: () => ({ text: 'ship it', setBy: 'ai', setAt: 1 }) as never });
    const text = await injector.promptContext('s1', 'hi', new Set());
    expect(text).toContain('ship it');
    expect(text).not.toContain('session_mission_set');
  });

  it('promptContext is silent for an unknown session', async () => {
    const { injector } = makeInjector({ getSession: () => null });
    expect(await injector.promptContext('nope', 'hi')).toBeNull();
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

describe('UserPromptSubmit reminder delivery modes (G9)', () => {
  const msgPrompt = '[HELM_MSG]{"type":"inter_llm_message"}do the thing';
  const tgPrompt = '[HELM_TELEGRAM from:u chat:1]\nhello\n[/HELM_TELEGRAM]';

  it('mode pty skips the injected rules — the prepend carries them instead', async () => {
    const { injector } = makeInjector({ getReminderMode: () => 'pty' });
    const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: msgPrompt }));
    // Nothing else outstanding → fully silent, not just rule-less.
    expect(result).toBeNull();
  });

  it('mode off skips the injected rules too — suppressed means both paths', async () => {
    const { injector } = makeInjector({ getReminderMode: () => 'off' });
    expect(await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: msgPrompt }))).toBeNull();
    expect(await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }))).toBeNull();
  });

  it('mode pty for one reminder does not silence the other', async () => {
    const { injector } = makeInjector({ getReminderMode: (r) => (r === 'helmMsgRules' ? 'pty' : undefined) });
    const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
    expect(contextOf(result!.body)).toContain('[HELM_TELEGRAM_RULES]');
  });

  it('injects the rules with no mode wired at all — the hook firing is the capability proof', async () => {
    const { injector } = makeInjector();
    const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: msgPrompt }));
    expect(contextOf(result!.body)).toContain('[HELM_MSG_RULES]');
  });

  describe('Telegram mode block (telegramModeInstructions)', () => {
    it('mode hook injects the mode block ONCE per telegram-mode entry', async () => {
      const { injector } = makeInjector(
        { getReminderMode: (r) => (r === 'telegramModeInstructions' ? 'hook' : undefined) },
        { interactionChannel: 'telegram' },
      );
      const first = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      expect(contextOf(first!.body)).toContain('[HELM_TELEGRAM_MODE]');
      const second = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      expect(contextOf(second!.body)).not.toContain('[HELM_TELEGRAM_MODE]');
    });

    it('mode pty (the default) never injects the mode block — the prepend owns it', async () => {
      const { injector } = makeInjector({}, { interactionChannel: 'telegram' });
      const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      expect(contextOf(result!.body)).not.toContain('[HELM_TELEGRAM_MODE]');
    });

    it('leaving telegram mode re-arms the block for the next entry', async () => {
      let channel: string | undefined = 'telegram';
      const { injector } = makeInjector(
        { getReminderMode: (r) => (r === 'telegramModeInstructions' ? 'hook' : undefined), getSession: () => session({ interactionChannel: channel as never }) },
      );
      await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      channel = 'desktop';
      await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      channel = 'telegram';
      const again = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: tgPrompt }));
      expect(contextOf(again!.body)).toContain('[HELM_TELEGRAM_MODE]');
    });
  });
});

describe('PostToolUse suggestion injection', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('encodes one tool pointer for %s', async (cli) => {
    let receivedQuery = '';
    const { injector } = makeInjector({
      suggestTool: async (_sessionId, query, projectId) => {
        receivedQuery = `${projectId}:${query}`;
        return 'possibly related: memory/m1 (charger baud rate)';
      },
    });

    const result = await injector.respond(hookEvent({
      cli,
      event: 'PostToolUse',
      toolName: 'Read',
      toolInput: { file_path: '/repo/charger.ts' },
      toolResponse: 'RS485 charger baud rate is 9600',
    }));

    expect(receivedQuery).toContain('project-1:tool Read');
    expect(receivedQuery).toContain('charger.ts');
    expect(receivedQuery).toContain('9600');
    if (cli === 'copilot') {
      expect(result?.body).toMatchObject({ additionalContext: expect.stringContaining('memory/m1') });
    } else {
      expect(result?.body).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: expect.stringContaining('memory/m1'),
        },
      });
    }
  });

  it('returns no hint for an unsupported provider and resets turn/session state at lifecycle boundaries', async () => {
    const resetSuggestions = vi.fn();
    const resetToolSuggestionTurn = vi.fn();
    const suggestTool = vi.fn(async () => 'possibly related: skill/x');
    const { injector } = makeInjector({ resetSuggestions, resetToolSuggestionTurn, suggestTool });

    expect(await injector.respond(hookEvent({ cli: 'unknown' as HookEvent['cli'], event: 'PostToolUse' }))).toBeNull();
    expect(suggestTool).not.toHaveBeenCalled();
    await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'new turn' }));
    await injector.respond(hookEvent({ event: 'PreCompact' }));
    await injector.respond(hookEvent({ event: 'SessionStart', source: 'compact' }));
    await injector.respond(hookEvent({ event: 'SessionStart', source: 'resume' }));

    expect(resetToolSuggestionTurn).toHaveBeenCalledTimes(1);
    expect(resetSuggestions).toHaveBeenCalledTimes(2);
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

  it('reminds of open todos once per user turn, never of done ones', async () => {
    const { injector } = makeInjector({
      getTodos: () => [
        { id: 't1', text: 'Wire the chart', status: 'open', createdAt: 1 },
        { id: 't2', text: 'Already shipped', status: 'done', createdAt: 2, doneAt: 3 },
      ],
    });
    const first = await injector.respond(hookEvent({ event: 'Stop' }));
    const reason = (first!.body as { reason: string }).reason;
    expect(reason).toContain('Wire the chart');
    expect(reason).not.toContain('Already shipped');
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();

    await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'next' }));
    expect((await injector.respond(hookEvent({ event: 'Stop' })))!.body).toHaveProperty('decision', 'block');
  });

  it('lets a Stop pass when every todo is done', async () => {
    const { injector } = makeInjector({
      getTodos: () => [{ id: 't1', text: 'Done', status: 'done', createdAt: 1, doneAt: 2 }],
    });
    expect(await injector.respond(hookEvent({ event: 'Stop' }))).toBeNull();
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

describe('Stop — G8 loop driving, stacked on the same event', () => {
  it('emits the loop block as the ONE Stop reply when the decider blocks', async () => {
    let blocksLeft = 1;
    const decider = {
      stopBlock: () => (blocksLeft-- > 0 ? 'Continue the plan chain: P-0002 "Follow up" is ready.' : null),
    };
    const { injector } = makeInjector({
      loop: decider,
      // The nudge would ALSO fire here — exactly one block means it must not.
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    const result = await injector.respond(hookEvent({ event: 'Stop' }));
    expect(result!.body).toEqual({
      decision: 'block',
      reason: expect.stringContaining('P-0002'),
    });
    // Exactly one block per Stop EVENT: the next Stop gets the nudge (its
    // ledger was not consumed by the loop block), not a stacked second block.
    const second = await injector.respond(hookEvent({ event: 'Stop' }));
    expect((second!.body as { reason: string }).reason).toContain('still claimed and open');
  });

  it('falls through to the one-shot nudge when the decider allows', async () => {
    const decider = { stopBlock: () => null };
    const { injector } = makeInjector({
      loop: decider,
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    const result = await injector.respond(hookEvent({ event: 'Stop' }));
    expect((result!.body as { reason: string }).reason).toContain('still claimed and open');
  });

  it('NEVER asks the loop decider on StopFailure — the worst thing G8 could do is retry a stall', async () => {
    const decider = { stopBlock: () => 'continue forever' };
    const { injector } = makeInjector({ loop: decider });
    expect(await injector.respond(hookEvent({ event: 'StopFailure' }))).toBeNull();
  });

  it('a missing loop dep is today\'s behaviour — byte-identical Stop path', async () => {
    const { injector } = makeInjector({
      getClaimedPlan: () => ({ humanId: 'P-0785', title: 'Hook G4', status: 'coding' }),
    });
    const result = await injector.respond(hookEvent({ event: 'Stop' }));
    expect(result!.body).toEqual({
      decision: 'block',
      reason: expect.stringContaining('P-0785 "Hook G4" still claimed and open'),
    });
  });
});

describe('Mission statement ([HELM_MISSION])', () => {
  const mission = { text: 'Ship the mission bar', setBy: 'user' as const, setAt: 1 };

  it('UserPromptSubmit carries the current mission on EVERY prompt', async () => {
    const { injector } = makeInjector({ getMission: () => mission });
    for (const prompt of ['first', 'second', 'third']) {
      const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt }));
      const context = contextOf(result!.body);
      expect(context).toContain('[HELM_MISSION] Current mission: "Ship the mission bar".');
      expect(context).toContain('call session_mission_set');
    }
  });

  it('with no mission, asks the AI to set one', async () => {
    const { injector } = makeInjector({ getMission: () => undefined });
    const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'hello' }));
    expect(contextOf(result!.body)).toContain(
      '[HELM_MISSION] No mission set. Call session_mission_set with a one-line TL;DR of what this session is doing.',
    );
  });

  it('combines with the rules and nudges instead of replacing them', async () => {
    const { injector } = makeInjector({ getMission: () => mission }, { aiagentState: undefined });
    const result = await injector.respond(
      hookEvent({ event: 'UserPromptSubmit', prompt: '[HELM_MSG]{"type":"inter_llm_message"}hi' }),
    );
    const context = contextOf(result!.body);
    expect(context).toContain('[HELM_MSG_RULES]');
    expect(context).toContain('session_set_aiagent_state');
    expect(context).toContain('[HELM_MISSION] Current mission');
  });

  it('is never sent to Copilot (its CLI drops UserPromptSubmit output)', async () => {
    const { injector } = makeInjector({ getMission: () => mission });
    expect(await injector.respond(hookEvent({ cli: 'copilot', event: 'UserPromptSubmit', prompt: 'x' }))).toBeNull();
  });

  it('SessionStart injects the mission alongside the handover', async () => {
    const { injector } = makeInjector({
      getMission: () => mission,
      getHandover: () => 'mid-refactor',
    });
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context).toContain('[HELM_MISSION] Current mission: "Ship the mission bar"');
    expect(context).toContain('Handover note');
  });

  it('SessionStart with only a mission still speaks', async () => {
    const { injector } = makeInjector({ getMission: () => mission });
    const result = await injector.respond(hookEvent());
    expect(contextOf(result!.body)).toContain('Ship the mission bar');
  });

  it('re-supplies open todos on every prompt beside the mission', async () => {
    const todo: SessionTodo = { id: 'todo-1', text: 'Ship the pane', status: 'open', createdAt: 1 };
    const { injector } = makeInjector({ getMission: () => mission, getTodos: () => [todo] });

    for (const prompt of ['first', 'after compact']) {
      const context = contextOf((await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt })))!.body);
      expect(context).toContain('[HELM_TODOS]');
      expect(context).toContain('todo-1: Ship the pane');
      expect(context).toContain('call session_todo_add once per step');
      expect(context).toContain('[HELM_MISSION] Current mission');
    }
  });

  it('re-supplies todos beside the manifesto after SessionStart reset', async () => {
    const { injector } = makeInjector({
      getTodos: () => [{ id: 'todo-2', text: 'Restore context', status: 'open', createdAt: 1 }],
      getManifestos: () => [{ title: 'Working agreement', content: 'Keep changes small.' }],
    });
    const context = contextOf((await injector.respond(hookEvent()))!.body);
    expect(context).toContain('Working agreement');
    expect(context).toContain('[HELM_TODOS]');
    expect(context).toContain('todo-2: Restore context');
  });
});

describe('context pressure reminders', () => {
  const limits = { amber: 75, red: 90 };

  it('adds amber once to each user prompt while usage is above amber and below red', async () => {
    const { injector } = makeInjector(
      { getContextLimits: () => limits },
      { contextUsage: { tokens: 80, window: 100 } },
    );

    for (const prompt of ['first', 'second']) {
      const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt }));
      const context = contextOf(result!.body);
      expect(context).toContain('AMBER');
      expect(context).toContain('session_compact');
      expect(context).toContain('handover');
      expect(context).toContain('session_quick_compact');
    }

    expect(contextOf((await injector.respond(hookEvent()))?.body)).not.toContain('AMBER');
  });

  it('adds the red quick-compact request on every hook while usage is above red', async () => {
    const { injector } = makeInjector(
      { getContextLimits: () => limits },
      { contextUsage: { tokens: 91, window: 100 } },
    );

    const events = [
      'SessionStart', 'UserPromptSubmit', 'UserPromptTransformed', 'PreToolUse', 'PostToolUse',
      'PreCompact', 'Stop', 'SubagentStart', 'SubagentStop', 'StopFailure',
    ] as const;
    for (const event of events) {
      const result = await injector.respond(hookEvent({
        event,
        cli: event === 'UserPromptTransformed' ? 'copilot' : 'claude',
        prompt: 'user prompt',
        transformedPrompt: 'model prompt',
      }));
      const body = JSON.stringify(result?.body);
      expect(body).toContain('RED');
      expect(body).toContain('session_quick_compact');
      if (event === 'PreCompact') {
        expect(body).not.toContain('"continue":false');
        expect(body).not.toContain('"decision":"block"');
      }
    }
  });

  it('adds amber to Helm API prompt context as well as CLI prompts', async () => {
    const { injector } = makeInjector(
      { getContextLimits: () => limits },
      { contextUsage: { tokens: 80, window: 100 } },
    );

    expect(await injector.promptContext('s1', 'Helm prompt')).toContain('AMBER');
  });

  it('uses the Copilot prompt-transform event for per-prompt amber guidance', async () => {
    const { injector } = makeInjector(
      { getContextLimits: () => limits },
      { contextUsage: { tokens: 80, window: 100 } },
    );
    const result = await injector.respond(hookEvent({
      cli: 'copilot',
      event: 'UserPromptTransformed',
      prompt: 'hello',
      transformedPrompt: 'model-facing prompt',
    }));

    expect(result?.body).toMatchObject({ modifiedTransformedPrompt: expect.stringContaining('model-facing prompt') });
    expect((result!.body as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt).toContain('AMBER');
  });

  it('fails open when Copilot omits the transformed prompt text', async () => {
    const { injector } = makeInjector(
      { getContextLimits: () => limits },
      { contextUsage: { tokens: 80, window: 100 } },
    );
    expect(await injector.respond(hookEvent({ cli: 'copilot', event: 'UserPromptTransformed', prompt: 'hello' }))).toBeNull();
  });

  it('respects editable alert text', async () => {
    const { injector } = makeInjector({
      getContextLimits: () => limits,
      getHookInjectionOverrides: () => ({ amberContextAlert: 'Custom alert for {{level}}.' }),
    }, { contextUsage: { tokens: 80, window: 100 } });

    const result = await injector.respond(hookEvent({ event: 'UserPromptSubmit', prompt: 'hello' }));
    expect(contextOf(result!.body)).toContain('Custom alert for amber.');
    expect(contextOf(result!.body)).not.toContain('session_quick_compact');
  });

  it('does not alert without a measured context or valid limits', async () => {
    const noUsage = makeInjector({ getContextLimits: () => limits });
    const noLimits = makeInjector({ getContextLimits: () => undefined }, { contextUsage: { tokens: 99, window: 100 } });

    expect(await noUsage.injector.respond(hookEvent({ event: 'UserPromptSubmit' }))).toBeNull();
    expect(await noLimits.injector.respond(hookEvent({ event: 'UserPromptSubmit' }))).toBeNull();
  });
});
