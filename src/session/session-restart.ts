import type { EventEmitter } from 'node:events';

export interface SessionRestartDeps {
  ptyManager: Pick<EventEmitter, 'on' | 'off'> & { has(sessionId: string): boolean; kill(sessionId: string): void };
  recycleBin: { list(): { id: string; sessionId: string }[] };
  restore: (entryId: string) => Promise<unknown>;
  exitTimeoutMs?: number;
}

/**
 * Restart a wedged CLI in place by reusing the close → recycle-bin → restore path:
 * the PTY exit closes the session into the bin, and the bin restore resumes it
 * under the same session id via its cliThreadId.
 *
 * The restore waits for the old exit: a late exit event would otherwise remove
 * the freshly restored session that shares its id.
 */
export async function restartSessionWithResume(deps: SessionRestartDeps, sessionId: string): Promise<void> {
  if (!deps.ptyManager.has(sessionId)) throw new Error(`Session ${sessionId} is not running`);

  await new Promise<void>((resolve, reject) => {
    const onExit = (exitedId: string) => {
      if (exitedId !== sessionId) return;
      clearTimeout(timer);
      deps.ptyManager.off('exit', onExit);
      resolve();
    };
    const timer = setTimeout(() => {
      deps.ptyManager.off('exit', onExit);
      reject(new Error(`Session ${sessionId} did not exit; not restoring`));
    }, deps.exitTimeoutMs ?? 10_000);
    deps.ptyManager.on('exit', onExit);
    deps.ptyManager.kill(sessionId);
  });

  const entry = deps.recycleBin.list().find(candidate => candidate.sessionId === sessionId);
  if (!entry) throw new Error(`Session ${sessionId} was not recoverable from the recycle bin`);
  await deps.restore(entry.id);
}
