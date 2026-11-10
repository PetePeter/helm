/**
 * Registry of temp copies written by `artifact:openExternal`, keyed by session.
 *
 * The copy handed to the OS default app outlives the IPC call — the external
 * app still holds it — so something has to remember it. Sessions are the unit
 * users close, so the session id is the key: closing a session drains its
 * entries even when the session itself is still recoverable in the recycle bin.
 *
 * Deliberately in-memory only. The startup sweep (`cleanupWorkTempFiles`) is the
 * backstop for anything a crash strands, so persisting this would buy nothing.
 */

import { forceDeleteTempFile } from '../utils/temp-file-delete.js';
import { logger } from '../utils/logger.js';

/** Minimal shape of the emitter we listen to — keeps this free of SessionManager. */
interface SessionRemovedEmitter {
  on(event: 'session:removed', listener: (event: { sessionId: string }) => void): unknown;
}

export class ArtifactTempRegistry {
  private readonly bySession = new Map<string, Set<string>>();

  /** Remember a temp file written on behalf of a session. */
  record(sessionId: string, filePath: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      existing.add(filePath);
      return;
    }
    this.bySession.set(sessionId, new Set([filePath]));
  }

  /** Temp files currently attributed to a session, in insertion order. */
  pathsFor(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /**
   * Delete every temp file recorded for a session and forget them.
   *
   * @returns the paths that are gone from disk afterwards.
   */
  drain(sessionId: string): string[] {
    const paths = this.pathsFor(sessionId);
    if (paths.length === 0) return [];

    const deleted = paths.filter(forceDeleteTempFile);
    const failed = paths.filter(filePath => !deleted.includes(filePath));
    if (failed.length > 0) this.bySession.set(sessionId, new Set(failed));
    else this.bySession.delete(sessionId);
    logger.debug(`[ArtifactTemps] Drained ${deleted.length}/${paths.length} temp files for ${sessionId}`);
    return deleted;
  }
}

/**
 * Wire session closure to temp cleanup.
 *
 * Unconditional by design: a closed session's external copies are stale whether
 * or not the session itself is recoverable, and a restore re-opens artifacts
 * from the store rather than from these files.
 */
export function attachSessionTempCleanup(
  sessionManager: SessionRemovedEmitter,
  registry: ArtifactTempRegistry,
): void {
  sessionManager.on('session:removed', (event) => {
    registry.drain(event.sessionId);
  });
}
