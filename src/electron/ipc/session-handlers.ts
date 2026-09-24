/**
 * Session IPC Handlers
 *
 * Manages CLI session lifecycle and active session switching.
 */

import { ipcMain } from 'electron';
import type { SessionManager } from '../../session/manager.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { DraftManager } from '../../session/draft-manager.js';
import type { WindowManager } from '../window-manager.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionInfo } from '../../types/session.js';
import { resolveWindowIconPath } from '../window-icon.js';
import { applyNavigationPolicy } from '../navigation-policy.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Setup
// ============================================================================

export function setupSessionHandlers(
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  draftManager: DraftManager,
  windowManager: WindowManager,
  configLoader?: ConfigLoader,
): () => void {
  const getFolderLabel = (workingDir?: string): string => {
    if (!workingDir) return 'No Folder';
    const parts = workingDir.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || workingDir;
  };

  const formatSnapOutWindowTitle = (session: SessionInfo): string => {
    return `${session.name} - ${session.cliType} - ${getFolderLabel(session.workingDir)}`;
  };

  const notifyMainWindow = (channel: 'session:snapOut' | 'session:snapBack', sessionId: string): void => {
    const mainWin = windowManager.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(channel, sessionId);
    }
  };

  const finalizeSnapBack = (sessionId: string, closedWindowId?: number, notifyMain = true): void => {
    if (closedWindowId !== undefined) {
      windowManager.unregisterWindow(closedWindowId);
    }
    windowManager.unassignSession(sessionId);
    try {
      sessionManager.updateSession(sessionId, { windowId: undefined });
    } catch {
      // Session may already be removed (for example after PTY exit).
    }
    if (notifyMain) {
      notifyMainWindow('session:snapBack', sessionId);
    }
  };

  // --- CRUD & navigation ---------------------------------------------------

  ipcMain.handle('session:getAll', () => {
    return sessionManager.getAllSessions();
  });

  ipcMain.handle('session:setActive', (_event, id: string) => {
    sessionManager.setActiveSession(id);
    windowManager.focusWindowForSession(id);
    return sessionManager.getActiveSession();
  });

  ipcMain.handle('session:getActive', () => {
    return sessionManager.getActiveSession();
  });

  // A snapped-out window pressed Ctrl+<n>: forward the display slot to the
  // main window, which is the single authority on slot→session ordering. It
  // resolves the slot and focuses the owning window (main or another popout).
  ipcMain.handle('session:requestFocusSlot', (_event, slot: number) => {
    const mainWin = windowManager.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('session:focusSlot', slot);
    }
    return { success: true };
  });

  // Raise the window that owns a session (main or a child popout) without
  // changing which terminal tab is locally active.
  ipcMain.handle('session:focusWindow', (_event, sessionId: string) => {
    return windowManager.focusWindowForSession(sessionId);
  });

  ipcMain.handle('session:remove', (_event, id: string) => {
    try {
      sessionManager.removeSession(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('session:rename', (_event, id: string, newName: string) => {
    try {
      const updatedSession = sessionManager.renameSession(id, newName);
      const windowId = windowManager.getWindowIdForSession(id);
      if (windowId !== undefined) {
        const childWindow = windowManager.getWindow(windowId);
        if (childWindow && !childWindow.isDestroyed()) {
          childWindow.setTitle(formatSnapOutWindowTitle(updatedSession));
          childWindow.webContents.send('session:updated', updatedSession);
        }
      }
      return { success: true, session: updatedSession };
    } catch (error) {
      logger.error(`[Session] Rename failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Set or clear the closure lock from the UI. The same durable flag the MCP
   * `session_set_locked` tool writes — this is the user-facing way in, which
   * until now did not exist.
   */
  ipcMain.handle('session:setLocked', (_event, id: string, locked: boolean) => {
    try {
      const session = sessionManager.setSessionLocked(id, locked);
      return { success: true, locked: Boolean(session.locked) };
    } catch (error) {
      logger.error(`[Session] Set locked failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  /**
   * The user's side of the mission TL;DR. Same SessionManager validator as the
   * MCP session_mission_set path; an over-limit text returns an error and the
   * existing mission is left as it was.
   */
  ipcMain.handle('session:setMission', (_event, id: string, text: string) => {
    try {
      const session = sessionManager.setMission(id, text, 'user');
      return { success: true, mission: session.mission ?? null };
    } catch (error) {
      logger.error(`[Session] Set mission failed: ${error}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('session:setMissionBarHeight', (_event, id: string, px: number) => {
    try {
      const session = sessionManager.setMissionBarHeight(id, px);
      return { success: true, height: session.missionBarHeight };
    } catch (error) {
      logger.error(`[Session] Set mission bar height failed: ${error}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('session:close', async (_event, id: string) => {
    try {
      const session = sessionManager.getSession(id);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      if (session.locked) {
        return { success: false, error: `Session "${session.name}" is locked and cannot be closed` };
      }

      try {
        ptyManager.kill(id);
      } catch (killError) {
        logger.warn(`[Session] Failed to kill PTY for session ${id}: ${killError}`);
      }

      const windowId = windowManager.getWindowIdForSession(id);
      if (windowId !== undefined) {
        const win = windowManager.getWindow(windowId);
        if (win && !win.isDestroyed()) {
          win.close();
        } else {
          finalizeSnapBack(id, windowId, false);
        }
      }

      sessionManager.removeSession(id);
      draftManager.clearSession(id);

      return { success: true };
    } catch (error) {
      logger.error(`[Session] Close failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // --- Snap-out / Snap-back ------------------------------------------------

  ipcMain.handle('session:snapOut', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (windowManager.isSessionSnappedOut(sessionId)) {
        return { success: false, error: 'Session already snapped out' };
      }

      // Create child window for snapped-out session
      const { BrowserWindow } = await import('electron');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const { getRendererHtmlPath } = await import('../../utils/app-paths.js');

      const __dirname = dirname(fileURLToPath(import.meta.url));
      const preloadPath = join(__dirname, 'preload.cjs');
      const rendererPath = getRendererHtmlPath(__dirname);
      const savedBounds = configLoader?.getSnapOutWindowPrefs(sessionId);
      const windowIcon = resolveWindowIconPath(__dirname);
      const childWindow = new BrowserWindow({
        width: savedBounds?.width ?? 800,
        height: savedBounds?.height ?? 600,
        x: savedBounds?.x,
        y: savedBounds?.y,
        minWidth: 400,
        minHeight: 300,
        title: formatSnapOutWindowTitle(session),
        icon: windowIcon,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      // Confine this privileged snap-out window to its own app content.
      applyNavigationPolicy(childWindow);

      // Load renderer with snap-out query params
      void Promise.resolve(childWindow.loadFile(rendererPath, {
        query: { snapOut: '1', sessionId },
      })).catch((error) => {
        logger.error(`[Session] Snap-out renderer failed to load for ${sessionId}: ${error}`);
        if (!childWindow.isDestroyed()) childWindow.close();
      });

      windowManager.registerWindow(childWindow.id, childWindow);
      windowManager.assignSessionToWindow(sessionId, childWindow.id);

      // Update session info
      sessionManager.updateSession(sessionId, { windowId: childWindow.id });

      // Notify main window
      notifyMainWindow('session:snapOut', sessionId);

      let boundsTimer: ReturnType<typeof setTimeout> | null = null;
      const persistBounds = () => {
        if (childWindow.isDestroyed() || childWindow.isMaximized() || !configLoader) return;
        if (boundsTimer) clearTimeout(boundsTimer);
        boundsTimer = setTimeout(() => {
          if (childWindow.isDestroyed() || childWindow.isMaximized()) return;
          const bounds = childWindow.getBounds();
          configLoader.setSnapOutWindowPrefs(sessionId, {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
          });
        }, 250);
      };
      childWindow.on('resize', persistBounds);
      childWindow.on('move', persistBounds);

      // A renderer crash does not necessarily destroy its BrowserWindow. Close
      // it explicitly so the normal closed handler releases ownership and the
      // main renderer can rehydrate the session.
      childWindow.webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[Session] Snap-out renderer gone for ${sessionId}: reason=${details.reason}, exitCode=${details.exitCode}`);
        if (!childWindow.isDestroyed()) childWindow.close();
      });

      // Handle child window close — auto snap-back
      childWindow.on('closed', () => {
        if (boundsTimer) {
          clearTimeout(boundsTimer);
          boundsTimer = null;
        }
        const notifyMain = sessionManager.hasSession(sessionId);
        finalizeSnapBack(sessionId, childWindow.id, notifyMain);
      });

      logger.info(`[Session] Snapped out session ${sessionId} to window ${childWindow.id}`);
      return { success: true, windowId: childWindow.id };
    } catch (error) {
      logger.error(`[Session] Snap-out failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('session:snapBack', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!windowManager.isSessionSnappedOut(sessionId)) {
        return { success: false, error: 'Session not snapped out' };
      }

      const windowId = windowManager.getWindowIdForSession(sessionId);
      if (windowId !== undefined) {
        const win = windowManager.getWindow(windowId);
        if (win && !win.isDestroyed()) {
          win.close();
        } else {
          finalizeSnapBack(sessionId, windowId, true);
        }
      }

      logger.info(`[Session] Snapped back session ${sessionId}`);
      return { success: true };
    } catch (error) {
      logger.error(`[Session] Snap-back failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  return () => {
    // no-op — health check removed, PTY exit events handle cleanup
  };
}
