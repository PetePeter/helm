/**
 * Operator session — the router-only "Helm" singleton (docs/voice-operator.md).
 * Real SessionManager (persistence swapped for an in-memory store), a fake
 * spawn that registers the session the way spawnConfiguredSession does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let persisted: SessionInfo[] = [];
vi.mock('../src/session/persistence.js', () => ({
  saveSessions: (sessions: SessionInfo[]) => { persisted = sessions.map(s => ({ ...s })); },
  loadSessions: () => persisted.map(s => ({ ...s })),
}));

const { SessionManager } = await import('../src/session/manager.js');
const { OperatorSessionManager, OPERATOR_SESSION_NAME } = await import('../src/session/operator-session-manager.js');
const { saveSessions, loadSessions } = await import('../src/session/session-persistence.js');
const { buildOperatorGuide, OPERATOR_RULES } = await import('../src/mcp/guides/operator-guide.js');
const { HelmSessionService } = await import('../src/mcp/services/helm-session-service.js');

type Config = { enabled: boolean; cliType: string; workingDir: string; compactEveryMinutes: number; rules: string };

function setup(config: Config, existing: SessionInfo[] = [], compact?: (sessionId: string, handover: string) => Promise<void>) {
  const compacts: Array<{ sessionId: string; handover: string }> = [];
  const pendingHandovers = new Set<string>();
  const sessionManager = new SessionManager();
  for (const s of existing) sessionManager.addSession({ ...s });
  const spawns: Array<{ cliType: string; cwd?: string; sessionName: string; contextText: string }> = [];
  let next = 0;
  const operator = new OperatorSessionManager({
    sessionManager,
    getConfig: () => config,
    spawn: (params) => {
      spawns.push(params);
      const id = `op-${++next}`;
      sessionManager.addSession({ id, name: params.sessionName, cliType: params.cliType, processId: 1, cliSessionName: `cli-${id}` });
      return { sessionId: id };
    },
    compact: compact ?? (async (sessionId, handover) => { compacts.push({ sessionId, handover }); }),
    isHandoverPending: (sessionId) => pendingHandovers.has(sessionId),
  });
  return { sessionManager, operator, spawns, compacts, pendingHandovers };
}

const ENABLED: Config = { enabled: true, cliType: 'cli-uuid-1', workingDir: 'X:/home', compactEveryMinutes: 0, rules: '' };
const operators = (sm: InstanceType<typeof SessionManager>) => sm.getAllSessions().filter(s => s.role === 'operator');

describe('OperatorSessionManager.ensure', () => {
  beforeEach(() => { persisted = []; });

  it('spawns one locked "Helm" operator on the chosen CLI type when none exists', () => {
    const { sessionManager, operator, spawns } = setup(ENABLED);
    const id = operator.ensure();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ cliType: 'cli-uuid-1', cwd: 'X:/home', sessionName: OPERATOR_SESSION_NAME });
    expect(spawns[0].contextText).toBe(buildOperatorGuide());
    const session = sessionManager.getSession(id!)!;
    expect(session).toMatchObject({ role: 'operator', locked: true, name: 'Helm' });
  });

  it('does not spawn when an operator already exists (restart resume path), and re-asserts lock + name', () => {
    const { sessionManager, operator, spawns } = setup(ENABLED, [
      { id: 'existing', name: 'renamed', cliType: 'cli-uuid-1', processId: 1, cliSessionName: 'keep-me', role: 'operator' },
    ]);
    expect(operator.ensure()).toBe('existing');
    expect(spawns).toHaveLength(0);
    expect(sessionManager.getSession('existing')).toMatchObject({ locked: true, name: 'Helm', cliSessionName: 'keep-me' });
  });

  it('keeps the oldest of duplicate operators and demotes the rest, without spawning', () => {
    const { sessionManager, operator, spawns } = setup(ENABLED, [
      { id: 'newer', name: 'Helm', cliType: 'c', processId: 1, role: 'operator', createdAt: 200 },
      { id: 'older', name: 'Helm', cliType: 'c', processId: 1, role: 'operator', createdAt: 100 },
    ]);
    expect(operator.ensure()).toBe('older');
    expect(spawns).toHaveLength(0);
    expect(operators(sessionManager).map(s => s.id)).toEqual(['older']);
  });

  it('on disable, demotes the existing operator without closing it', () => {
    const { sessionManager, operator, spawns } = setup({ ...ENABLED, enabled: false }, [
      { id: 'op', name: 'Helm', cliType: 'c', processId: 1, role: 'operator', locked: true },
    ]);
    expect(operator.ensure()).toBeNull();
    expect(spawns).toHaveLength(0);
    expect(sessionManager.getSession('op')).toBeTruthy();
    expect(operators(sessionManager)).toHaveLength(0);
  });

  it('is a no-op when disabled or when no CLI type is chosen', () => {
    for (const config of [{ ...ENABLED, enabled: false }, { ...ENABLED, cliType: '' }]) {
      const { sessionManager, operator, spawns } = setup(config);
      expect(operator.ensure()).toBeNull();
      expect(spawns).toHaveLength(0);
      expect(operators(sessionManager)).toHaveLength(0);
    }
  });

  it('yields exactly one operator across repeated ensures (N restarts)', () => {
    const { sessionManager, operator, spawns } = setup(ENABLED);
    operator.ensure();
    operator.ensure();
    operator.ensure();
    expect(spawns).toHaveLength(1);
    expect(operators(sessionManager)).toHaveLength(1);
  });
});

describe('role persistence (invariant 6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helm-operator-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips role through sessions.yaml and drops an unknown role', () => {
    const file = join(dir, 'sessions.yaml');
    saveSessions([
      { id: 'a', name: 'Helm', cliType: 'c', processId: 1, role: 'operator' },
      { id: 'b', name: 'x', cliType: 'c', processId: 1, role: 'bogus' as never },
    ], file);
    const [a, b] = loadSessions(file);
    expect(a.role).toBe('operator');
    expect(b.role).toBeUndefined();
  });
});

describe('session_list exposes role (phone contract: HelmSession.kt reads "role")', () => {
  it('includes role: "operator" on the operator summary only', () => {
    const sessions = [
      { id: 'op', name: 'Helm', cliType: 'c', processId: 1, role: 'operator' as const },
      { id: 'w', name: 'work', cliType: 'c', processId: 1 },
    ];
    const service = new HelmSessionService(
      { getAllSessions: () => sessions, getSession: (id: string) => sessions.find(s => s.id === id) ?? null } as any,
      { has: () => true } as any,
      { getCliTypeLabel: (ref: string) => ref, getWorkingDirectories: () => [] } as any,
      { getForDirectory: () => [] } as any,
    );
    const [op, work] = service.listSessions();
    expect(op.role).toBe('operator');
    expect(work).not.toHaveProperty('role');
    expect(service.getSession('op')?.role).toBe('operator');
  });
});

describe('operator guide', () => {
  const guide = buildOperatorGuide();

  it('renders every exported built-in rule, so the Settings list and the guide never drift', () => {
    OPERATOR_RULES.forEach((rule, i) => expect(guide).toContain(`rule_${i + 1} = ${JSON.stringify(rule)}`));
  });

  it('has no [user_rules] section when the user rules are empty or blank', () => {
    expect(guide).not.toContain('[user_rules]');
    expect(buildOperatorGuide('  \n \n')).toBe(guide);
  });

  it('appends the user rules, one per non-blank line, after the built-ins, as highest priority', () => {
    const withRules = buildOperatorGuide('Never message the build session.\n\n  Say "done" when done.  ');
    expect(withRules.startsWith(guide)).toBe(true);
    const section = withRules.slice(guide.length);
    expect(section).toContain('[user_rules]');
    expect(section).toContain('highest priority');
    expect(section).toContain('rule_1 = "Never message the build session."');
    expect(section).toContain('rule_2 = "Say \\"done\\" when done."');
    expect(section).not.toContain('rule_3');
  });

  it('has three modes: answer from Helm state, answer from knowledge, route work', () => {
    for (const line of ['ANSWER FROM HELM', 'ANSWER GENERAL QUESTIONS', 'ROUTE WORK']) {
      expect(guide).toContain(line);
    }
  });

  it('lists the read-only lookups, including tool_list for CLI types', () => {
    for (const tool of [
      'plan_list', 'plan_get', 'plan_summary', 'sequence_list', 'sequence_get',
      'session_list', 'session_get', 'context_list', 'context_get', 'scheduler_list',
      'memory_search', 'memory_get', 'skill_list', 'directory_list', 'project_list', 'tool_list',
    ]) {
      expect(guide).toContain(tool);
    }
  });

  it('keeps the hard NOs and allows only chat_send and session_send_text as mutations', () => {
    for (const line of [
      'NEVER edit files, run commands, read repo code, or create/close sessions',
      'NEVER mutate plans, sequences, contexts, schedules, memories or sessions',
      'Your only writes are chat_send and session_send_text',
      'expectsResponse=true',
      'ask back',
      'no markdown',
    ]) {
      expect(guide).toContain(line);
    }
  });
});

describe('hourly self-compaction (fake clock)', () => {
  const MIN = 60_000;
  const HOURLY: Config = { ...ENABLED, compactEveryMinutes: 60 };
  let ctx: ReturnType<typeof setup>;
  let opId: string;

  beforeEach(() => {
    persisted = [];
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    ctx?.operator.dispose();
    vi.useRealTimers();
  });

  function start(config: Config = HOURLY) {
    ctx = setup(config);
    opId = ctx.operator.ensure()!;
  }
  const touch = (patch: Partial<SessionInfo> = {}) =>
    ctx.sessionManager.updateSession(opId, { lastOutputAt: Date.now(), activityLevel: 'inactive', ...patch });
  const advance = (minutes: number) => vi.advanceTimersByTimeAsync(minutes * MIN);

  it('compacts an idle operator that had activity, once, with the operator guide as handover', async () => {
    start();
    touch();
    await advance(60);
    expect(ctx.compacts).toHaveLength(1);
    expect(ctx.compacts[0].sessionId).toBe(opId);
    expect(ctx.compacts[0].handover).toContain('You are Helm, the operator');
    expect(ctx.compacts[0].handover).toContain(buildOperatorGuide());
  });

  it('spawn and compaction handover both carry the rules current at that moment', async () => {
    const config: Config = { ...HOURLY, rules: 'Rule at spawn.' };
    start(config);
    expect(ctx.spawns[0].contextText).toBe(buildOperatorGuide('Rule at spawn.'));
    config.rules = 'Rule after edit.';
    touch();
    await advance(60);
    expect(ctx.compacts[0].handover).toContain(buildOperatorGuide('Rule after edit.'));
    expect(ctx.compacts[0].handover).not.toContain('Rule at spawn.');
  });

  it('skips an operator with no activity since the last compaction', async () => {
    start();
    touch();
    await advance(60);
    expect(ctx.compacts).toHaveLength(1);
    // The compaction's own echo (and the handover reply) is not "activity".
    touch();
    await advance(30);
    await advance(60 * 3);
    expect(ctx.compacts).toHaveLength(1);
  });

  it('compacts again after fresh activity in a later hour', async () => {
    start();
    touch();
    await advance(60);
    await advance(30); // settle: rebaseline
    await advance(10);
    touch();
    await advance(60);
    expect(ctx.compacts).toHaveLength(2);
  });

  it.each([
    ['active dot', { activityLevel: 'active' as const }],
    ['implementing', { aiagentState: 'implementing' as const }],
  ])('defers while busy (%s) and retries every 30 min until idle', async (_label, busy) => {
    start();
    touch(busy);
    await advance(60);
    await advance(30);
    expect(ctx.compacts).toHaveLength(0);
    ctx.sessionManager.updateSession(opId, { activityLevel: 'inactive', aiagentState: 'idle' });
    await advance(30);
    expect(ctx.compacts).toHaveLength(1);
  });

  it('treats a pending handover as busy', async () => {
    start();
    touch();
    ctx.pendingHandovers.add(opId);
    await advance(60);
    expect(ctx.compacts).toHaveLength(0);
    ctx.pendingHandovers.delete(opId);
    await advance(30);
    expect(ctx.compacts).toHaveLength(1);
  });

  it('treats an open relay (operator sent with expectsResponse, no reply yet) as busy', async () => {
    start();
    touch();
    const flight = { flightId: 'f1', senderSessionName: 'Helm', recipientName: 'w', isReply: false };
    ctx.operator.noteFlight({ ...flight, senderSessionId: opId, recipientSessionId: 'worker', expectsResponse: true });
    await advance(60);
    expect(ctx.compacts).toHaveLength(0);
    ctx.operator.noteFlight({ ...flight, flightId: 'f2', senderSessionId: 'worker', recipientSessionId: opId, expectsResponse: false });
    await advance(30);
    expect(ctx.compacts).toHaveLength(1);
  });

  it('never compacts when compactEveryMinutes is 0', async () => {
    start({ ...HOURLY, compactEveryMinutes: 0 });
    touch();
    await advance(60 * 5);
    expect(ctx.compacts).toHaveLength(0);
  });

  it('stops the timer when the operator is disabled', async () => {
    const config = { ...HOURLY };
    ctx = setup(config);
    opId = ctx.operator.ensure()!;
    touch();
    config.enabled = false;
    ctx.operator.ensure();
    await advance(60 * 3);
    expect(ctx.compacts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['disabled', (config: Config) => { config.enabled = false; ctx.operator.ensure(); }],
    ['disposed', () => ctx.operator.dispose()],
  ])('does not resurrect the timer when %s while a compact is in flight', async (_label, stop) => {
    const config = { ...HOURLY };
    let release!: () => void;
    let calls = 0;
    ctx = setup(config, [], () => { calls++; return new Promise<void>(resolve => { release = resolve; }); });
    opId = ctx.operator.ensure()!;
    touch();
    await advance(60);
    expect(calls).toBe(1);
    stop(config);
    release();
    await advance(60 * 5);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
  });

  it('re-running ensure() does not stack timers', async () => {
    start();
    ctx.operator.ensure();
    ctx.operator.ensure();
    touch();
    await advance(60);
    expect(ctx.compacts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
