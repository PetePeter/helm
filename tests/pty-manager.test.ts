import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyManager, resolvePtyShell } from '../src/session/pty-manager';
import type { PtyProcess, PtyFactory } from '../src/session/pty-manager';


// Shell args the current platform's PTY is spawned with (Windows: none; Unix: -il login shell).
const expectedShellArgs = process.platform === 'win32' ? [] : ['-il'];

/** Create a mock PtyProcess with controllable callbacks. */
function createMockPty(pid = 1234): {
  pty: PtyProcess;
  triggerData: (data: string) => void;
  triggerExit: (exitCode: number) => void;
} {
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((exit: { exitCode: number; signal?: number }) => void) | undefined;

  const pty: PtyProcess = {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => { dataCallback = cb; },
    onExit: (cb) => { exitCallback = cb; },
  };

  return {
    pty,
    triggerData: (data: string) => dataCallback?.(data),
    triggerExit: (exitCode: number) => exitCallback?.({ exitCode }),
  };
}

function createMockFactory(mockPty: PtyProcess): PtyFactory {
  return { spawn: vi.fn().mockReturnValue(mockPty) };
}

describe('PtyManager', () => {
  let manager: PtyManager;
  let mock: ReturnType<typeof createMockPty>;
  let factory: PtyFactory;

  beforeEach(() => {
    mock = createMockPty(42);
    factory = createMockFactory(mock.pty);
    manager = new PtyManager(factory);
  });

  describe('spawn', () => {
    it('creates a PTY and stores it by session ID', () => {
      manager.spawn({ sessionId: 's1', command: 'echo hello' });

      expect(manager.has('s1')).toBe(true);
      expect(manager.getPid('s1')).toBe(42);
      expect(manager.getSessionIds()).toEqual(['s1']);
    });

    it('throws if a PTY already exists for the session', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });

      expect(() => manager.spawn({ sessionId: 's1', command: 'test2' })).toThrow(
        'PTY already exists for session: s1',
      );
    });

    it('writes command to PTY on spawn', () => {
      manager.spawn({ sessionId: 's1', command: 'echo', args: ['hello'] });
      expect(mock.pty.write).toHaveBeenCalledWith('echo hello\r');
    });

    it('writes command without args when args is empty', () => {
      manager.spawn({ sessionId: 's1', command: 'whoami' });
      expect(mock.pty.write).toHaveBeenCalledWith('whoami\r');
    });

    it('writes nothing when the command is empty', () => {
      // doSpawnShell() passes '' so the bare platform shell opens with no
      // initial command. It used to pass 'cmd.exe', which POSIX shells
      // answered with "command not found".
      manager.spawn({ sessionId: 's1', command: '' });
      expect(mock.pty.write).not.toHaveBeenCalled();
    });

    it('passes cols/rows to factory', () => {
      manager.spawn({ sessionId: 's1', command: 'test', cols: 80, rows: 24 });

      expect(factory.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expectedShellArgs,
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    });

    it('passes merged environment variables to the factory', () => {
      manager.spawn({
        sessionId: 's1',
        command: 'test',
        env: { COPILOT_MODEL: 'qwen/qwen3.6-35b-a3b' },
      });

      expect(factory.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expectedShellArgs,
        expect.objectContaining({
          env: expect.objectContaining({ COPILOT_MODEL: 'qwen/qwen3.6-35b-a3b' }),
        }),
      );
    });

    it('spawns cmd.exe on Windows and an interactive login $SHELL on Unix', () => {
      expect(resolvePtyShell('win32', {})).toEqual({ file: 'cmd.exe', args: [] });
      // Unix: prefers the user's own shell so profile PATH (~/.local/bin, /opt/homebrew/bin) is sourced.
      expect(resolvePtyShell('darwin', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-il'] });
      expect(resolvePtyShell('linux', { SHELL: '/usr/bin/fish' })).toEqual({ file: '/usr/bin/fish', args: ['-il'] });
      // Falls back to bash when $SHELL is unset.
      expect(resolvePtyShell('darwin', {})).toEqual({ file: 'bash', args: ['-il'] });
    });

    it('returns the PtyProcess', () => {
      const result = manager.spawn({ sessionId: 's1', command: 'test' });
      expect(result).toBe(mock.pty);
    });

    // cwd validation is covered against the real filesystem in
    // tests/pty-spawn-cwd.test.ts.
  });

  describe('data events', () => {
    it('emits data event when PTY produces output', () => {
      const handler = vi.fn();
      manager.on('data', handler);
      manager.spawn({ sessionId: 's1', command: 'test' });

      mock.triggerData('hello world');

      expect(handler).toHaveBeenCalledWith('s1', 'hello world');
    });

    it('captures terminal tail output from PTY data', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });

      mock.triggerData('\x1b[32mhello\x1b[0m\nprogress 50%\rprogress 100%\n');

      expect(manager.getTerminalTail('s1', 5, 'both')).toMatchObject({
        raw: ['\x1b[32mhello\x1b[0m', 'progress 100%'],
        stripped: ['hello', 'progress 100%'],
        lastOutputAt: expect.any(Number),
      });
    });
  });

  describe('exit events', () => {
    it('emits exit event and removes PTY on exit', () => {
      const handler = vi.fn();
      manager.on('exit', handler);
      manager.spawn({ sessionId: 's1', command: 'test' });

      mock.triggerExit(0);

      expect(handler).toHaveBeenCalledWith('s1', 0);
      expect(manager.has('s1')).toBe(false);
    });
  });

  describe('write', () => {
    it('writes to the correct PTY', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      manager.write('s1', 'input data');

      // write is called once for the command, once for our explicit write
      expect(mock.pty.write).toHaveBeenCalledWith('input data');
    });

    it('does not throw for unknown session', () => {
      expect(() => manager.write('nonexistent', 'data')).not.toThrow();
    });
  });

  describe('resize', () => {
    it('resizes the PTY', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      manager.resize('s1', 80, 24);

      expect(mock.pty.resize).toHaveBeenCalledWith(80, 24);
    });

    it('does not throw for unknown session', () => {
      expect(() => manager.resize('nonexistent', 80, 24)).not.toThrow();
    });
  });

  describe('kill', () => {
    it('kills the PTY and removes it', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      manager.kill('s1');

      expect(mock.pty.kill).toHaveBeenCalled();
      expect(manager.has('s1')).toBe(false);
    });

    it('does not throw for unknown session', () => {
      expect(() => manager.kill('nonexistent')).not.toThrow();
    });
  });

  describe('killAll', () => {
    it('kills all PTYs', () => {
      const mock2 = createMockPty(99);
      const multiFactory: PtyFactory = {
        spawn: vi.fn()
          .mockReturnValueOnce(mock.pty)
          .mockReturnValueOnce(mock2.pty),
      };
      const mgr = new PtyManager(multiFactory);
      mgr.spawn({ sessionId: 's1', command: 'a' });
      mgr.spawn({ sessionId: 's2', command: 'b' });

      mgr.killAll();

      expect(mock.pty.kill).toHaveBeenCalled();
      expect(mock2.pty.kill).toHaveBeenCalled();
      expect(mgr.getSessionIds()).toEqual([]);
    });
  });

  describe('getPid / has / getSessionIds', () => {
    it('returns undefined pid for unknown session', () => {
      expect(manager.getPid('nonexistent')).toBeUndefined();
    });

    it('returns false for has on unknown session', () => {
      expect(manager.has('nonexistent')).toBe(false);
    });

    it('returns empty array when no sessions', () => {
      expect(manager.getSessionIds()).toEqual([]);
    });
  });

  describe('error resilience', () => {
    it('write() catches error and does not remove PTY', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      (mock.pty.write as any).mockImplementation(() => { throw new Error('broken pipe'); });

      expect(() => manager.write('s1', 'data')).not.toThrow();
      expect(manager.has('s1')).toBe(true); // PTY not removed
    });

    it('resize() catches error and does not remove PTY', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      (mock.pty.resize as any).mockImplementation(() => { throw new Error('invalid handle'); });

      expect(() => manager.resize('s1', 80, 24)).not.toThrow();
      expect(manager.has('s1')).toBe(true); // PTY not removed
    });

    it('kill() catches error and still removes PTY from map', () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      (mock.pty.kill as any).mockImplementation(() => { throw new Error('already dead'); });

      expect(() => manager.kill('s1')).not.toThrow();
      expect(manager.has('s1')).toBe(false); // PTY removed despite error
    });

    it('killAll() catches errors and clears all PTYs', () => {
      const mock2 = createMockPty(99);
      const multiFactory: PtyFactory = {
        spawn: vi.fn()
          .mockReturnValueOnce(mock.pty)
          .mockReturnValueOnce(mock2.pty),
      };
      const mgr = new PtyManager(multiFactory);
      mgr.spawn({ sessionId: 's1', command: 'a' });
      mgr.spawn({ sessionId: 's2', command: 'b' });

      (mock.pty.kill as any).mockImplementation(() => { throw new Error('fail1'); });
      (mock2.pty.kill as any).mockImplementation(() => { throw new Error('fail2'); });

      expect(() => mgr.killAll()).not.toThrow();
      expect(mgr.getSessionIds()).toEqual([]);
    });

    it('spawn() catches command write error but still registers PTY', () => {
      // First call to write (the initial command) throws
      (mock.pty.write as any).mockImplementation(() => { throw new Error('write failed'); });

      // spawn should not throw — PTY is still registered
      expect(() => manager.spawn({ sessionId: 's1', command: 'test' })).not.toThrow();
      expect(manager.has('s1')).toBe(true);
    });

    it('attaches socket error handlers when internal agent exists', () => {
      const inSocket = { on: vi.fn() };
      const outSocket = { on: vi.fn() };
      const agentMock = createMockPty(42);
      (agentMock.pty as any)._agent = { _inSocket: inSocket, _outSocket: outSocket };

      const agentFactory = createMockFactory(agentMock.pty);
      const mgr = new PtyManager(agentFactory);
      mgr.spawn({ sessionId: 's1', command: 'test' });

      expect(inSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(outSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('skips socket error handlers when no internal agent', () => {
      // Default mock has no _agent property — should not throw
      expect(() => manager.spawn({ sessionId: 's1', command: 'test' })).not.toThrow();
    });
  });

  describe('waitForQuiet', () => {
    it('resolves true once output has been silent for the quiet window', async () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      mock.triggerData('frame');

      await expect(manager.waitForQuiet('s1', { quietMs: 30, pollMs: 10, budgetMs: 5_000 })).resolves.toBe(true);
    });

    it('keeps waiting while output keeps arriving, then resolves true once it stops', async () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      const chatter = setInterval(() => mock.triggerData('frame'), 20);
      const waiting = manager.waitForQuiet('s1', { quietMs: 80, pollMs: 10, budgetMs: 5_000 });

      // Still busy 100ms in — the chatty window has not gone quiet yet.
      const settled = await Promise.race([waiting.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 100))]);
      expect(settled).toBe(false);

      clearInterval(chatter);
      await expect(waiting).resolves.toBe(true);
    });

    it('resolves false (fail-open signal) when the budget is exhausted under continuous output', async () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      const chatter = setInterval(() => mock.triggerData('frame'), 5);

      try {
        await expect(manager.waitForQuiet('s1', { quietMs: 200, pollMs: 10, budgetMs: 100 })).resolves.toBe(false);
      } finally {
        clearInterval(chatter);
      }
    });

    it('resolves false for an unknown session', async () => {
      await expect(manager.waitForQuiet('ghost', { quietMs: 1, pollMs: 5, budgetMs: 20 })).resolves.toBe(false);
    });

    it('resolves false after the session exits', async () => {
      manager.spawn({ sessionId: 's1', command: 'test' });
      mock.triggerExit(0);

      await expect(manager.waitForQuiet('s1', { quietMs: 1, pollMs: 5, budgetMs: 20 })).resolves.toBe(false);
    });
  });
});
