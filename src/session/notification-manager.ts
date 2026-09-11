import { Notification, BrowserWindow, systemPreferences } from 'electron';
import type { SessionManager } from './manager.js';
import { logger } from '../utils/logger.js';
import type { WindowManager } from '../electron/window-manager.js';
import { parseAccentColor, contrastText } from './color-contrast.js';

/** Payload broadcast to renderers to start a flash-attention pulse on a session. */
export interface FlashAttentionPayload {
  sessionId: string;
  /** Normalised `#rrggbb` Windows accent, or null → renderer falls back to the app accent. */
  accentColor: string | null;
  /** Readable text colour for the accent, or null when accentColor is null. */
  textColor: string | null;
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
 * - Screen locked + Telegram configured → Telegram
 * - Screen locked, no Telegram → none
 * - Window hidden → OS toast
 * - Window visible, not focused → OS toast + taskbar flash
 * - Window visible, focused, different session → in-app bubble
 * - Window visible, focused, same session → none
 */
export class NotificationManager {
  private screenLockChecker: (() => boolean) | null = null;
  private telegramNotifier: ((sessionId: string, title: string, content: string) => Promise<void>) | null = null;
  private activeSessionIdGetter: (() => string | null) | null = null;
  private accentColorReader: (() => string | null) | null = null;
  private mobileNotifier: MobileNotifierHooks | null = null;

  constructor(
    private windowManager: WindowManager,
    private sessionManager: SessionManager,
  ) {}

  setScreenLockChecker(fn: () => boolean): void { this.screenLockChecker = fn; }

  setTelegramNotifier(fn: (sessionId: string, title: string, content: string) => Promise<void>): void { this.telegramNotifier = fn; }

  /**
   * The paired phone. Fed UNCONDITIONALLY and in addition to every other route —
   * never instead of one. A phone that also sees the Telegram message buzzes
   * twice, which is ratified: Telegram is the only path that survives being out
   * of BLE range, and suppressing one when the other is connected would make
   * "was I told?" depend on link state. See docs/chat-fan-out.md.
   */
  setMobileNotifier(fn: MobileNotifierHooks): void { this.mobileNotifier = fn; }

  setActiveSessionIdGetter(fn: () => string | null): void { this.activeSessionIdGetter = fn; }

  /** Override the accent-colour source (tests inject a fake; default reads the OS theme). */
  setAccentColorReader(fn: () => string | null): void { this.accentColorReader = fn; }

  private readAccentColor(): string | null {
    if (this.accentColorReader) return this.accentColorReader();
    try {
      return systemPreferences?.getAccentColor?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Flash a session to grab the user's attention (Helm flash_attention MCP tool).
   *
   * Resolves the Windows theme accent, derives a readable text colour, and
   * broadcasts `session:flashAttention` to every live renderer. The renderer
   * owns the pulse→solid timing and decides whether to flash the session card
   * or its (collapsed) group header. Unknown sessions are a graceful no-op.
   */
  flashAttention(sessionId: string): { flashed: boolean } {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn(`[Flash] Ignoring flash_attention for unknown session: ${sessionId}`);
      return { flashed: false };
    }

    const accentColor = parseAccentColor(this.readAccentColor());
    const textColor = accentColor ? contrastText(accentColor) : null;
    const payload: FlashAttentionPayload = { sessionId, accentColor, textColor };

    // The phone is told too, and is told FIRST: a flash is a "look at me" for a
    // user who may not be at the desk, which is the case the phone exists for.
    this.mobileNotifier?.flashed(sessionId);

    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    for (const window of windows) {
      window.webContents.send('session:flashAttention', payload);
    }
    logger.info(`[Flash] flash_attention for session ${sessionId} (accent=${accentColor ?? 'app-default'})`);
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
   * - Screen locked + Telegram → 'telegram'
   * - Screen locked, no Telegram → 'none'
   * - Window hidden → 'toast'
   * - Window visible, not focused → 'taskbar_flash' (toast + BrowserWindow.flashFrame)
   * - Window visible, focused, different session → 'bubble'
   * - Window visible, focused, same session → 'none'
   */
  notifyLlmDirected(sessionId: string, title: string, content: string): 'toast' | 'bubble' | 'telegram' | 'taskbar_flash' | 'none' {
    // The phone is fanned out to before any routing, never as one branch of it:
    // the returned route describes where the DESKTOP put it, and a phone in
    // another room is not an alternative to that, it is an addition.
    this.mobileNotifier?.notified(sessionId, title, content);

    // Route via Telegram if session is in Telegram mode (takes priority over everything)
    const session = this.sessionManager.getSession(sessionId);
    if (session?.interactionChannel === 'telegram' && this.telegramNotifier) {
      void this.telegramNotifier(sessionId, title, content);
      return 'telegram';
    }

    const isLocked = this.screenLockChecker?.() ?? false;
    if (isLocked) {
      if (this.telegramNotifier) {
        void this.telegramNotifier(sessionId, title, content);
        return 'telegram';
      }
      return 'none';
    }

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
