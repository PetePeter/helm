import { Notification, BrowserWindow } from 'electron';
import type { SessionManager } from './manager.js';
import { logger } from '../utils/logger.js';
import type { WindowManager } from '../electron/window-manager.js';
import type { ProfileRuntimeRegistry } from './profile-runtime-registry.js';

/** Payload broadcast to renderers to start a flash-attention pulse on a session. */
export interface FlashAttentionPayload {
  sessionId: string;
}

/** The phone surface, as the two events that reach it. Implemented by MobileAlertNotifier. */
export interface MobileNotifierHooks {
  notified(sessionId: string, title: string, content: string): void;
  flashed(sessionId: string): void;
}

interface NotificationContent {
  title: string;
  body: string;
}

/**
 * Manages notifications for CLI sessions.
 *
 * Only LLM-directed notifications are supported — triggered explicitly via the
 * notify_user Helm MCP tool. Auto-activity notifications have been removed.
 *
 * Routing (notifyLlmDirected):
 * - Screen locked → none
 * - Window hidden → OS toast
 * - Window visible, not focused → OS toast + taskbar flash
 * - Window visible, focused, different session → in-app bubble
 * - Window visible, focused, same session → none
 */
export class NotificationManager {
  private screenLockChecker: (() => boolean) | null = null;
  private activeSessionIdGetter: (() => string | null) | null = null;
  private mobileNotifier: MobileNotifierHooks | null = null;

  constructor(
    private windowManager: WindowManager,
    private sessionManager: SessionManager,
    private readonly runtimeRegistry?: Pick<ProfileRuntimeRegistry, 'findSessionOwner' | 'isSessionInActiveProfile'>,
  ) {}

  setScreenLockChecker(fn: () => boolean): void { this.screenLockChecker = fn; }

  /**
   * The paired phone receives every LLM-directed notification independently
   * of the desktop route.
   */
  setMobileNotifier(fn: MobileNotifierHooks): void { this.mobileNotifier = fn; }

  setActiveSessionIdGetter(fn: () => string | null): void { this.activeSessionIdGetter = fn; }

  /**
   * Flash a session to grab the user's attention (Helm flash_attention MCP tool).
   *
   * Broadcasts `session:flashAttention` to every live renderer. The renderer
   * owns the pulse→solid timing and decides whether to flash the session card
   * or its (collapsed) group header. Unknown sessions are a graceful no-op.
   */
  flashAttention(sessionId: string): { flashed: boolean } {
    const owner = this.runtimeRegistry?.findSessionOwner(sessionId);
    const session = owner
      ? owner.sessionManager.getSession(sessionId)
      : this.runtimeRegistry ? null : this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn(`[Flash] Ignoring flash_attention for unknown session: ${sessionId}`);
      return { flashed: false };
    }

    const payload: FlashAttentionPayload = { sessionId };

    // The phone is told too, and is told FIRST: a flash is a "look at me" for a
    // user who may not be at the desk, which is the case the phone exists for.
    this.mobileNotifier?.flashed(sessionId);

    // Only the desktop is gated: an inactive profile's session is not on screen.
    const windows = this.runtimeRegistry && !this.runtimeRegistry.isSessionInActiveProfile(sessionId)
      ? []
      : BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    for (const window of windows) {
      window.webContents.send('session:flashAttention', payload);
    }
    logger.info(`[Flash] flash_attention for session ${sessionId}`);
    return { flashed: true };
  }

  getAppVisibility(): 'visible-focused' | 'visible-background' | 'hidden' {
    const focusedWin = BrowserWindow.getAllWindows().find(w => w.isFocused());
    if (focusedWin && !focusedWin.isDestroyed()) return 'visible-focused';
    const anyWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    if (anyWin) return 'visible-background';
    return 'hidden';
  }

  getAppVisibilityDetails(): {
    visibility: 'visible-focused' | 'visible-background' | 'hidden';
    screenLocked: boolean;
    activeSessionId: string | null;
  } {
    return {
      visibility: this.getAppVisibility(),
      screenLocked: this.screenLockChecker?.() ?? false,
      activeSessionId: this.activeSessionIdGetter?.() ?? null,
    };
  }

  /**
   * Send an LLM-directed notification via the Helm MCP notify_user tool.
   *
   * Routing:
   * - Screen locked → 'none'
   * - Window hidden → 'toast'
   * - Window visible, not focused → 'taskbar_flash' (toast + BrowserWindow.flashFrame)
   * - Window visible, focused, different session → 'bubble'
   * - Window visible, focused, same session → 'none'
   */
  notifyLlmDirected(sessionId: string, title: string, content: string): 'toast' | 'bubble' | 'taskbar_flash' | 'none' {
    // The phone is fanned out to before any routing, never as one branch of it:
    // the returned route describes where the DESKTOP put it, and a phone in
    // another room is not an alternative to that, it is an addition.
    this.mobileNotifier?.notified(sessionId, title, content);

    const isLocked = this.screenLockChecker?.() ?? false;
    if (isLocked) {
      return 'none';
    }

    // An inactive profile's session is still running; its title and body are
    // that profile's private content and must not reach the visible desktop.
    if (this.runtimeRegistry && !this.runtimeRegistry.isSessionInActiveProfile(sessionId)) return 'none';

    const visibility = this.getAppVisibility();
    this.dispatchLlmInAppNotification(sessionId, title, content);

    if (visibility === 'hidden') {
      this.showNotification({ title, body: content }, sessionId);
      return 'toast';
    }

    if (visibility === 'visible-background') {
      this.showNotification({ title, body: content }, sessionId);
      const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      mainWin?.flashFrame(true);
      return 'taskbar_flash';
    }

    // visible-focused
    const activeId = this.activeSessionIdGetter?.();
    if (activeId === sessionId) return 'none';
    return 'bubble';
  }

  private dispatchLlmInAppNotification(sessionId: string, title: string, content: string): void {
    const windows = BrowserWindow.getAllWindows();
    const targetWindows = windows.filter((window) => !window.isDestroyed());
    for (const window of targetWindows) {
      window.webContents.send('notification:llmNotify', { sessionId, title, content });
    }
  }

  private showNotification(content: NotificationContent, sessionId: string): void {
    try {
      const notification = new Notification({
        title: content.title,
        body: content.body,
        silent: true,
      });

      notification.on('click', () => {
        const win = this.windowManager.getWindowForSession(sessionId);
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.send('notification:click', { sessionId });
        }
      });

      notification.show();
      logger.info(`[Notification] ${content.title} — ${content.body}`);
    } catch (error) {
      logger.error(`[Notification] Failed to show: ${error}`);
    }
  }

  removeSession(_sessionId: string): void {}

  dispose(): void {}
}
