/**
 * MCP session_mission_set — the AI's way to keep its session's TL;DR current.
 *
 * Dispatcher → real HelmSessionService → real SessionManager. The control
 * service facade is reduced to the two delegations this tool uses; the
 * manager's disk sink is an in-memory fake (vitest shares APPDATA).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', () => ({
  saveSessions: () => {},
  loadSessions: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { HelmSessionService } = await import('../src/mcp/services/helm-session-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS: TOOL_DEFINITIONS } = await import('../src/mcp/tools/definitions.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

describe('MCP session_mission_set', () => {
  let manager: InstanceType<typeof SessionManager>;
  let call: (args: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<unknown>;
  let get: (ref: string) => Promise<any>;

  beforeEach(() => {
    manager = new SessionManager();
    manager.addSession(session('me', 'caller'));
    manager.addSession(session('other', 'sibling'));
    const configLoader = { getCliTypeLabel: (ref: string) => ref };
    const sessionService = new HelmSessionService(manager, {} as never, configLoader as never, {} as never);
    const service = {
      getSession: (ref: string) => sessionService.getSession(ref),
      setSessionMission: (ref: string, text: string) => sessionService.setSessionMission(ref, text),
    };
    const deps = { service: service as never, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    call = (args, auth = { sessionId: 'me' }) => callMcpTool(deps, 'session_mission_set', args, auth);
    get = (ref) => callMcpTool(deps, 'session_get', { sessionId: ref }, {}) as Promise<any>;
  });

  it('is a published tool with text required', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'session_mission_set');
    expect(def?.inputSchema.required).toEqual(['text']);
  });

  it('defaults to the caller\'s own session and records setBy ai', async () => {
    await call({ text: 'wire the hook' });
    expect(manager.getSession('me')!.mission).toMatchObject({ text: 'wire the hook', setBy: 'ai' });
    expect(manager.getSession('other')!.mission).toBeUndefined();
  });

  it('sets a named session by id or name', async () => {
    await call({ sessionId: 'sibling', text: 'review the diff' });
    expect(manager.getSession('other')!.mission?.text).toBe('review the diff');
  });

  it('rejects an unknown session', async () => {
    await expect(call({ sessionId: 'ghost', text: 'x' })).rejects.toThrow(/Session not found: ghost/);
  });

  it('rejects an anonymous caller with no sessionId', async () => {
    await expect(call({ text: 'x' }, {})).rejects.toThrow(/could not determine your session/);
  });

  it('rejects text over 500 characters and keeps the old mission', async () => {
    await call({ text: 'keep' });
    await expect(call({ text: 'y'.repeat(501) })).rejects.toThrow(/500/);
    expect(manager.getSession('me')!.mission?.text).toBe('keep');
  });

  it('session_get returns the mission', async () => {
    await call({ text: 'ship it' });
    const summary = await get('me');
    expect(summary.mission).toMatchObject({ text: 'ship it', setBy: 'ai' });
    expect(typeof summary.mission.setAt).toBe('number');
  });
});
