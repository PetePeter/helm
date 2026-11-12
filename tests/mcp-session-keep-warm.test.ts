/** MCP keep-warm controls the same persisted state used by the desktop toggle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', () => ({ saveSessions: () => {}, loadSessions: () => [] }));

const { SessionManager } = await import('../src/session/manager.js');
const { HelmSessionService } = await import('../src/mcp/services/helm-session-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');

function session(id: string, name: string, hooked = true): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1, hooked };
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
    manager.addSession(session('plain-id', 'plain', false));
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

  it('defaults to the authenticated caller and exposes it in session_list', async () => {
    await call({ on: true });
    expect(manager.getSession('caller-id')?.keepWarm).toBe(true);
    expect(manager.getSession('worker-id')?.keepWarm).toBeUndefined();
    expect((await list()).find((s: any) => s.id === 'caller-id')?.keepWarm).toBe(true);
  });

  it('targets an explicit session by exact name and turns it off repeatedly', async () => {
    await call({ sessionId: 'worker', on: true });
    vi.advanceTimersByTime(60 * 60_000);
    await call({ sessionId: 'worker-id', on: true });
    expect(manager.getSession('worker-id')?.keepWarm).toBe(true);
    await call({ sessionId: 'worker-id', on: false });
    await call({ sessionId: 'worker-id', on: false });
    expect(manager.getSession('worker-id')?.keepWarm).toBeUndefined();
  });

  it('refuses to switch it on for a hookless session — nothing would confirm the ping landed', async () => {
    await expect(call({ sessionId: 'plain-id', on: true })).rejects.toThrow(/needs CLI hooks/);
    expect(manager.getSession('plain-id')?.keepWarm).toBeUndefined();
    await expect(call({ sessionId: 'plain-id', on: false })).resolves.toMatchObject({ keepWarm: false });
  });

  it('rejects a missing target and an anonymous default caller', async () => {
    await expect(call({ sessionId: 'missing', on: true })).rejects.toThrow(/Session not found: missing/);
    await expect(call({ on: true }, {})).rejects.toThrow(/could not determine your session/);
  });
});
