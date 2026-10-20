import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/session/persistence.js')>()),
  saveSessions: () => {},
  loadSessions: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { HelmControlService } = await import('../src/mcp/helm-control-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

describe('MCP session_eta_*', () => {
  let manager: InstanceType<typeof SessionManager>;
  let call: (tool: string, args?: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<any>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 11, 8));
    manager = new SessionManager();
    manager.addSession(session('me', 'caller'));
    manager.addSession(session('other', 'sibling'));
    const configLoader = {
      getCliTypeLabel: (ref: string) => ref,
      getCliTypeEntry: () => null,
      getCliTypes: () => [],
    };
    const service = new HelmControlService({} as never, manager, {} as never, configLoader as never);
    const deps = { service, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    call = (tool, args = {}, auth = { sessionId: 'me' }) => callMcpTool(deps, tool, args, auth) as Promise<any>;
  });

  afterEach(() => vi.useRealTimers());

  it('publishes an own-session set tool with mutually exclusive relative and absolute time inputs', () => {
    const definitions = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
    const set = definitions.get('session_eta_set');
    const clear = definitions.get('session_eta_clear');
    expect(getAvailableTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['session_eta_set', 'session_eta_clear']));
    expect(set?.inputSchema.additionalProperties).toBe(false);
    expect(set?.inputSchema.oneOf).toEqual([
      { required: ['minutes'] },
      { required: ['at'] },
    ]);
    expect(clear?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('sets a relative ETA and exposes the same record to the caller and session list', async () => {
    const now = Date.now();
    const result = await call('session_eta_set', { minutes: 25, note: 'review tests' });
    const eta = { at: now + 25 * 60_000, setAt: now, note: 'review tests' };

    expect(result.eta).toEqual(eta);
    expect(manager.getSession('me')?.eta).toEqual(eta);
    expect(manager.getSession('other')?.eta).toBeUndefined();
    expect((await call('session_info')).your_eta).toEqual(eta);
    expect((await call('session_list')).find((row: { id: string }) => row.id === 'me').eta).toEqual(eta);
  });

  it('accepts an absolute ETA, normalizes the note, and clears only the caller ETA', async () => {
    const now = Date.now();
    await call('session_eta_set', { at: now + 90_000, note: '  finish review  ' });
    expect(manager.getSession('me')?.eta).toEqual({ at: now + 90_000, setAt: now, note: 'finish review' });

    manager.updateSession('other', { eta: { at: now + 120_000, setAt: now } });
    expect(await call('session_eta_clear')).toMatchObject({ ok: true, eta: null });
    expect(manager.getSession('me')?.eta).toBeUndefined();
    expect(manager.getSession('other')?.eta).toEqual({ at: now + 120_000, setAt: now });
    expect((await call('session_info')).your_eta).toBeNull();
  });

  it('rejects ambiguous or invalid ETA inputs without overwriting the current ETA', async () => {
    await call('session_eta_set', { minutes: 20 });
    const previous = manager.getSession('me')?.eta;
    await expect(call('session_eta_set', {})).rejects.toThrow(/exactly one of minutes or at/i);
    await expect(call('session_eta_set', { minutes: 1, at: Date.now() + 60_000 })).rejects.toThrow(/exactly one of minutes or at/i);
    await expect(call('session_eta_set', { minutes: 0 })).rejects.toThrow(/minutes.*positive/i);
    await expect(call('session_eta_set', { at: Number.NaN })).rejects.toThrow(/at.*finite/i);
    await expect(call('session_eta_set', { minutes: 30, note: 42 })).rejects.toThrow(/note.*string/i);
    expect(manager.getSession('me')?.eta).toEqual(previous);
  });

  it('requires the authenticated caller and never accepts another session as target', async () => {
    await expect(call('session_eta_set', { minutes: 5 }, {})).rejects.toThrow(/could not determine your session/);
    await expect(call('session_eta_clear', {}, {})).rejects.toThrow(/could not determine your session/);
    await expect(call('session_eta_set', { minutes: 5, sessionId: 'other' })).rejects.toThrow(/only sets your own session/i);
    await expect(call('session_eta_clear', { sessionId: 'other' })).rejects.toThrow(/only clears your own session/i);
    expect(manager.getSession('other')?.eta).toBeUndefined();
  });
});

describe('MCP session_eta_* with the EtaTracker', () => {
  it('scores set -> re-set -> clear from the first set and clears the row; the sweep closes overdue ones', async () => {
    vi.useFakeTimers();
    const t0 = new Date(2026, 9, 20, 10, 0).getTime();
    vi.setSystemTime(t0);
    const { EtaTracker, sweepOverdueEtas } = await import('../src/session/eta-tracker.js');
    const appended: unknown[] = [];
    const tracker = new EtaTracker({ persistence: { append: r => appended.push(r), loadAll: () => [] } });
    const manager = new SessionManager();
    manager.addSession({ ...session('me', 'caller'), workingDir: 'X:/repo' });
    const configLoader = { getCliTypeLabel: (r: string) => r, getCliTypeEntry: () => null, getCliTypes: () => [] };
    const service = new HelmControlService({} as never, manager, {} as never, configLoader as never);
    service.setEtaTracker(tracker);
    const deps = { service, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    const call = (tool: string, args = {}) => callMcpTool(deps, tool, args, { sessionId: 'me' }) as Promise<any>;

    await call('session_eta_set', { minutes: 10 });
    vi.setSystemTime(t0 + 8 * 60_000);
    await call('session_eta_set', { minutes: 5 });
    vi.setSystemTime(t0 + 12 * 60_000);
    await call('session_eta_clear');
    expect(appended).toEqual([expect.objectContaining({ startedAt: t0, firstAt: t0 + 10 * 60_000, endedAt: t0 + 12 * 60_000, outcome: 'cleared', dir: 'X:/repo' })]);
    expect(manager.getSession('me')?.eta).toBeUndefined();

    await call('session_eta_set', { minutes: 10 });
    vi.setSystemTime(t0 + 40 * 60_000);
    sweepOverdueEtas(manager, tracker);
    expect(appended).toHaveLength(1);
    expect(manager.getSession('me')?.eta).toBeDefined();
    vi.setSystemTime(t0 + 80 * 60_000);
    sweepOverdueEtas(manager, tracker);
    expect(appended[1]).toMatchObject({ outcome: 'unmarked', endedAt: t0 + 72 * 60_000 });

    await call('session_eta_set', { minutes: 10 });
    await call('session_eta_set', { minutes: 30, rescope: 'user widened the task' });
    expect(appended[2]).toMatchObject({ outcome: 'rescoped', reason: 'user widened the task' });
    await call('session_eta_clear');
    expect(manager.getSession('me')?.eta).toBeUndefined();
    vi.useRealTimers();
  });
});
