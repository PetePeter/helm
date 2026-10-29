import { ipcMain } from 'electron';
import type { DraftManager } from '../../session/draft-manager.js';
import { logger } from '../../utils/logger.js';

/**
 * The user's side of the draft (the dock pane). Writes are always authored
 * `user` and carry the revision the pane last saw, so a pane that missed an LLM
 * edit is refused instead of overwriting it.
 *
 * `isKnownSession` covers live sessions and recycle-bin entries: a pad written
 * for any other id could never be reached again.
 */
export function setupDraftHandlers(
  draftManager: DraftManager,
  isKnownSession: (sessionId: string) => boolean,
): void {
  ipcMain.handle('draft:get', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    return draftManager.get(sessionId);
  });

  ipcMain.handle('draft:set', (_event, sessionId: string, text: string, baseRevision: number) => {
    if (typeof sessionId !== 'string' || !isKnownSession(sessionId)) throw new Error('Session not found');
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (!Number.isInteger(baseRevision)) throw new Error('baseRevision must be an integer');
    return draftManager.set(sessionId, text, 'user', baseRevision);
  });

  ipcMain.handle('draft:history', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !isKnownSession(sessionId)) throw new Error('Session not found');
    return draftManager.history(sessionId);
  });

  ipcMain.handle('draft:recordSend', (_event, sessionId: string, text: string, via: string) => {
    if (typeof sessionId !== 'string' || !isKnownSession(sessionId)) throw new Error('Session not found');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    if (via !== 'cli' && via !== 'chat') throw new Error('Invalid send medium');
    return draftManager.recordSend(sessionId, text, via);
  });

  logger.info('[IPC] Draft handlers registered');
}
