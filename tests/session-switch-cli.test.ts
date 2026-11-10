/**
 * session_switch_cli — continue a session under another CLI. The new session
 * spawns in the source's directory and runtime group with a first prompt that
 * points at a stripped copy of the source transcript; the source then closes.
 *
 * Real HelmSessionService and real RuntimeGroupManager; the spawn boundary is
 * recorded so the assertion is on what the new CLI would receive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callMcpTool, type McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';

const { spawnCalls, spawnFailure } = vi.hoisted(() => ({
  spawnCalls: [] as Array<Record<string, unknown>>,
  spawnFailure: { enabled: false },
}));
vi.mock('../src/session/configured-session-spawn.js', () => ({
  spawnConfiguredSession: (params: Record<string, unknown>) => {
    const prepare = params.prepareSession as ((sessionId: string) => { sessionContext?: unknown; rollback?: () => void }) | undefined;
    const preparation = prepare?.('new-sid');
    spawnCalls.push({ ...params, sessionContext: preparation?.sessionContext });
    if (spawnFailure.enabled) {
      preparation?.rollback?.();
      throw new Error('launch failed');
    }
    return { sessionId: 'new-sid' };
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';
import { RuntimeGroupManager } from '../src/session/runtime-group-manager.js';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import { DraftManager } from '../src/session/draft-manager.js';
import { TodoManager } from '../src/session/todo-manager.js';
import type { Draft } from '../src/types/draft.js';
import type { SessionInfo } from '../src/types/session.js';

let dir: string;

function setup(patch: Partial<SessionInfo> = {}) {
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, JSON.stringify({ type: 'user', message: { content: 'port the parser to Rust' } }));
  const sessions = new Map<string, SessionInfo>([['old-sid', {
    id: 'old-sid', name: 'parser', cliType: 'claude-code', processId: 1,
    workingDir: '/repo/main', cliTranscriptPath: log, ...patch,
  }]]);
  const sessionManager = {
    getAllSessions: () => [...sessions.values()],
    getSession: (id: string) => sessions.get(id) ?? null,
    hasSession: (id: string) => sessions.has(id),
    updateSession: (id: string, updates: Partial<SessionInfo>) => Object.assign(sessions.get(id)!, updates),
    removeSession: (id: string) => { sessions.delete(id); artifacts.clearSession(id); },
  };
  const artifacts = new ArtifactManager();
  const manifesto = artifacts.create('old-sid', 'Working agreement', 'markdown', '# notes');
  artifacts.setIntent(manifesto.id, 'manifesto');
  const killed: string[] = [];
  const configLoader = {
    getWorkingDirectories: () => [{ path: '/repo/main', name: 'main' }],
    getCliTypes: () => [],
    resolveCliType: (ref: string) => (ref === 'codex' ? { id: ref, config: { name: 'Codex', spawnCommand: 'codex' } } : null),
  };
  let planOwner = patch.currentPlanId ? 'old-sid' : undefined;
  const planManager = {
    claimedItemFor: (sessionId: string) => planOwner === sessionId ? { id: patch.currentPlanId } : null,
    claimPlan: (_id: string, sessionId: string) => { planOwner = sessionId; return true; },
  };
  const service = new HelmSessionService(
    sessionManager as any, { kill: (id: string) => killed.push(id) } as any, configLoader as any, planManager as any,
  );
  const groups = new RuntimeGroupManager();
  service.setRuntimeGroupManager(groups);
  service.setSessionArtifactCopier((from, to) => {
    artifacts.copySession(from, to);
    return () => artifacts.clearSession(to);
  });
  const todoFiles = new Map<string, any[]>();
  const todos = new TodoManager({
    load: id => todoFiles.get(id) ?? null,
    save: (id, items) => { todoFiles.set(id, items); },
    remove: id => { todoFiles.delete(id); return true; },
    list: () => [...todoFiles.keys()],
  }, () => 'todo-1', () => 1);
  todos.add('old-sid', 'Resume parser work');
  service.setSessionTodoCopier((from, to) => todos.copySession(from, to));
  const padFiles = new Map<string, Draft>();
  const pads = new DraftManager({
    load: id => padFiles.get(id) ?? null,
    save: pad => { padFiles.set(pad.sessionId, pad); },
    remove: id => { padFiles.delete(id); },
    list: () => [...padFiles.keys()],
    loadHistory: () => [],
    saveHistory: () => {},
  });
  pads.set('old-sid', 'todo: lexer', 'user', 0);
  service.setSessionDraftCopier((from, to) => pads.copySession(from, to));
  return { service, sessions, killed, groups, artifacts, pads, todos, planOwner: () => planOwner };
}

describe('HelmSessionService.switchCli', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnFailure.enabled = false;
    dir = mkdtempSync(join(tmpdir(), 'helm-switch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('spawns the new CLI in the same dir and group, pointed at the stripped transcript, and closes the source', () => {
    const { service, sessions, killed, groups } = setup();
    const group = groups.create('Parser work');
    groups.addSession(group.id, 'old-sid');

    const result = service.switchCli('old-sid', 'codex', { handover: 'next: lexer' });

    expect(spawnCalls[0]).toMatchObject({ cliType: 'codex', cwd: '/repo/main', sessionName: 'parser' });
    const prompt = String(spawnCalls[0].contextText);
    expect(prompt).toContain(result.transcriptFile);
    expect(prompt).toContain('next: lexer');
    expect(readFileSync(result.transcriptFile, 'utf8')).toContain('port the parser to Rust');
    expect(groups.groupForSession('new-sid')?.id).toBe(group.id);
    expect(result).toMatchObject({ oldSessionId: 'old-sid', newSessionId: 'new-sid', sourceClosed: true });
    expect(killed).toEqual(['old-sid']);
    expect(sessions.has('old-sid')).toBe(false);
    rmSync(result.transcriptFile, { force: true });
  });

  it('copies the source artifacts to the new session before the source closes', () => {
    const { service, artifacts } = setup();

    const result = service.switchCli('old-sid', 'codex');

    expect(artifacts.getForSession('new-sid').map(a => a.title)).toEqual(['Working agreement']);
    rmSync(result.transcriptFile, { force: true });
  });

  it('seeds manifestos, mission, todos, and the active plan before the successor starts', () => {
    const mission = { text: 'Finish the parser', setBy: 'user' as const, setAt: 5 };
    const { service, sessions, artifacts, todos, planOwner } = setup({ mission, currentPlanId: 'plan-1' });

    service.switchCli('old-sid', 'codex');

    expect(artifacts.getManifestosForSession('new-sid').map(a => a.title)).toEqual(['Working agreement']);
    expect(todos.list('new-sid')).toEqual(todos.list('old-sid'));
    expect(spawnCalls[0].sessionContext).toEqual({ mission, currentPlanId: 'plan-1' });
    expect(planOwner()).toBe('new-sid');
    expect(sessions.get('old-sid')?.currentPlanId).toBeUndefined();
  });

  it('rolls back seeded state when the successor process fails to spawn', () => {
    const mission = { text: 'Finish the parser', setBy: 'user' as const, setAt: 5 };
    const { service, sessions, artifacts, todos, killed, planOwner } = setup({ mission, currentPlanId: 'plan-1' });
    spawnFailure.enabled = true;

    expect(() => service.switchCli('old-sid', 'codex')).toThrow('launch failed');

    expect(artifacts.getForSession('new-sid')).toEqual([]);
    expect(todos.list('new-sid')).toEqual([]);
    expect(planOwner()).toBe('old-sid');
    expect(sessions.get('old-sid')).toMatchObject({ mission, currentPlanId: 'plan-1' });
    expect(killed).toEqual([]);
    const transcriptFile = String(spawnCalls[0].contextText).match(/at: ([^\r\n]+)/)?.[1];
    if (transcriptFile) rmSync(transcriptFile, { force: true });
  });

  it('hands the draft to the replacement, but not to a session that leaves the source open', () => {
    const switched = setup();
    switched.service.switchCli('old-sid', 'codex');
    expect(switched.pads.get('new-sid').text).toBe('todo: lexer');
    expect(switched.pads.get('old-sid').text).toBe('todo: lexer'); // still there for a restore

    for (const kept of [setup(), setup({ locked: true })]) {
      kept.service.switchCli('old-sid', 'codex', { closeSource: false });
      expect(kept.pads.get('new-sid').text).toBe('');
    }
    const locked = setup({ locked: true });
    locked.service.switchCli('old-sid', 'codex');
    expect(locked.pads.get('new-sid').text).toBe('');
  });

  it('keeps the source when asked to, or when it is locked', () => {
    const kept = setup();
    expect(kept.service.switchCli('old-sid', 'codex', { closeSource: false }).sourceClosed).toBe(false);
    expect(kept.sessions.has('old-sid')).toBe(true);

    const locked = setup({ locked: true });
    expect(locked.service.switchCli('old-sid', 'codex').sourceClosed).toBe(false);
    expect(locked.killed).toEqual([]);
  });

  it('fails before spawning when the target CLI or the transcript is unknown', () => {
    expect(() => setup().service.switchCli('old-sid', 'nope')).toThrow();
    expect(() => setup({ cliTranscriptPath: undefined }).service.switchCli('old-sid', 'codex')).toThrow(/No transcript known/);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('HelmSessionService.cloneSession', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnFailure.enabled = false;
    dir = mkdtempSync(join(tmpdir(), 'helm-clone-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('spawns the same CLI as "<name> (clone)" in the same dir and group, reading the transcript, and keeps the source', () => {
    const { service, sessions, killed, groups } = setup({ cliType: 'codex' });
    const group = groups.create('Parser work');
    groups.addSession(group.id, 'old-sid');

    const result = service.cloneSession('old-sid');

    expect(spawnCalls[0]).toMatchObject({ cliType: 'codex', cwd: '/repo/main', sessionName: 'parser (clone)' });
    expect(String(spawnCalls[0].contextText)).toContain(result.transcriptFile);
    expect(groups.groupForSession('new-sid')?.id).toBe(group.id);
    expect(result).toMatchObject({ oldSessionId: 'old-sid', newSessionId: 'new-sid', sourceClosed: false });
    expect(killed).toEqual([]);
    expect(sessions.has('old-sid')).toBe(true);
    rmSync(result.transcriptFile, { force: true });
  });

  it('clones with the requested CLI and rejects an unknown CLI before spawning', () => {
    const { service, sessions, killed } = setup({ cliType: 'claude-code' });

    const result = service.cloneSession('old-sid', { cliType: 'codex' });

    expect(spawnCalls[0]).toMatchObject({ cliType: 'codex', sessionName: 'parser (clone)' });
    expect(result.sourceClosed).toBe(false);
    expect(sessions.has('old-sid')).toBe(true);
    expect(killed).toEqual([]);
    rmSync(result.transcriptFile, { force: true });

    spawnCalls.length = 0;
    const unknown = setup({ cliType: 'claude-code' });
    expect(() => unknown.service.cloneSession('old-sid', { cliType: 'no-such-cli' })).toThrow(/Unknown CLI type/);
    expect(spawnCalls).toHaveLength(0);
  });

  it('forwards cliType from MCP session_clone into the real service', async () => {
    const { service } = setup({ cliType: 'claude-code' });
    const deps: McpToolDispatcherDeps = {
      service: service as unknown as HelmControlService,
      setPlanStateWithValidation: () => ({}),
      completePlanWithValidation: () => ({}),
    };

    const result = await callMcpTool(deps, 'session_clone', { sessionId: 'old-sid', cliType: 'codex' }, {});

    expect(spawnCalls[0]).toMatchObject({ cliType: 'codex', sessionName: 'parser (clone)' });
    expect((result as { sourceClosed: boolean }).sourceClosed).toBe(false);
    rmSync((result as { transcriptFile: string }).transcriptFile, { force: true });
  });

  it('copies artifacts to the clone and leaves the source its own', () => {
    const { service, artifacts, todos, planOwner } = setup({
      cliType: 'codex',
      mission: { text: 'Finish the parser', setBy: 'user', setAt: 5 },
      currentPlanId: 'plan-1',
    });

    const result = service.cloneSession('old-sid');

    expect(artifacts.getForSession('new-sid').map(a => a.title)).toEqual(['Working agreement']);
    expect(todos.list('new-sid')).toEqual([]);
    expect(spawnCalls[0].sessionContext).toBeUndefined();
    expect(planOwner()).toBe('old-sid');
    expect(artifacts.count('old-sid')).toBe(1);
    rmSync(result.transcriptFile, { force: true });
  });
});
