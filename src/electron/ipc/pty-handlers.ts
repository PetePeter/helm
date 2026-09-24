import { ipcMain } from 'electron';
import type { PtyManager } from '../../session/pty-manager.js';
import type { StateDetector } from '../../session/state-detector.js';
import type { PatternMatcher } from '../../session/pattern-matcher.js';
import type { SessionManager } from '../../session/manager.js';
import type { PipelineQueue } from '../../session/pipeline-queue.js';
import type { RecycleBinManager } from '../../session/recycle-bin-manager.js';
import type { ConfigLoader } from '../../config/loader.js';
import { type SessionState, type SessionInfo, VALID_SESSION_STATES } from '../../types/session.js';
import type { NotificationManager } from '../../session/notification-manager.js';
import { spawnConfiguredSession } from '../../session/configured-session-spawn.js';
import { logger } from '../../utils/logger.js';
import type { WindowManager } from '../window-manager.js';
import type { PtyWriteOptions } from '../../session/delivery-context.js';
import { normalizeProjectPath } from '../../session/project-identity.js';

// Track cancel functions for initial prompt pre-loading per session
const promptCancellers: Map<string, () => void> = new Map();

/** Cancel all pending initial prompts (used during shutdown). */
export function cancelAllPrompts(): void {
  for (const cancel of promptCancellers.values()) cancel();
  promptCancellers.clear();
}

export function setupPtyHandlers(
  ptyManager: PtyManager,
  stateDetector: StateDetector,
  sessionManager: SessionManager,
  pipelineQueue: PipelineQueue,
  windowManager: WindowManager,
  configLoader?: ConfigLoader,
  notificationManager?: NotificationManager,
  onPtyData?: (sessionId: string, data: string) => void,
  onActivityChange?: (sessionId: string, level: import('../../types/session.js').ActivityLevel) => void,
  onPtyInput?: (sessionId: string, data: string) => void,
  patternMatcher?: PatternMatcher,
  /** A restored bin entry keeps its session id; its record carries the CLI thread id. */
  recycleBin?: Pick<RecycleBinManager, 'list'>,
): void {
  const isRendererOwner = (event: Electron.IpcMainInvokeEvent, sessionId: string): boolean => {
    // Electron always supplies sender for a real invoke. The missing-sender
    // fallback keeps direct unit calls useful without weakening the runtime
    // boundary.
    const senderId = event?.sender?.id;
    if (typeof senderId !== 'number') return true;
    if (windowManager.isSessionOwnedByWebContents(sessionId, senderId)) return true;
    logger.warn(`[PTY IPC] Rejected renderer access for session=${sessionId} sender=${senderId}`);
    return false;
  };

  // terminal:attach is the child-window ownership handshake. The main
  // process owns the replay buffer, so output produced before the child
  // listener is ready is still available to the new renderer.
  ipcMain.handle('terminal:attach', (event, sessionId: string) => {
    if (!isRendererOwner(event, sessionId)) {
      return { success: false, error: 'Renderer does not own session' };
    }
    if (typeof event?.sender?.id === 'number') windowManager.markSessionRendererAttached(sessionId);
    const tail = ptyManager.getTerminalTail(sessionId, 500, 'raw');
    return { success: true, replay: tail.raw?.join('\r\n') ?? '' };
  });

  // terminal:detach is intentionally explicit even though the authoritative
  // mapping changes in session:snapBack/session window close. It prevents a
  // stale renderer from claiming it still owns the PTY during that transition.
  ipcMain.handle('terminal:detach', (event, sessionId: string) => {
    if (!isRendererOwner(event, sessionId)) {
      return { success: false, error: 'Renderer does not own session' };
    }
    const senderId = event?.sender?.id;
    if (typeof senderId === 'number' && !windowManager.markSessionRendererDetached(sessionId, senderId)) {
      return { success: false, error: 'Renderer does not own session' };
    }
    return { success: true };
  });

  // pty:spawn - Spawn a new PTY process and register as session
  ipcMain.handle('pty:spawn', (_event, sessionId: string, command: string, args: string[], cwd?: string, cliType?: string, contextText?: string, resumeSessionName?: string) => {
    logger.info(`[PTY IPC] pty:spawn called: sessionId=${sessionId}, command=${command}, args=${JSON.stringify(args)}, cwd=${cwd}, cliType=${cliType}, hasContext=${!!contextText}, resume=${resumeSessionName || 'none'}`);
    // Reload profile from disk if the file changed — ensures profile edits take
    // effect for new sessions without restarting the app.
    configLoader?.reloadActiveProfileIfChanged();
    try {
      const normalizedCwd = cwd ? normalizeProjectPath(cwd) : undefined;
      const { pty } = spawnConfiguredSession({
        ptyManager,
        sessionManager,
        configLoader,
        sessionId,
        command,
        args,
        cwd: normalizedCwd,
        cliType,
        // No sessionName: spawnConfiguredSession names it after the resolved CLI
        // type's displayName. Passing cliType here would surface a raw UUID.
        contextText,
        resumeSessionName,
        // Only a bin restore needs this: a restart-restored session still holds its own.
        resumeThreadId: resumeSessionName
          ? recycleBin?.list().find(e => e.sessionId === sessionId)?.cliThreadId
          : undefined,
        markRestored: sid => stateDetector.markRestored(sid),
        onPromptCancel: cancel => promptCancellers.set(sessionId, cancel),
      });

      logger.info(`[PTY IPC] Spawn success: pid=${pty.pid}`);
      return { success: true, pid: pty.pid };
    } catch (error) {
      logger.error(`[PTY IPC] Failed to spawn: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // Activity marking belongs to the write itself, not to this IPC hop: bytes
  // delivered from the main process (MCP, Telegram, pattern-matcher) must move
  // the dots too. See PtyManager.write.
  ptyManager.setActivityMarker(sessionId => stateDetector.markActive(sessionId));

  // pty:write - Write data to a session's PTY stdin
  ipcMain.handle('pty:write', (event, sessionId: string, data: string, options?: PtyWriteOptions) => {
    if (!isRendererOwner(event, sessionId)) return;
    try {
      const inputOrigin = options?.inputOrigin === 'programmatic' ? 'programmatic' : 'user';
      ptyManager.write(sessionId, data);
      if (inputOrigin === 'user') {
        // Switch to desktop channel when the user types in terminal.
        const session = sessionManager.getSession(sessionId);
        if (session?.interactionChannel === 'telegram') {
          sessionManager.updateSession(sessionId, { interactionChannel: 'desktop' });
        }
        onPtyInput?.(sessionId, data);
      }
    } catch (error) {
      logger.error(`[PTY IPC] pty:write failed for session=${sessionId}: ${error}`);
    }
  });

  // pty:scrollInput - Write scroll keys to PTY without triggering marker detection.
  // Screen redraws from scroll can contain stale agent-visible text.
  ipcMain.handle('pty:scrollInput', (event, sessionId: string, data: string) => {
    if (!isRendererOwner(event, sessionId)) return;
    try {
      ptyManager.write(sessionId, data, 'scroll');
      stateDetector.markScrolling(sessionId);
    } catch (error) {
      logger.error(`[PTY IPC] pty:scrollInput failed for session=${sessionId}: ${error}`);
    }
  });

  // pty:resize - Resize a session's PTY
  ipcMain.handle('pty:resize', (event, sessionId: string, cols: number, rows: number) => {
    if (!isRendererOwner(event, sessionId)) return;
    try {
      ptyManager.resize(sessionId, cols, rows);
      stateDetector.markResizing(sessionId);
    } catch (error) {
      logger.error(`[PTY IPC] pty:resize failed for session=${sessionId}: ${error}`);
    }
  });

  // pty:markSwitching - Suppress activity promotion before terminal switch
  ipcMain.handle('pty:markSwitching', (_event, sessionId: string) => {
    stateDetector.markSwitching(sessionId);
  });

  // pty:kill - Kill a session's PTY
  ipcMain.handle('pty:kill', (_event, sessionId: string) => {
    // Cancel any pending initial prompt
    const cancelPrompt = promptCancellers.get(sessionId);
    if (cancelPrompt) {
      cancelPrompt();
      promptCancellers.delete(sessionId);
    }
    try {
      ptyManager.kill(sessionId);
    } catch (error) {
      logger.error(`[PTY IPC] pty:kill failed for session=${sessionId}: ${error}`);
    }
  });

  // Forward PTY data events to renderer
  ptyManager.on('data', (sessionId: string, data: string) => {
    // Feed to state detector for activity and question tracking.
    stateDetector.processOutput(sessionId, data);

    // Feed to pattern matcher for regex-triggered actions
    if (patternMatcher) {
      const cliType = sessionManager.getSession(sessionId)?.cliType;
      if (cliType) patternMatcher.processOutput(sessionId, cliType, data);
    }

    // Forward to renderer for xterm.js rendering
    const win = windowManager.getWindowForSession(sessionId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:data', sessionId, data);
    }

    // Feed optional Telegram modules after renderer delivery. Telegram output
    // bookkeeping must never sit in front of terminal rendering.
    try {
      onPtyData?.(sessionId, data);
    } catch (error) {
      logger.error(`[PTY IPC] Telegram PTY hook failed for session=${sessionId}: ${error}`);
    }
  });

  // Forward PTY exit events to renderer
  ptyManager.on('exit', (sessionId: string, exitCode: number) => {
    const snappedWindowId = windowManager.getWindowIdForSession(sessionId);

    // Cancel any pending initial prompt
    const cancelPrompt = promptCancellers.get(sessionId);
    if (cancelPrompt) {
      cancelPrompt();
      promptCancellers.delete(sessionId);
    }

    const win = windowManager.getWindowForSession(sessionId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', sessionId, exitCode);
    }
    // Clean up: remove from queue, state tracking, notification tracking, and session manager
    pipelineQueue.dequeue(sessionId);
    stateDetector.removeSession(sessionId);
    patternMatcher?.removeSession(sessionId);
    notificationManager?.removeSession(sessionId);
    if (sessionManager.hasSession(sessionId)) {
      sessionManager.removeSession(sessionId, { force: true });
    }

    if (snappedWindowId !== undefined) {
      const snappedWin = windowManager.getWindow(snappedWindowId);
      if (snappedWin && !snappedWin.isDestroyed()) {
        snappedWin.close();
      } else {
        windowManager.unassignSession(sessionId);
      }
    }
  });

  stateDetector.on('question-detected', (event) => {
    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:question-detected', event);
    }
    const session = sessionManager.getSession(event.sessionId);
    if (session) {
      sessionManager.updateSession(event.sessionId, { questionPending: true });
    }
  });

  stateDetector.on('question-cleared', (event) => {
    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:question-cleared', event);
    }
    const session = sessionManager.getSession(event.sessionId);
    if (session) {
      sessionManager.updateSession(event.sessionId, { questionPending: false });
    }
  });

  // Forward activity change events to renderer
  stateDetector.on('activity-change', (event) => {
    if (sessionManager.hasSession(event.sessionId)) {
      const updates: Partial<SessionInfo> = { activityLevel: event.level };
      if (event.lastOutputAt !== undefined && event.lastOutputAt > 0) {
        updates.lastOutputAt = event.lastOutputAt;
        // When leaving the active (green) state, freeze lastActiveAt at the last output moment.
        // While active, lastActiveAt is reported live as "now" by the MCP layer.
        if (event.level !== 'active') {
          updates.lastActiveAt = event.lastOutputAt;
        }
      }
      sessionManager.updateSession(event.sessionId, updates);
    }

    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:activity-change', event);
    }

    // Telegram: flush buffered output when session goes inactive/idle
    onActivityChange?.(event.sessionId, event.level);
  });

  // Pipeline queue management
  ipcMain.handle('pipeline:enqueue', (_event, sessionId: string) => {
    pipelineQueue.enqueue(sessionId);
    const session = sessionManager.getSession(sessionId);
    if (session) sessionManager.updateSession(sessionId, { state: 'waiting' });
    return { success: true, position: pipelineQueue.getPosition(sessionId) };
  });

  ipcMain.handle('pipeline:dequeue', (_event, sessionId: string) => {
    pipelineQueue.dequeue(sessionId);
    return { success: true };
  });

  ipcMain.handle('pipeline:getQueue', () => {
    return pipelineQueue.getAll();
  });

  ipcMain.handle('pipeline:getPosition', (_event, sessionId: string) => {
    return pipelineQueue.getPosition(sessionId);
  });

  // Manual state override
  ipcMain.handle('session:setState', (_event, sessionId: string, state: string) => {
    if (!VALID_SESSION_STATES.includes(state as SessionState)) {
      return { success: false, error: `Invalid state: ${state}` };
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) return { success: false, error: 'Session not found' };

    if (state === 'waiting') {
      pipelineQueue.enqueue(sessionId);
    } else {
      pipelineQueue.dequeue(sessionId);
    }

    sessionManager.updateSession(sessionId, { state: state as SessionState });

    return { success: true };
  });

  // Pattern matcher — cancel schedule
  ipcMain.handle('pattern:cancelSchedule', (_event, sessionId: string) => {
    patternMatcher?.cancelSchedule(sessionId);
    return { success: true };
  });

  // Pattern matcher — forward events to renderer
  if (patternMatcher) {
    patternMatcher.on('schedule-created', (event) => {
      const win = windowManager.getWindowForSession(event.sessionId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pattern:schedule-created', event);
      }
    });
    patternMatcher.on('schedule-fired', (event) => {
      const win = windowManager.getWindowForSession(event.sessionId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pattern:schedule-fired', event);
      }
    });
    patternMatcher.on('schedule-cancelled', (event) => {
      const win = windowManager.getWindowForSession(event.sessionId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pattern:schedule-cancelled', event);
      }
    });
  }

  logger.info('[PTY IPC] Handlers registered');
}
