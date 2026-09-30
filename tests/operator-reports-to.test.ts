/**
 * A session the operator starts works FOR the operator: it reports progress,
 * results and questions back to it — not to the user — until the user talks to
 * it directly. Real HelmSessionService, real ContextInjector, real
 * persistence; only the PTY spawn boundary is recorded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/session/configured-session-spawn.js', () => ({
  spawnConfiguredSession: () => ({ sessionId: 'worker' }),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';
import { ContextInjector, type ContextInjectorDeps } from '../src/session/hooks/context-injector.js';
import { loadSessions, saveSessions } from '../src/session/session-persistence.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../src/types/session.js';

let sessions: Map<string, SessionInfo>;

function service() {
  const sessionManager = {
    getAllSessions: () => [...sessions.values()],
    getSession: (id: string) => sessions.get(id) ?? null,
    updateSession: (id: string, patch: Partial<SessionInfo>) => Object.assign(sessions.get(id)!, patch),
  };
  const configLoader = {
    getWorkingDirectories: () => [{ path: '/repo', name: 'repo' }],
    getCliTypes: () => [],
    resolveCliType: (ref: string) => ({ id: ref, config: { name: ref, spawnCommand: ref } }),
  };
  return new HelmSessionService(sessionManager as any, {} as any, configLoader as any, {} as any);
}

const row = (patch: Partial<SessionInfo>): SessionInfo =>
  ({ id: 'x', name: 'x', cliType: 'claude-code', processId: 1, workingDir: '/repo', ...patch });

beforeEach(() => {
  sessions = new Map([
    ['op', row({ id: 'op', name: 'Helm', role: 'operator' })],
    ['coder', row({ id: 'coder', name: 'coder' })],
    ['worker', row({ id: 'worker', name: 'worker' })],
  ]);
});

describe('reportsTo — who an operator-started session answers to', () => {
  it('a session the operator creates reports to the operator', () => {
    service().spawnCli('claude-code', '/repo', 'worker', { creatorSessionId: 'op' });
    expect(sessions.get('worker')!.reportsTo).toBe('op');
  });

  it('a session created by anyone else reports to nobody', () => {
    service().spawnCli('claude-code', '/repo', 'worker', { creatorSessionId: 'coder' });
    expect(sessions.get('worker')!.reportsTo).toBeUndefined();
  });

  it('survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-reports-to-'));
    try {
      const file = join(dir, 'sessions.yaml');
      saveSessions([row({ id: 'worker', reportsTo: 'op' })], file);
      expect(loadSessions(file)[0].reportsTo).toBe('op');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ContextInjector and reportsTo', () => {
  function injector(worker: SessionInfo, cleared: string[] = []) {
    const deps: ContextInjectorDeps = {
      getSession: () => worker,
      getClaimedPlan: () => null,
      getStartablePlans: () => [],
      getDrafts: () => [],
      getHandover: () => undefined,
      suggest: async () => null,
      getProjectIdForDirectory: () => null,
      clearReportsTo: (id) => { cleared.push(id); },
    };
    return new ContextInjector(deps);
  }
  const start = { cli: 'claude' as const, event: 'SessionStart' as const, helmSessionId: 'worker', receivedAt: 1, raw: {} };
  const contextOf = (body: unknown) =>
    (body as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';

  it('SessionStart tells it to report to the operator, with session_send_text', async () => {
    const context = contextOf((await injector(row({ id: 'worker', reportsTo: 'op' })).respond(start))!.body);
    expect(context).toMatch(/operator/i);
    expect(context).toContain('session_send_text');
    expect(context).toContain('"op"');
  });

  it('says nothing about it for a session that reports to nobody', async () => {
    const reply = await injector(row({ id: 'worker' })).respond(start);
    expect(reply ? contextOf(reply.body) : '').not.toMatch(/report .*operator/i);
  });

  it('the user messaging it directly (phone or Telegram) hands it over to the user', async () => {
    const cleared: string[] = [];
    const inj = injector(row({ id: 'worker', reportsTo: 'op' }), cleared);
    await inj.promptContext('worker', '[HELM_MSG]{"type":"inter_llm_message","fromSessionId":"op"}do X');
    expect(cleared).toEqual([]);
    await inj.promptContext('worker', '[HELM_MSG]{"type":"inter_llm_message","fromSessionId":"mobile:abc"}hi');
    expect(cleared).toEqual(['worker']);
    await inj.promptContext('worker', '[HELM_TELEGRAM chat:1]\nhi\n[/HELM_TELEGRAM]');
    expect(cleared).toEqual(['worker', 'worker']);
  });
});
