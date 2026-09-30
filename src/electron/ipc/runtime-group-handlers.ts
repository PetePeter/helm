/**
 * Runtime Group IPC Handlers
 *
 * CRUD + membership for ad-hoc runtime session groups. Mirrors the recycle-bin
 * handler shape: a single setup function registers ipcMain handlers and forwards
 * the manager's 'runtime-group:changed' event to all target windows.
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { RuntimeGroupManager } from '../../session/runtime-group-manager.js';
import { reattachRestoredSession } from '../../session/runtime-group-restore.js';
import type { WindowManager } from '../window-manager.js';
import { logger } from '../../utils/logger.js';

export function setupRuntimeGroupHandlers(
  manager: RuntimeGroupManager,
  windowManager?: WindowManager,
): void {
  const getTargetWindows = () => windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows();

  manager.on('runtime-group:changed', () => {
    for (const win of getTargetWindows()) {
      if (!win.isDestroyed()) win.webContents.send('runtime-group:changed');
    }
  });

  ipcMain.handle('runtimeGroup:list', () => {
    try {
      return manager.list();
    } catch (err) {
      logger.error(`[runtimeGroup:list] Failed: ${err}`);
      return [];
    }
  });

  ipcMain.handle('runtimeGroup:create', (_event, name: string) => {
    try {
      return manager.create(name);
    } catch (err) {
      logger.error(`[runtimeGroup:create] Failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('runtimeGroup:rename', (_event, id: string, name: string) => {
    try {
      return manager.rename(id, name);
    } catch (err) {
      logger.error(`[runtimeGroup:rename] Failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('runtimeGroup:setColor', (_event, id: string, color: string) => {
    try {
      return manager.setColor(id, color);
    } catch (err) {
      logger.error(`[runtimeGroup:setColor] Failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('runtimeGroup:setCollapsed', (_event, id: string, collapsed: boolean) => {
    try {
      manager.setCollapsed(id, collapsed);
      return true;
    } catch (err) {
      logger.error(`[runtimeGroup:setCollapsed] Failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle('runtimeGroup:addSession', (_event, groupId: string, sessionId: string) => {
    try {
      return manager.addSession(groupId, sessionId);
    } catch (err) {
      logger.error(`[runtimeGroup:addSession] Failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle('runtimeGroup:removeSession', (_event, sessionId: string) => {
    try {
      manager.removeSessionEverywhere(sessionId);
      return true;
    } catch (err) {
      logger.error(`[runtimeGroup:removeSession] Failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle('runtimeGroup:closeGroup', (_event, id: string) => {
    try {
      return manager.closeGroup(id);
    } catch (err) {
      logger.error(`[runtimeGroup:closeGroup] Failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(
    'runtimeGroup:reattach',
    (_event, entry: { runtimeGroupId?: string; runtimeGroupName?: string }, sessionId: string) => {
      try {
        reattachRestoredSession(manager, entry, sessionId);
        return true;
      } catch (err) {
        logger.error(`[runtimeGroup:reattach] Failed: ${err}`);
        return false;
      }
    },
  );

  logger.info('[IPC] Runtime group handlers registered');
}
