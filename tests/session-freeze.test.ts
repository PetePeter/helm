/** Freeze: a frozen session takes no input from anyone until unfrozen. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { SessionManager } from '../src/session/manager.js';
import { saveSessions, loadSessions } from '../src/session/session-persistence.js';
import { deliverPromptSequenceToSession } from '../src/session/sequence-delivery.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakePty(): PtyProcess & { written: string[] } {
  const written: string[] = [];
  return { pid: 1, written, write: (d: string) => { written.push(d); }, resize: () => {}, kill: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) } as never;
}

function setup() {
  const sessions = new SessionManager();
  sessions.addSession({ id: 's1', name: 'worker', cliType: 'test', processId: 1, workingDir: 'C:/w' });
  const pty = fakePty();
  const ptyManager = new PtyManager({ spawn: () => pty } as PtyFactory);
  ptyManager.adopt('s1', pty, { cols: 80, rows: 24 });
  ptyManager.setWriteGate(id => !sessions.getSession(id)?.frozen);
  return { sessions, ptyManager, pty };
}

describe('session freeze', () => {
  it('drops every stdin write while frozen, but lets mouse scroll through', () => {
    const { sessions, ptyManager, pty } = setup();
    sessions.setSessionFrozen('s1', true);
    ptyManager.write('s1', 'typed');
    ptyManager.write('s1', '\x1b[<64;1;1M', 'scroll');
    expect(pty.written).toEqual(['\x1b[<64;1;1M']);

    sessions.setSessionFrozen('s1', false);
    ptyManager.write('s1', 'typed');
    expect(pty.written).toContain('typed');
  });

  it('rejects programmatic delivery with a "frozen" error', async () => {
    const { sessions, ptyManager, pty } = setup();
    sessions.setSessionFrozen('s1', true);
    await expect(deliverPromptSequenceToSession({
      sessionId: 's1', text: 'wake up', ptyManager, sessionManager: sessions,
      configLoader: { getCliTypeEntry: () => undefined } as never,
    })).rejects.toThrow(/frozen/);
    expect(pty.written).toEqual([]);
  });

  it('survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-freeze-'));
    directories.push(dir);
    const file = join(dir, 'sessions.yaml');
    const { sessions } = setup();
    sessions.setSessionFrozen('s1', true);
    saveSessions(sessions.getAllSessions(), file);
    expect(loadSessions(file)[0].frozen).toBe(true);
  });

  it('the operator can never be frozen — it is how frozen sessions get thawed', () => {
    const { sessions } = setup();
    sessions.addSession({ id: 'op', name: 'Helm', cliType: 'test', processId: 2, role: 'operator' });
    expect(() => sessions.setSessionFrozen('op', true)).toThrow(/operator/i);
    expect(sessions.getSession('op')?.frozen).toBeFalsy();
    // …and it can still thaw others.
    sessions.setSessionFrozen('s1', true);
    sessions.setSessionFrozen('s1', false);
    expect(sessions.getSession('s1')?.frozen).toBe(false);
  });
});
