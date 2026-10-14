import { ipcMain } from 'electron';
import type { ScratchpadManager } from '../../session/scratchpad-manager.js';
import { logger } from '../../utils/logger.js';

/**
 * The user's side of the scratchpad (the dock pane). Writes are always authored
 * `user` and carry the revision the pane last saw, so a pane that missed an LLM
 * edit is refused instead of overwriting it.
 *
 * `isKnownSession` covers live sessions and recycle-bin entries: a pad written
 * for any other id could never be reached again.
 */
export function setupScratchpadHandlers(
  scratchpadManager: ScratchpadManager,
  isKnownSession: (sessionId: string) => boolean,
): void {
  ipcMain.handle('scratchpad:get', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    return scratchpadManager.get(sessionId);
  });

  ipcMain.handle('scratchpad:set', (_event, sessionId: string, text: string, baseRevision: number) => {
    if (typeof sessionId !== 'string' || !isKnownSession(sessionId)) throw new Error('Session not found');
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (!Number.isInteger(baseRevision)) throw new Error('baseRevision must be an integer');
    return scratchpadManager.set(sessionId, text, 'user', baseRevision);
  });

  logger.info('[IPC] Scratchpad handlers registered');
}
