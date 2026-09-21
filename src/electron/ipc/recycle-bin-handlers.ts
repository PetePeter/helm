/**
 * Recycle Bin IPC Handlers
 *
 * Lists / restores / forgets closed recoverable sessions. Restore returns the
 * entry (and removes it from the bin) so the renderer can re-spawn it via the
 * normal spawn-with-resume flow (doSpawn → pty:spawn with resumeSessionName).
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { RecycleBinManager } from '../../session/recycle-bin-manager.js';
import type { ArtifactManager } from '../../session/artifact-manager.js';
import type { RecycleBinEntry } from '../../types/recycle-bin.js';
import type { WindowManager } from '../window-manager.js';
import { ArtifactTempRegistry } from '../../session/artifact-temp-registry.js';
import type { MemoryManager } from '../../session/memory-manager.js';
import type { MessManager, MessSessionCloseKind } from '../../session/mess-manager.js';
import type { MobileChatJournal } from '../../mobile/mobile-chat-journal.js';
import { logger } from '../../utils/logger.js';

export function setupRecycleBinHandlers(
  recycleBin: RecycleBinManager,
  artifactManager: ArtifactManager,
  windowManager?: WindowManager,
  tempRegistry: ArtifactTempRegistry = new ArtifactTempRegistry(),
  memoryManager?: Pick<MemoryManager, 'purgeSession'>,
  messManager?: Pick<MessManager, 'onSessionClosed'>,
  chatJournal?: Pick<MobileChatJournal, 'pruneSession'>,
): void {
  const getTargetWindows = () => windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows();
  /**
   * A session leaving the bin is never coming back, so its per-session stores go
   * with it. Memory gates the transaction — a failed purge leaves the entry
   * recoverable for retry — while the Mess cursor and the chat journal are
   * maintenance that must never block the bin operation.
   */
  const purgeSessionData = (sessionId: string, kind: MessSessionCloseKind): boolean => {
    try {
      memoryManager?.purgeSession(sessionId);
    } catch (error) {
      logger.error(`[recycleBin] Failed to purge memories for ${sessionId}: ${error}`);
      return false;
    }
    try {
      messManager?.onSessionClosed(sessionId, kind);
    } catch (error) {
      logger.error(`[recycleBin] Failed to drop the Mess cursor for ${sessionId}: ${error}`);
    }
    try {
      // The phone's replay of this conversation dies with the session — the
      // journal's retention IS the session's lifetime (see MobileChatJournal).
      chatJournal?.pruneSession(sessionId);
    } catch (error) {
      logger.error(`[recycleBin] Failed to prune the chat journal for ${sessionId}: ${error}`);
    }
    return true;
  };

  recycleBin.on('recycle-bin:changed', () => {
    for (const win of getTargetWindows()) {
      if (!win.isDestroyed()) win.webContents.send('recycle-bin:changed');
    }
  });

  // An entry that ages out of the retention window at runtime takes its preserved
  // artifacts with it — same effect as a Forget.
  // Temp copies opened externally go too — a session that ages out is never
  // coming back, so nothing can still legitimately reference them.
  recycleBin.on('recycle-bin:expired', (expired: RecycleBinEntry[]) => {
    for (const entry of expired) {
      if (!purgeSessionData(entry.sessionId, 'expired')) continue;
      artifactManager.clearSession(entry.sessionId);
      tempRegistry.drain(entry.sessionId);
    }
  });

  ipcMain.handle('recycleBin:list', () => {
    try {
      return recycleBin.list();
    } catch (err) {
      logger.error(`[recycleBin:list] Failed: ${err}`);
      return [];
    }
  });

  // Restore is a two-phase transaction so a failed re-spawn cannot lose the entry
  // (and its preserved artifacts): restore PEEKS the entry, the renderer re-spawns,
  // and only a successful spawn calls commitRestore to remove it. Artifacts are kept
  // either way — the reused session id owns them once it comes back.
  ipcMain.handle('recycleBin:restore', (_event, id: string) => {
    try {
      return recycleBin.peek(id);
    } catch (err) {
      logger.error(`[recycleBin:restore] Failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('recycleBin:commitRestore', (_event, id: string) => {
    try {
      recycleBin.forget(id); // remove the entry only; artifacts stay with the reused id
      return true;
    } catch (err) {
      logger.error(`[recycleBin:commitRestore] Failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle('recycleBin:forget', (_event, id: string) => {
    try {
      // Permanently deleting an entry also clears its preserved artifacts. Resolve
      // the session id BEFORE forgetting (restore uses a different path, so this
      // only fires on a genuine Forget, never on restore).
      const sessionId = recycleBin.list().find(e => e.id === id)?.sessionId;
      if (sessionId) {
        // Purge memory before removing the entry, so a failed purge leaves the
        // recoverable entry available for retry. Restore never uses this path.
        if (!purgeSessionData(sessionId, 'forgotten')) return false;
      }
      recycleBin.forget(id);
      if (sessionId) {
        artifactManager.clearSession(sessionId);
        tempRegistry.drain(sessionId);
      }
      return true;
    } catch (err) {
      logger.error(`[recycleBin:forget] Failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle('recycleBin:empty', () => {
    try {
      // Snapshot every binned session id before emptying, then clear their artifacts.
      const sessionIds = recycleBin.list().map(e => e.sessionId);
      for (const sessionId of sessionIds) {
        if (!purgeSessionData(sessionId, 'forgotten')) return false;
      }
      recycleBin.empty();
      for (const sessionId of sessionIds) {
        artifactManager.clearSession(sessionId);
        tempRegistry.drain(sessionId);
      }
      return true;
    } catch (err) {
      logger.error(`[recycleBin:empty] Failed: ${err}`);
      return false;
    }
  });

  logger.info('[IPC] Recycle bin handlers registered');
}
