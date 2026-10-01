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

const spawnCalls: Array<Record<string, unknown>> = [];
vi.mock('../src/session/configured-session-spawn.js', () => ({
  spawnConfiguredSession: (params: Record<string, unknown>) => {
    spawnCalls.push(params);
    return { sessionId: 'new-sid' };
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';
import { RuntimeGroupManager } from '../src/session/runtime-group-manager.js';
import { ArtifactManager } from '../src/session/artifact-manager.js';
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
    removeSession: (id: string) => { sessions.delete(id); artifacts.clearSession(id); },
  };
  const artifacts = new ArtifactManager();
  artifacts.create('old-sid', 'Findings', 'markdown', '# notes');
  const killed: string[] = [];
  const configLoader = {
    getWorkingDirectories: () => [{ path: '/repo/main', name: 'main' }],
    getCliTypes: () => [],
    resolveCliType: (ref: string) => (ref === 'codex' ? { id: ref, config: { name: 'Codex', spawnCommand: 'codex' } } : null),
  };
  const service = new HelmSessionService(
    sessionManager as any, { kill: (id: string) => killed.push(id) } as any, configLoader as any, {} as any,
  );
  const groups = new RuntimeGroupManager();
  service.setRuntimeGroupManager(groups);
  service.setSessionArtifactCopier((from, to) => { artifacts.copySession(from, to); });
  return { service, sessions, killed, groups, artifacts };
}

describe('HelmSessionService.switchCli', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
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

    expect(artifacts.getForSession('new-sid').map(a => a.title)).toEqual(['Findings']);
    rmSync(result.transcriptFile, { force: true });
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

  it('copies artifacts to the clone and leaves the source its own', () => {
    const { service, artifacts } = setup({ cliType: 'codex' });

    const result = service.cloneSession('old-sid');

    expect(artifacts.getForSession('new-sid').map(a => a.title)).toEqual(['Findings']);
    expect(artifacts.count('old-sid')).toBe(1);
    rmSync(result.transcriptFile, { force: true });
  });
});
