/**
 * MCP session_scratchpad_* : the LLM's side of the pad it shares with the user.
 *
 * Dispatcher -> real HelmControlService -> real ScratchpadManager and real
 * SessionManager. Only the disk sinks are in-memory (vitest shares APPDATA).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';
import type { Scratchpad } from '../src/types/scratchpad.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/session/persistence.js')>()),
  saveSessions: () => {},
  loadSessions: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { ScratchpadManager } = await import('../src/session/scratchpad-manager.js');
const { HelmControlService } = await import('../src/mcp/helm-control-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');
const { SCRATCHPAD_MAX_BYTES } = await import('../src/types/scratchpad.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

function memoryStore() {
  const files = new Map<string, Scratchpad>();
  return {
    load: (id: string) => files.get(id) ?? null,
    save: (pad: Scratchpad) => { files.set(pad.sessionId, pad); },
    remove: (id: string) => { files.delete(id); },
    list: () => [...files.keys()],
  };
}

const TOOLS = ['session_scratchpad_get', 'session_scratchpad_set', 'session_scratchpad_append'];

describe('MCP session_scratchpad_*', () => {
  let pads: InstanceType<typeof ScratchpadManager>;
  let call: (tool: string, args?: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<any>;

  beforeEach(() => {
    const sessions = new SessionManager();
    sessions.addSession(session('me', 'caller'));
    sessions.addSession(session('other', 'sibling'));
    pads = new ScratchpadManager(memoryStore(), () => 5000);
    const configLoader = { getCliTypeLabel: (ref: string) => ref, getCliTypeEntry: () => null, getCliTypes: () => [] };
    const service = new HelmControlService({} as never, sessions, {} as never, configLoader as never);
    service.setScratchpadManager(pads);
    const deps = { service, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    call = (tool, args = {}, auth = { sessionId: 'me' }) => callMcpTool(deps, tool, args, auth) as Promise<any>;
  });

  it('publishes the three tools, in the definitions and in the tool guide', () => {
    const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
    expect(byName.get('session_scratchpad_get')?.inputSchema.required).toBeUndefined();
    expect(byName.get('session_scratchpad_set')?.inputSchema.required).toEqual(['text', 'revision']);
    expect(byName.get('session_scratchpad_append')?.inputSchema.required).toEqual(['text']);
    expect(getAvailableTools().map(tool => tool.name)).toEqual(expect.arrayContaining(TOOLS));
  });

  it('reads the caller\'s own pad by default, with its size and the cap', async () => {
    pads.set('me', 'user note', 'user', 0);
    expect(await call('session_scratchpad_get')).toEqual({
      sessionId: 'me', text: 'user note', revision: 1, updatedAt: 5000, updatedBy: 'user', bytes: 9, maxBytes: SCRATCHPAD_MAX_BYTES,
    });
  });

  it('reads another session\'s pad by id or name but never writes it', async () => {
    pads.set('other', 'theirs', 'user', 0);
    expect((await call('session_scratchpad_get', { sessionId: 'sibling' })).text).toBe('theirs');
    await expect(call('session_scratchpad_set', { sessionId: 'other', text: 'x', revision: 1 })).rejects.toThrow(/only writes your own/);
    await expect(call('session_scratchpad_append', { sessionId: 'other', text: 'x' })).rejects.toThrow(/only writes your own/);
    expect(pads.get('other').text).toBe('theirs');
    expect(pads.get('me').revision).toBe(0);
  });

  it('writes as the AI and reaches the listener the pane mirrors', async () => {
    const seen: Scratchpad[] = [];
    pads.on('scratchpad:changed', (pad: Scratchpad) => seen.push(pad));
    expect(await call('session_scratchpad_set', { text: 'plan:\n1. test', revision: 0 })).toEqual({
      ok: true, revision: 1, bytes: 13, maxBytes: SCRATCHPAD_MAX_BYTES,
    });
    expect(await call('session_scratchpad_append', { text: '2. build' })).toMatchObject({ ok: true, revision: 2 });
    expect(seen.map(pad => [pad.sessionId, pad.text, pad.updatedBy])).toEqual([
      ['me', 'plan:\n1. test', 'ai'],
      ['me', 'plan:\n1. test\n2. build', 'ai'],
    ]);
  });

  it('refuses a stale replace with the text the user wrote meanwhile', async () => {
    const read = await call('session_scratchpad_get');
    pads.set('me', 'the user got there first', 'user', 0);
    const refused = await call('session_scratchpad_set', { text: 'AI version', revision: read.revision });
    expect(refused).toMatchObject({ ok: false, reason: 'stale', revision: 1, text: 'the user got there first' });
    expect(pads.get('me').text).toBe('the user got there first');
  });

  it('refuses an over-size write without echoing the pad back', async () => {
    pads.set('me', 'keep', 'user', 0);
    const refused = await call('session_scratchpad_append', { text: 'x'.repeat(SCRATCHPAD_MAX_BYTES) });
    expect(refused).toMatchObject({ ok: false, reason: 'too_large', revision: 1, bytes: 4 });
    expect(refused.text).toBeUndefined();
    expect(pads.get('me').text).toBe('keep');
  });

  it('rejects a missing or malformed revision, an anonymous caller and an unknown session', async () => {
    await expect(call('session_scratchpad_set', { text: 'x' })).rejects.toThrow(/revision is required/);
    await expect(call('session_scratchpad_set', { text: 'x', revision: 1.5 })).rejects.toThrow(/whole number/);
    for (const tool of TOOLS) {
      await expect(call(tool, { text: 'x', revision: 0 }, {})).rejects.toThrow(/could not determine your session/);
    }
    await expect(call('session_scratchpad_get', { sessionId: 'ghost' })).rejects.toThrow(/Session not found: ghost/);
    // A phone or fleet proxy identity is not a session: it has no pad to write.
    await expect(call('session_scratchpad_append', { text: 'x' }, { sessionId: 'mobile:abc' })).rejects.toThrow(/Session not found/);
  });
});
