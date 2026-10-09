import { describe, expect, it, vi } from 'vitest';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { normalizeProjectPath as norm } from '../src/session/project-identity.js';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';

class FakePtyProcess implements PtyProcess {
  pid = 4321;
  writes: string[] = [];
  onData(_callback: (data: string) => void): void {}
  onExit(_callback: (exitCode: { exitCode: number; signal?: number }) => void): void {}
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  kill(): void {}
}

class InMemorySessionManager {
  sessions = new Map<string, any>();
  addSession(session: any): void { this.sessions.set(session.id, session); }
  hasSession(id: string): boolean { return this.sessions.has(id); }
  getSession(id: string): any { return this.sessions.get(id); }
  updateSession(id: string, session: any): void { this.sessions.set(id, session); }
}

describe('spawnConfiguredSession', () => {
  it('spawns the built-in shell with an empty command and no configured CLI types', () => {
    const pty = new FakePtyProcess();
    const spawned: Array<{ file: string; args: string[] }> = [];
    const ptyFactory: PtyFactory = {
      spawn(file, args) {
        spawned.push({ file, args });
        return pty;
      },
    };
    const ptyManager = new PtyManager(ptyFactory);
    const sessionManager = new InMemorySessionManager();

    const result = spawnConfiguredSession({
      ptyManager,
      sessionManager: sessionManager as any,
      sessionId: 'shell-no-cli-config',
      cliType: 'shell',
      command: '',
      args: [],
    });

    expect(result.pty).toBe(pty);
    expect(spawned).toHaveLength(1);
    expect(pty.writes).toEqual([]);
    expect(sessionManager.getSession('shell-no-cli-config')).toMatchObject({
      id: 'shell-no-cli-config',
      cliType: 'shell',
      name: 'Shell',
      processId: 4321,
    });
  });

  it('updates an existing session when resuming with the same session id', () => {
    const addSession = vi.fn();
    const updateSession = vi.fn();
    const hasSession = vi.fn().mockReturnValue(true);
    const ptyManager = {
      spawn: vi.fn().mockReturnValue({ pid: 1234 }),
      write: vi.fn(),
    };
    const sessionManager = {
      addSession,
      updateSession,
      hasSession,
      getSession: () => undefined,
    };

    const result = spawnConfiguredSession({
      ptyManager: ptyManager as any,
      sessionManager: sessionManager as any,
      sessionId: 'sess-restore',
      cliType: 'claude-code',
      // Explicit command: with no configLoader there is no spawnCommand, and the
      // `command: cliType` fallback is gone.
      command: 'claude',
      cwd: 'X:\\coding\\gamepad-cli-hub',
      resumeSessionName: 'resume-123',
    });

    expect(result.sessionId).toBe('sess-restore');
    expect(hasSession).toHaveBeenCalledWith('sess-restore');
    expect(updateSession).toHaveBeenCalledWith('sess-restore', expect.objectContaining({
      id: 'sess-restore',
      cliType: 'claude-code',
      cliSessionName: 'resume-123',
      processId: 1234,
      workingDir: norm('X:\\coding\\gamepad-cli-hub'),
    }));
    expect(addSession).not.toHaveBeenCalled();
  });

  it('adds a new session during a normal spawn', () => {
    const addSession = vi.fn();
    const updateSession = vi.fn();
    const hasSession = vi.fn().mockReturnValue(false);
    const ptyManager = {
      spawn: vi.fn().mockReturnValue({ pid: 4321 }),
      write: vi.fn(),
    };
    const sessionManager = {
      addSession,
      updateSession,
      hasSession,
      getSession: () => undefined,
    };

    spawnConfiguredSession({
      ptyManager: ptyManager as any,
      sessionManager: sessionManager as any,
      sessionId: 'sess-new',
      cliType: 'claude-code',
      // Explicit command: with no configLoader there is no spawnCommand, and the
      // `command: cliType` fallback is gone.
      command: 'claude',
      cwd: 'X:\\coding\\gamepad-cli-hub',
    });

    expect(addSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sess-new',
      cliType: 'claude-code',
      processId: 4321,
      workingDir: norm('X:\\coding\\gamepad-cli-hub'),
    }));
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('registers role and lock in the same add, so the operator never appears as a plain row', () => {
    const addSession = vi.fn();
    spawnConfiguredSession({
      ptyManager: { spawn: vi.fn().mockReturnValue({ pid: 1 }), write: vi.fn() } as any,
      sessionManager: { addSession, updateSession: vi.fn(), hasSession: () => false, getSession: () => undefined } as any,
      sessionId: 'op',
      command: 'claude',
      role: 'operator',
      locked: true,
    });
    expect(addSession).toHaveBeenCalledTimes(1);
    expect(addSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'op', role: 'operator', locked: true }));
  });
});

describe('spawnConfiguredSession — API tools', () => {
  it('adopts a Helm-hosted API session instead of spawning a CLI, and flags the row', async () => {
    const { ApiSessionHost, registerApiSessionHost } = await import('../src/session/api/api-session-host.js');
    registerApiSessionHost(new ApiSessionHost({
      dispatchTool: async () => ({}),
      postChat: async () => ({}),
      createMemory: () => ({ id: 'm' }),
      linkMemory: () => {},
      mcpTools: () => [],
      listSkills: () => [],
      getMission: () => undefined,
      recordToolRequest: () => {},
      emitHook: () => {},
      historyDir: 'unused-no-turns-run',
    }));
    try {
      const ptyManager = { spawn: vi.fn(), adopt: vi.fn(), write: vi.fn() };
      const addSession = vi.fn();
      const api = { baseUrl: 'http://127.0.0.1:8080/v1', model: 'minicpm', allowedTools: ['Read'] };
      const configLoader = {
        resolveCliType: () => ({ id: 'api-type', config: { name: 'Mini', displayName: 'Mini', api } }),
        getCliTypeEntry: () => ({ name: 'Mini', api }),
      };

      const result = spawnConfiguredSession({
        ptyManager: ptyManager as any,
        sessionManager: { addSession, updateSession: vi.fn(), hasSession: () => false, getSession: () => undefined } as any,
        configLoader: configLoader as any,
        cliType: 'api-type',
        cwd: 'X:\coding\gamepad-cli-hub',
      });

      // No spawnCommand exists on an API type — resolving one would throw.
      expect(ptyManager.spawn).not.toHaveBeenCalled();
      expect(ptyManager.adopt).toHaveBeenCalledWith(result.sessionId, result.pty, expect.any(Object));
      expect(addSession).toHaveBeenCalledWith(expect.objectContaining({ apiTool: true, processId: 0, name: 'Mini' }));
    } finally {
      registerApiSessionHost(null);
    }
  });
});
