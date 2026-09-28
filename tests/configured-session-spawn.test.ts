import { describe, expect, it, vi } from 'vitest';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { normalizeProjectPath as norm } from '../src/session/project-identity.js';

describe('spawnConfiguredSession', () => {
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
