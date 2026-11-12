import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { restartSessionWithResume } from '../src/session/session-restart.js';

/** PTY fake whose kill fires 'exit' later, like node-pty, and whose exit closes the session into the bin. */
function makeDeps(opts: { exits?: boolean } = {}) {
  const pty = new EventEmitter() as EventEmitter & { has: (id: string) => boolean; kill: (id: string) => void };
  const live = new Set(['s1']);
  const bin: { id: string; sessionId: string }[] = [];
  pty.has = id => live.has(id);
  pty.kill = id => {
    live.delete(id);
    if (opts.exits !== false) setTimeout(() => {
      bin.push({ id: 'entry-1', sessionId: id });
      pty.emit('exit', id, 1);
    }, 5);
  };
  const restore = vi.fn(async (entryId: string) => { live.add('s1'); return { sessionId: entryId }; });
  return {
    deps: { ptyManager: pty, recycleBin: { list: () => bin }, restore, exitTimeoutMs: 50 },
    restore,
    pty,
  };
}

describe('restartSessionWithResume', () => {
  it('restores the session from the bin only after the old PTY has exited', async () => {
    const { deps, restore } = makeDeps();

    await restartSessionWithResume(deps, 's1');

    expect(restore).toHaveBeenCalledWith('entry-1');
  });

  // Restoring before the old exit lands would let that late exit remove the new session.
  it('does not restore when the old PTY never reports exit', async () => {
    const { deps, restore } = makeDeps({ exits: false });

    await expect(restartSessionWithResume(deps, 's1')).rejects.toThrow('did not exit');
    expect(restore).not.toHaveBeenCalled();
  });

  it('rejects a session with no live PTY', async () => {
    const { deps, restore } = makeDeps();

    await expect(restartSessionWithResume(deps, 'ghost')).rejects.toThrow('not running');
    expect(restore).not.toHaveBeenCalled();
  });
});
