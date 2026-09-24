/**
 * cliThreadId — the CLI's own session/thread id, captured from hook events, is
 * what `{cliThreadId}` resume templates resolve to (codex resumes by thread UUID
 * because name-based resume is ambiguous across history pages).
 *
 * Real SessionManager, real session-persistence round-tripped through a unique
 * temp file, real recycle-bin capture helper, real spawnConfiguredSession. The
 * only fakes are the PTY (a recording spawner) and the config loader (one CLI entry).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let persisted: SessionInfo[] = [];
vi.mock('../src/session/persistence.js', () => ({
  saveSessions: (sessions: SessionInfo[]) => { persisted = sessions.map(s => ({ ...s })); },
  loadSessions: () => persisted.map(s => ({ ...s })),
}));

vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  saveRecycleBin: () => {},
  loadRecycleBin: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { saveSessions, loadSessions } = await import('../src/session/session-persistence.js');
const { RecycleBinManager, recordRemovedSession } = await import('../src/session/recycle-bin-manager.js');
const { spawnConfiguredSession } = await import('../src/session/configured-session-spawn.js');

const THREAD = '01a0c9ba-7bef-7f91-b5e7-1b7c54e5bbb9';
const NAME = '04afa362-9f1d-45c8-963d-1b93de377ab4';

function makeSession(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'fixing converter',
    cliType: 'codex',
    processId: 1,
    workingDir: 'X:/work',
    cliSessionName: NAME,
    ...patch,
  };
}

describe('cliThreadId persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helm-thread-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('survives serialize → load', () => {
    const file = join(dir, 'sessions.yaml');
    saveSessions([makeSession({ cliThreadId: THREAD })], file);
    expect(loadSessions(file)[0].cliThreadId).toBe(THREAD);
  });

  it('drops a non-string value on load', () => {
    const file = join(dir, 'sessions.yaml');
    saveSessions([makeSession({ cliThreadId: 42 as never })], file);
    expect(loadSessions(file)[0].cliThreadId).toBeUndefined();
  });

  it('is carried into the recycle-bin entry on close', () => {
    const entry = recordRemovedSession(
      { sessionId: 'sess-1', session: makeSession({ cliThreadId: THREAD }), timestamp: Date.now() } as never,
      new RecycleBinManager(),
      () => {},
    );
    expect(entry?.cliThreadId).toBe(THREAD);
  });
});

describe('{cliThreadId} resume resolution', () => {
  let sessionManager: InstanceType<typeof SessionManager>;
  let rawCommands: Array<string | undefined>;
  const ptyManager = {
    spawn: (opts: { rawCommand?: string }) => { rawCommands.push(opts.rawCommand); return { pid: 99 }; },
    write: () => {},
  };
  const configLoader = {
    resolveCliType: () => ({
      id: 'codex',
      config: {
        name: 'Codex',
        spawnCommand: 'codex',
        resumeCommand: 'codex resume {cliThreadId} --name helm-{cliSessionName}',
      },
    }),
    getCliTypeEntry: () => undefined,
  };

  beforeEach(() => {
    persisted = [];
    rawCommands = [];
    sessionManager = new SessionManager();
  });

  const resume = (resumeThreadId?: string): string | undefined => {
    spawnConfiguredSession({
      ptyManager: ptyManager as never,
      sessionManager,
      configLoader: configLoader as never,
      sessionId: 'sess-1',
      cliType: 'codex',
      resumeSessionName: NAME,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    });
    return rawCommands[rawCommands.length - 1];
  };

  it('substitutes the thread id stored on the restored session (and still {cliSessionName})', () => {
    sessionManager.addSession(makeSession({ cliThreadId: THREAD }));
    expect(resume()).toBe(`codex resume ${THREAD} --name helm-${NAME}`);
  });

  it('keeps the thread id on the session after the resume re-spawn', () => {
    sessionManager.addSession(makeSession({ cliThreadId: THREAD }));
    resume();
    expect(sessionManager.getSession('sess-1')?.cliThreadId).toBe(THREAD);
  });

  it('uses an explicit resumeThreadId (recycle-bin restore: the session is gone)', () => {
    expect(resume(THREAD)).toBe(`codex resume ${THREAD} --name helm-${NAME}`);
    expect(sessionManager.getSession('sess-1')?.cliThreadId).toBe(THREAD);
  });

  it('leaves the placeholder literal when no id was ever captured — no fallback', () => {
    sessionManager.addSession(makeSession());
    expect(resume()).toBe(`codex resume {cliThreadId} --name helm-${NAME}`);
  });
});
