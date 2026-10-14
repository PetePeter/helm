/**
 * A dream digests session-bound memories: it is the one caller that may read,
 * drop, merge and promote what other sessions of its project auto-saved.
 * Everything here runs the real MemoryManager and the real MCP dispatcher.
 */

import { describe, expect, it } from 'vitest';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { buildDreamGuide } from '../src/mcp/guides/dream-guide.js';
import { MemoryAttachmentManager } from '../src/session/memory-attachment-manager.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { MEMORY_DREAM_MIN_CANDIDATES } from '../src/types/memory.js';

const PROJECT = 'project-alpha';
const DREAMER = 'dream-session';

function setup() {
  const projects: Record<string, string | null> = {
    s1: PROJECT, s2: PROJECT, closed: PROJECT, [DREAMER]: PROJECT,
    outsider: 'project-beta', 'beta-dreamer': 'project-beta',
  };
  const missions: Record<string, string> = { s1: 'Wire the RS485 charger', s2: 'Fix the preview build' };
  const dreamers = new Set([DREAMER, 'beta-dreamer']);
  let clock = 1_000;
  let sequence = 0;
  const manager = new MemoryManager({
    persist: () => {},
    now: () => ++clock,
    idFactory: () => `m${++sequence}`,
    resolveSessionProject: (sessionId) => projects[sessionId] ?? null,
    resolveSessionMission: (sessionId) => missions[sessionId] ?? null,
    isDreamSession: (sessionId) => dreamers.has(sessionId),
  });
  const bind = (sessionId: string, tldr: string) =>
    manager.createForSession(sessionId, { tldr, content: `${tldr}.`, sessionBound: true, sourceTurn: 'turn-1' });
  return { manager, bind, closeSession: (sessionId: string) => { delete missions[sessionId]; } };
}

function setupMcp() {
  const context = setup();
  const service = new HelmControlService({} as never, {} as never, {} as never, {} as never);
  service.setMemoryManager(context.manager, {} as MemoryAttachmentManager);
  const deps = { service, setPlanStateWithValidation: () => undefined, completePlanWithValidation: () => undefined };
  return { ...context, call: (tool: string, args: Record<string, unknown>, sessionId: string) => callMcpTool(deps, tool, args, { sessionId }) };
}

describe('dream candidates: session-bound memories', () => {
  it('groups bound memories by session with each session\'s mission', () => {
    const { manager, bind } = setup();
    const a1 = bind('s1', 'EG004 needs 9600 baud');
    const b1 = bind('s2', 'Preview server listens on 4173');
    const a2 = bind('s1', 'RS485 A/B are swapped on the board');
    manager.createForSession('s1', { tldr: 'ordinary project memory', content: 'body' });

    const dream = manager.dreamForSession(DREAMER);

    expect(dream.bound).toEqual([
      { sessionId: 's1', mission: 'Wire the RS485 charger', memories: [
        expect.objectContaining({ id: a1.id, tldr: a1.tldr, content: a1.content }),
        expect.objectContaining({ id: a2.id, tldr: a2.tldr, content: a2.content }),
      ] },
      { sessionId: 's2', mission: 'Fix the preview build', memories: [expect.objectContaining({ id: b1.id })] },
    ]);
    expect(dream.totals.bound).toBe(3);
    expect([...dream.faded, ...dream.salient].map((candidate) => candidate.id)).not.toContain(a1.id);
  });

  it('includes the bound memories of a session that no longer exists, with no mission', () => {
    const { manager, bind, closeSession } = setup();
    const kept = bind('closed', 'The CI cache key includes the lockfile hash');
    closeSession('closed');
    manager.purgeSession('closed');

    expect(manager.dreamForSession(DREAMER).bound).toEqual([
      { sessionId: 'closed', mission: null, memories: [expect.objectContaining({ id: kept.id })] },
    ]);
  });

  it('caps the list oldest first and reports how many are waiting in all', () => {
    const { manager, bind } = setup();
    const all = Array.from({ length: MEMORY_DREAM_MIN_CANDIDATES + 2 }, (_, index) => bind(index % 2 ? 's2' : 's1', `fact ${index}`));

    const dream = manager.dreamForSession(DREAMER, { maxCandidates: MEMORY_DREAM_MIN_CANDIDATES });
    const listed = dream.bound.flatMap((group) => group.memories.map((memory) => memory.id));

    expect(listed.sort()).toEqual(all.slice(0, MEMORY_DREAM_MIN_CANDIDATES).map((record) => record.id).sort());
    expect(dream.totals.bound).toBe(all.length);
  });

  it('leaves out other projects\' bound memories and ones already set aside', () => {
    const { manager, bind } = setup();
    bind('outsider', 'another project\'s finding');
    const dormant = bind('s1', 'set aside');
    manager.setDormant(dormant.id, true);

    const dream = manager.dreamForSession(DREAMER);

    expect(dream.bound).toEqual([]);
    expect(dream.totals.bound).toBe(0);
  });

  it('shows a session that is not dreaming no bound memories, its own included', () => {
    const { manager, bind } = setup();
    bind('s1', 'EG004 needs 9600 baud');

    for (const sessionId of ['s1', 's2']) {
      const dream = manager.dreamForSession(sessionId);
      expect(dream.bound).toEqual([]);
      expect(dream.totals.bound).toBe(0);
    }
  });
});

describe('digesting a bound memory', () => {
  it('lets the dream read, search and rewrite another session\'s bound memory', () => {
    const { manager, bind } = setup();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    expect(manager.getRecordForSession(DREAMER, saved.id)?.content).toBe(saved.content);
    expect(manager.searchForSession(DREAMER, 'baud').hits.map((hit) => hit.id)).toEqual([saved.id]);
    expect(manager.updateForSession(DREAMER, saved.id, { tldr: 'EG004 charger: RS485 runs at 9600 baud' })?.tldr)
      .toBe('EG004 charger: RS485 runs at 9600 baud');
    expect(manager.getRecordForSession('s2', saved.id)).toBeNull();
  });

  it('promotes: the binding is cleared and every session of the project sees the memory', () => {
    const { manager, bind } = setup();
    const saved = bind('s1', 'EG004 needs 9600 baud');
    const authored = manager.getRecordForSession('s1', saved.id)!.updatedAt;

    expect(manager.updateForSession(DREAMER, saved.id, { promote: true })?.id).toBe(saved.id);

    const promoted = manager.getRecordForSession('s2', saved.id)!;
    expect(promoted.sessionBound).toBeUndefined();
    expect(promoted.sourceTurn).toBeUndefined();
    expect(promoted.updatedAt).toBe(authored);
    expect(manager.listBoundForSession('s1')).toEqual([]);
    expect(manager.dreamForSession(DREAMER).totals).toMatchObject({ bound: 0, memories: 1 });
  });

  it('merges: the bound duplicate is linked into the project atom, then deleted for everyone', () => {
    const { manager, bind } = setup();
    const atom = manager.createForSession('s2', { tldr: 'EG004 RS485 baud rate', content: '9600 baud.' });
    const duplicate = bind('s1', 'EG004 needs 9600 baud');

    expect(manager.linkForSession(DREAMER, atom.id, duplicate.id, 'supersedes')).toBe(true);
    expect(manager.deleteForSession(DREAMER, duplicate.id)).toBe(true);

    expect(manager.getRecordForSession('s1', duplicate.id)).toBeNull();
    expect(manager.listBoundForSession('s1')).toEqual([]);
    expect(manager.getRecordForSession('s1', atom.id)?.id).toBe(atom.id);
  });

  it('refuses promotion to any session that is not dreaming, the owner included', () => {
    const { manager, bind } = setup();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    for (const sessionId of ['s1', 's2', 'outsider']) {
      expect(() => manager.updateForSession(sessionId, saved.id, { promote: true })).toThrow('Only a dream may promote');
    }
    expect(manager.getRecordForSession('s2', saved.id)).toBeNull();
  });

  it('keeps another project\'s dream out: no read, no promote', () => {
    const { manager, bind } = setup();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    expect(manager.getRecordForSession('beta-dreamer', saved.id)).toBeNull();
    expect(manager.searchForSession('beta-dreamer', 'baud').hits).toEqual([]);
    expect(manager.updateForSession('beta-dreamer', saved.id, { promote: true })).toBeNull();
    expect(manager.getRecordForSession('s2', saved.id)).toBeNull();
  });
});

describe('MCP: memory_update promote', () => {
  it('promotes for a dream and can sharpen the tldr in the same call', async () => {
    const { bind, call } = setupMcp();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    const result = await call('memory_update', { id: saved.id, tldr: 'EG004 charger: RS485 runs at 9600 baud', promote: true }, DREAMER) as { tldr: string; sessionBound?: boolean };

    expect(result).toMatchObject({ id: saved.id, tldr: 'EG004 charger: RS485 runs at 9600 baud' });
    expect(result.sessionBound).toBeUndefined();
    expect(await call('memory_get', { id: saved.id }, 's2')).toMatchObject({ entries: [{ id: saved.id }] });
  });

  it('promotes without any other change', async () => {
    const { bind, call } = setupMcp();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    expect(await call('memory_update', { id: saved.id, promote: true }, DREAMER)).toMatchObject({ id: saved.id, tldr: saved.tldr });
    expect(await call('memory_get', { id: saved.id }, 's2')).toMatchObject({ entries: [{ id: saved.id }] });
  });

  it('rejects promote from a normal session and changes nothing', async () => {
    const { manager, bind, call } = setupMcp();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    await expect(call('memory_update', { id: saved.id, tldr: 'rewritten', promote: true }, 's1')).rejects.toThrow('Only a dream may promote');
    await expect(call('memory_update', { id: saved.id, promote: true }, 's2')).rejects.toThrow('Only a dream may promote');

    expect(manager.listBoundForSession('s1')).toEqual([expect.objectContaining({ id: saved.id, tldr: saved.tldr, sessionBound: true })]);
  });

  it('leaves the binding in place when the rewrite is refused as stale', async () => {
    const { manager, bind, call } = setupMcp();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    await expect(call('memory_update', { id: saved.id, tldr: 'rewritten', promote: true, expectedUpdatedAt: saved.updatedAt - 1 }, DREAMER))
      .rejects.toThrow('updated concurrently');
    await expect(call('memory_update', { id: saved.id, promote: true, expectedUpdatedAt: saved.updatedAt - 1 }, DREAMER))
      .rejects.toThrow('updated concurrently');

    expect(manager.getRecordForSession('s2', saved.id)).toBeNull();
    expect(manager.listBoundForSession('s1')).toEqual([expect.objectContaining({ id: saved.id, tldr: saved.tldr })]);
  });

  it('lists the bound groups in memory_dream only for a dream', async () => {
    const { bind, call } = setupMcp();
    const saved = bind('s1', 'EG004 needs 9600 baud');

    expect(await call('memory_dream', {}, DREAMER)).toMatchObject({ bound: [{ sessionId: 's1', memories: [{ id: saved.id }] }] });
    expect(await call('memory_dream', {}, 's2')).toMatchObject({ bound: [] });
  });
});

describe('dream guide', () => {
  it('names only real tools, including the ones digesting needs', () => {
    const tools = JSON.parse(/^tools = (\[.*\])$/m.exec(buildDreamGuide())![1]) as string[];
    const known = new Set(MCP_TOOLS.map((tool) => tool.name));

    expect(tools.filter((tool) => !known.has(tool))).toEqual([]);
    expect(tools).toEqual(expect.arrayContaining(['memory_dream', 'memory_update', 'memory_delete', 'memory_link']));
    expect(MCP_TOOLS.find((tool) => tool.name === 'memory_update')!.inputSchema.properties).toHaveProperty('promote');
  });
});
