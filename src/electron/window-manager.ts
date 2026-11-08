import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger.js';

/**
 * WindowManager — tracks multiple BrowserWindow instances for snap-out support.
 *
 * Each snapped-out session gets its own child window. The main window owns
 * all sessions that are not snapped out.
 */
export class WindowManager {
  private windows = new Map<number, BrowserWindow>();
  private sessionToWindow = new Map<string, number>();
  private detachedSessions = new Set<string>();
  private mainWindowId: number | null = null;

  /** Register the main application window. */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindowId = window.id;
    this.windows.set(window.id, window);
    logger.info(`[WindowManager] Main window registered: ${window.id}`);
  }

  /** Register a child (snapped-out) window. */
  registerWindow(id: number, window: BrowserWindow): void {
    this.windows.set(id, window);
    logger.info(`[WindowManager] Child window registered: ${id}`);
  }

  /** Unregister a window (called when it closes). */
  unregisterWindow(id: number): void {
    this.windows.delete(id);
    // Clear any session mappings to this window
    for (const [sessionId, windowId] of this.sessionToWindow.entries()) {
      if (windowId === id) {
        this.sessionToWindow.delete(sessionId);
        this.detachedSessions.delete(sessionId);
        logger.info(`[WindowManager] Session ${sessionId} orphaned by window ${id} close`);
      }
    }
    logger.info(`[WindowManager] Window unregistered: ${id}`);
  }

  /** Get a window by ID. */
  getWindow(id: number): BrowserWindow | undefined {
    return this.windows.get(id);
  }

  /** Get the main window. */
  getMainWindow(): BrowserWindow | undefined {
    if (this.mainWindowId === null) return undefined;
    return this.windows.get(this.mainWindowId);
  }

  /** Get all live registered windows. */
  getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter(win => !win.isDestroyed());
  }

  /** Get the window that owns a given session. Returns main window if not snapped out. */
  getWindowForSession(sessionId: string): BrowserWindow | undefined {
    // During snap-back the child has released terminal ownership, but its
    // window mapping remains until BrowserWindow emits `closed`. Route output
    // to the main window so its transition buffer captures the short gap.
    if (this.detachedSessions.has(sessionId)) return this.getMainWindow();

    const windowId = this.sessionToWindow.get(sessionId);
    if (windowId !== undefined) {
      const win = this.windows.get(windowId);
      if (win && !win.isDestroyed()) {
        return win;
      }
      // Stale mapping — clean up
      this.sessionToWindow.delete(sessionId);
    }
    return this.getMainWindow();
  }

  /** Get the window ID for a session, or undefined if in main window. */
  getWindowIdForSession(sessionId: string): number | undefined {
    return this.sessionToWindow.get(sessionId);
  }

  /**
   * Check whether a renderer is the current terminal owner for a session.
   * Ownership is derived from the authoritative window mapping; renderer code
   * never supplies or changes the owning window id.
   */
  isSessionOwnedByWebContents(sessionId: string, webContentsId: number): boolean {
    if (this.detachedSessions.has(sessionId)) return false;
    const owner = this.getWindowForSession(sessionId);
    return owner?.webContents.id === webContentsId;
  }

  /** Mark a renderer as attached after its terminal surface is ready. */
  markSessionRendererAttached(sessionId: string): void {
    this.detachedSessions.delete(sessionId);
  }

  /** Release renderer ownership while the session transitions to another host. */
  markSessionRendererDetached(sessionId: string, webContentsId: number): boolean {
    if (!this.isSessionOwnedByWebContents(sessionId, webContentsId)) return false;
    this.detachedSessions.add(sessionId);
    return true;
  }

  /** Assign a session to a window (for snap-out). */
  assignSessionToWindow(sessionId: string, windowId: number): void {
    this.sessionToWindow.set(sessionId, windowId);
    logger.info(`[WindowManager] Session ${sessionId} assigned to window ${windowId}`);
  }

  /** Remove a session from its window (for snap-back). */
  unassignSession(sessionId: string): void {
    this.sessionToWindow.delete(sessionId);
    this.detachedSessions.delete(sessionId);
    logger.info(`[WindowManager] Session ${sessionId} unassigned from window`);
  }

  /** Check if a session is snapped out to a child window. */
  isSessionSnappedOut(sessionId: string): boolean {
    return this.sessionToWindow.has(sessionId);
  }

  /** Get all session IDs assigned to a specific window. */
  getSessionsInWindow(windowId: number): string[] {
    const sessions: string[] = [];
    for (const [sessionId, id] of this.sessionToWindow.entries()) {
      if (id === windowId) {
        sessions.push(sessionId);
      }
    }
    return sessions;
  }

  /** Close snap-outs from other profiles and return their sessions to the main desktop. */
  closeChildWindowsNotOwnedByProfile(
    profileId: string,
    getSessionProfileId: (sessionId: string) => string | undefined,
  ): void {
    for (const id of this.getChildWindowIds()) {
      const sessions = this.getSessionsInWindow(id);
      if (sessions.length > 0 && sessions.every(sessionId => getSessionProfileId(sessionId) === profileId)) continue;

      for (const sessionId of sessions) this.unassignSession(sessionId);
      const window = this.windows.get(id);
      if (window && !window.isDestroyed()) window.destroy();
    }
  }

  /** Get all snapped-out session IDs. */
  getSnappedOutSessions(): string[] {
    return Array.from(this.sessionToWindow.keys());
  }

  /** Get all child window IDs (excluding main). */
  getChildWindowIds(): number[] {
    if (this.mainWindowId === null) {
      return Array.from(this.windows.keys());
    }
    return Array.from(this.windows.keys()).filter(id => id !== this.mainWindowId);
  }

  /** Focus the window that owns the given session. */
  focusWindowForSession(sessionId: string): boolean {
    const win = this.getWindowForSession(sessionId);
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    return true;
  }

  /** Close all child windows. */
  closeAllChildWindows(): void {
    for (const id of this.getChildWindowIds()) {
      const win = this.windows.get(id);
      if (win && !win.isDestroyed()) {
        win.close();
      }
    }
    this.sessionToWindow.clear();
  }
}
