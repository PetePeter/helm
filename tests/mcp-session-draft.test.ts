/**
 * MCP session_draft_* : the LLM's side of the pad it shares with the user.
 *
 * Dispatcher -> real HelmControlService -> real DraftManager and real
 * SessionManager. Only the disk sinks are in-memory (vitest shares APPDATA).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';
import type { Draft } from '../src/types/draft.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/session/persistence.js')>()),
  saveSessions: () => {},
  loadSessions: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { DraftManager } = await import('../src/session/draft-manager.js');
const { HelmControlService } = await import('../src/mcp/helm-control-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');
const { DRAFT_MAX_BYTES } = await import('../src/types/draft.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

function memoryStore() {
  const files = new Map<string, Draft>();
  return {
    load: (id: string) => files.get(id) ?? null,
    save: (pad: Draft) => { files.set(pad.sessionId, pad); },
    remove: (id: string) => { files.delete(id); },
    list: () => [...files.keys()],
  };
}

const TOOLS = ['session_draft_get', 'session_draft_set', 'session_draft_append'];

describe('MCP session_draft_*', () => {
  let pads: InstanceType<typeof DraftManager>;
  let call: (tool: string, args?: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<any>;

  let sessions: InstanceType<typeof SessionManager>;
  let peerCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = new SessionManager();
    sessions.addSession(session('me', 'caller'));
    sessions.addSession(session('other', 'sibling'));
    pads = new DraftManager(memoryStore(), () => 5000);
    const configLoader = { getCliTypeLabel: (ref: string) => ref, getCliTypeEntry: () => null, getCliTypes: () => [] };
    const service = new HelmControlService({} as never, sessions, {} as never, configLoader as never);
    service.setDraftManager(pads);
    peerCall = vi.fn();
    (service as unknown as { peerCall: unknown }).peerCall = peerCall;
    const deps = { service, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    call = (tool, args = {}, auth = { sessionId: 'me' }) => callMcpTool(deps, tool, args, auth) as Promise<any>;
  });

  it('publishes the three tools, in the definitions and in the tool guide', () => {
    const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
    expect(byName.get('session_draft_get')?.inputSchema.required).toBeUndefined();
    expect(byName.get('session_draft_set')?.inputSchema.required).toEqual(['text', 'revision']);
    expect(byName.get('session_draft_append')?.inputSchema.required).toEqual(['text']);
    expect(getAvailableTools().map(tool => tool.name)).toEqual(expect.arrayContaining(TOOLS));
  });

  it('reads the caller\'s own pad by default, with its size and the cap', async () => {
    pads.set('me', 'user note', 'user', 0);
    expect(await call('session_draft_get')).toEqual({
      sessionId: 'me', text: 'user note', revision: 1, updatedAt: 5000, updatedBy: 'user', bytes: 9, maxBytes: DRAFT_MAX_BYTES,
    });
  });

  it("reads and writes another session's pad by id or name, frozen or locked, without sending it", async () => {
    sessions.addSession({ ...session('cold', 'frozen-one'), frozen: true, locked: true });
    pads.set('other', 'theirs', 'user', 0);
    expect((await call('session_draft_get', { sessionId: 'sibling' })).text).toBe('theirs');
    expect(await call('session_draft_set', { sessionId: 'other', text: 'x', revision: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect(await call('session_draft_append', { sessionId: 'frozen-one', text: 'note' })).toMatchObject({ ok: true, revision: 1 });
    expect(pads.get('other')).toMatchObject({ text: 'x', updatedBy: 'ai' });
    expect(pads.get('cold').text).toBe('note');
    expect(pads.get('me').revision).toBe(0);
  });

  it("still refuses a stale write to another session's pad", async () => {
    pads.set('other', 'theirs', 'user', 0);
    expect(await call('session_draft_set', { sessionId: 'other', text: 'x', revision: 0 })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('writes as the AI and reaches the listener the pane mirrors', async () => {
    const seen: Draft[] = [];
    pads.on('draft:changed', (pad: Draft) => seen.push(pad));
    expect(await call('session_draft_set', { text: 'plan:\n1. test', revision: 0 })).toEqual({
      ok: true, revision: 1, bytes: 13, maxBytes: DRAFT_MAX_BYTES,
    });
    expect(await call('session_draft_append', { text: '2. build' })).toMatchObject({ ok: true, revision: 2 });
    expect(seen.map(pad => [pad.sessionId, pad.text, pad.updatedBy])).toEqual([
      ['me', 'plan:\n1. test', 'ai'],
      ['me', 'plan:\n1. test\n2. build', 'ai'],
    ]);
  });

  it('refuses a stale replace with the text the user wrote meanwhile', async () => {
    const read = await call('session_draft_get');
    pads.set('me', 'the user got there first', 'user', 0);
    const refused = await call('session_draft_set', { text: 'AI version', revision: read.revision });
    expect(refused).toMatchObject({ ok: false, reason: 'stale', revision: 1, text: 'the user got there first' });
    expect(pads.get('me').text).toBe('the user got there first');
  });

  it('refuses an over-size write without echoing the pad back', async () => {
    pads.set('me', 'keep', 'user', 0);
    const refused = await call('session_draft_append', { text: 'x'.repeat(DRAFT_MAX_BYTES) });
    expect(refused).toMatchObject({ ok: false, reason: 'too_large', revision: 1, bytes: 4 });
    expect(refused.text).toBeUndefined();
    expect(pads.get('me').text).toBe('keep');
  });

  it('rejects a missing or malformed revision, an anonymous caller and an unknown session', async () => {
    await expect(call('session_draft_set', { text: 'x' })).rejects.toThrow(/revision is required/);
    await expect(call('session_draft_set', { text: 'x', revision: 1.5 })).rejects.toThrow(/whole number/);
    for (const tool of TOOLS) {
      await expect(call(tool, { text: 'x', revision: 0 }, {})).rejects.toThrow(/could not determine your session/);
    }
    await expect(call('session_draft_get', { sessionId: 'ghost' })).rejects.toThrow(/Session not found: ghost/);
    // A phone or fleet proxy identity is not a session: it has no pad to write.
    await expect(call('session_draft_append', { text: 'x' }, { sessionId: 'mobile:abc' })).rejects.toThrow(/Session not found/);
  });

  it("refuses a phone or peer proxy writing a named session's pad", async () => {
    for (const proxy of ['mobile:abc', 'peer:xyz']) {
      await expect(call('session_draft_append', { sessionId: 'other', text: 'x' }, { sessionId: proxy })).rejects.toThrow(/only Helm sessions/);
      await expect(call('session_draft_set', { sessionId: 'other', text: 'x', revision: 0 }, { sessionId: proxy })).rejects.toThrow(/only Helm sessions/);
    }
    expect(pads.get('other').revision).toBe(0);
  });

  it('does not let a proxy pass as a session that happens to be named like it', async () => {
    sessions.addSession(session('real', 'mobile:abc'));
    await expect(call('session_draft_append', { sessionId: 'other', text: 'x' }, { sessionId: 'mobile:abc' })).rejects.toThrow(/only Helm sessions/);
  });

  it("forwards a write to an attached remote row to the owning peer's session", async () => {
    sessions.addSession({ ...session('remote-1', 'remote-row'), remote: { peerId: 'p1', sessionId: 'owner-9' } } as SessionInfo);
    peerCall.mockResolvedValue({ ok: true, revision: 4 });
    expect(await call('session_draft_append', { sessionId: 'remote-row', text: 'hi' })).toEqual({ ok: true, revision: 4 });
    expect(peerCall).toHaveBeenCalledWith('p1', 'session_draft_append', { sessionId: 'owner-9', text: 'hi' });
    peerCall.mockResolvedValue({ ok: false, reason: 'stale', text: 't', revision: 5 });
    expect(await call('session_draft_set', { sessionId: 'remote-1', text: 'x', revision: 1 })).toMatchObject({ reason: 'stale' });
    expect(peerCall).toHaveBeenLastCalledWith('p1', 'session_draft_set', { sessionId: 'owner-9', text: 'x', revision: 1 });
    peerCall.mockResolvedValue({ text: 'theirs', revision: 5 });
    expect(await call('session_draft_get', { sessionId: 'remote-row' })).toMatchObject({ text: 'theirs' });
    expect(peerCall).toHaveBeenLastCalledWith('p1', 'session_draft_get', { sessionId: 'owner-9' });
    expect(pads.get('remote-1').revision).toBe(0);
  });
});
