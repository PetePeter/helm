/** MCP keep-warm controls the same persisted state used by the desktop toggle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', () => ({ saveSessions: () => {}, loadSessions: () => [] }));

const { KEEP_WARM_DEFAULT_MS } = await import('../src/session/keep-warmer.js');
const { SessionManager } = await import('../src/session/manager.js');
const { HelmSessionService } = await import('../src/mcp/services/helm-session-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

describe('MCP session_set_keep_warm', () => {
  let manager: InstanceType<typeof SessionManager>;
  let call: (args: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<any>;
  let list: () => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    manager = new SessionManager();
    manager.addSession(session('caller-id', 'caller'));
    manager.addSession(session('worker-id', 'worker'));
    const configLoader = { getCliTypeLabel: (ref: string) => ref, getCliTypeEntry: () => ({ cacheWarnMinutes: 5 }) };
    const sessions = new HelmSessionService(manager, {} as never, configLoader as never, {} as never);
    const service = {
      getSession: (ref: string) => sessions.getSession(ref),
      listSessions: () => sessions.listSessions(),
      setSessionKeepWarm: (ref: string, on: boolean) => sessions.setSessionKeepWarm(ref, on),
    };
    const deps = {
      service: service as never,
      setPlanStateWithValidation: () => { throw new Error('not used by this tool'); },
      completePlanWithValidation: () => { throw new Error('not used by this tool'); },
    };
    call = (args, auth = { sessionId: 'caller-id' }) => callMcpTool(deps, 'session_set_keep_warm', args, auth);
    list = () => callMcpTool(deps, 'session_list', {}, {});
  });

  afterEach(() => vi.useRealTimers());

  it('publishes an on/off tool with an optional target', () => {
    const def = MCP_TOOLS.find((tool) => tool.name === 'session_set_keep_warm');
    expect(def?.inputSchema.required).toEqual(['on']);
    expect(def?.inputSchema.properties).toHaveProperty('sessionId');
    expect(getAvailableTools().map((tool) => tool.name)).toContain('session_set_keep_warm');
  });

  it('defaults to the authenticated caller and exposes the same deadline in session_list', async () => {
    await call({ on: true });
    const expected = Date.now() + KEEP_WARM_DEFAULT_MS;
    expect(manager.getSession('caller-id')?.keepWarmUntil).toBe(expected);
    expect(manager.getSession('worker-id')?.keepWarmUntil).toBeUndefined();
    expect((await list()).find((s: any) => s.id === 'caller-id')?.keepWarmUntilEpochMs).toBe(expected);
  });

  it('targets an explicit session by exact name and turns it off repeatedly', async () => {
    await call({ sessionId: 'worker', on: true });
    const until = manager.getSession('worker-id')?.keepWarmUntil;
    expect(until).toBe(Date.now() + KEEP_WARM_DEFAULT_MS);
    vi.advanceTimersByTime(60 * 60_000);
    await call({ sessionId: 'worker-id', on: true });
    expect(manager.getSession('worker-id')?.keepWarmUntil).toBe(until);
    await call({ sessionId: 'worker-id', on: false });
    await call({ sessionId: 'worker-id', on: false });
    expect(manager.getSession('worker-id')?.keepWarmUntil).toBeUndefined();
  });

  it('rejects a missing target and an anonymous default caller', async () => {
    await expect(call({ sessionId: 'missing', on: true })).rejects.toThrow(/Session not found: missing/);
    await expect(call({ on: true }, {})).rejects.toThrow(/could not determine your session/);
  });
});
