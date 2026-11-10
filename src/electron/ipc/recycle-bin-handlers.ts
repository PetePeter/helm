/** Recycle-bin IPC surface for listing, restoring, and forgetting sessions. */

import { ipcMain, BrowserWindow } from 'electron';
import type { RecycleBinManager } from '../../session/recycle-bin-manager.js';
import type { WindowManager } from '../window-manager.js';
import type { RecycleBinEntry, RecycleBinRestoreResult } from '../../types/recycle-bin.js';
import { logger } from '../../utils/logger.js';

export function setupRecycleBinHandlers(
  recycleBin: RecycleBinManager,
  windowManager?: WindowManager,
  restoreEntry?: (id: string) => Promise<RecycleBinEntry | null>,
): () => void {
  const getTargetWindows = () => windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows();
  const onChanged = () => {
    for (const win of getTargetWindows()) {
      if (!win.isDestroyed()) win.webContents.send('recycle-bin:changed');
    }
  };
  recycleBin.on('recycle-bin:changed', onChanged);

  ipcMain.handle('recycleBin:list', () => {
    try {
      return recycleBin.list();
    } catch (err) {
      logger.error(`[recycleBin:list] Failed: ${err}`);
      return [];
    }
  });

  ipcMain.handle('recycleBin:restore', async (_event, id: string): Promise<RecycleBinRestoreResult> => {
    try {
      const entry = typeof id === 'string' ? await restoreEntry?.(id) ?? null : null;
      return { ok: true, entry };
    } catch (err) {
      logger.error(`[recycleBin:restore] Failed: ${err}`);
      return { ok: false, error: errorText(err) };
    }
  });

  ipcMain.handle('recycleBin:forget', (_event, id: string) => {
    try {
      if (typeof id !== 'string') throw new Error('A recycle-bin entry id is required.');
      recycleBin.forget(id);
      return { ok: true };
    } catch (err) {
      logger.error(`[recycleBin:forget] Failed: ${err}`);
      return { ok: false, error: errorText(err) };
    }
  });

  ipcMain.handle('recycleBin:empty', () => {
    try {
      recycleBin.empty();
      return { ok: true };
    } catch (err) {
      logger.error(`[recycleBin:empty] Failed: ${err}`);
      return { ok: false, error: errorText(err) };
    }
  });

  logger.info('[IPC] Recycle bin handlers registered');
  return () => {
    recycleBin.off('recycle-bin:changed', onChanged);
    for (const channel of ['recycleBin:list', 'recycleBin:restore', 'recycleBin:forget', 'recycleBin:empty']) {
      ipcMain.removeHandler(channel);
    }
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
