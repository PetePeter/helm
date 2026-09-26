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
const { buildOperatorGuide } = await import('../src/mcp/guides/operator-guide.js');
const { HelmSessionService } = await import('../src/mcp/services/helm-session-service.js');

type Config = { enabled: boolean; cliType: string; workingDir: string };

function setup(config: Config, existing: SessionInfo[] = []) {
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
  });
  return { sessionManager, operator, spawns };
}

const ENABLED: Config = { enabled: true, cliType: 'cli-uuid-1', workingDir: 'X:/home' };
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
  it('carries the route-only rules', () => {
    const guide = buildOperatorGuide();
    for (const line of [
      'ROUTE ONLY',
      'session_send_text',
      'expectsResponse=true',
      'chat_send',
      'NEVER edit files, run commands, investigate, or create/close sessions',
      'ask back',
      'no markdown',
    ]) {
      expect(guide).toContain(line);
    }
  });
});
