/**
 * Comprehensive unit tests for NotificationManager.notifyLlmDirected().
 *
 * Covers all delivery branches:
 * 1. Screen Locked + Telegram Enabled: calls telegramNotifier, returns 'telegram'
 * 2. Screen Locked + Telegram Disabled: returns 'none'
 * 3. App Hidden/Minimised: calls showNotification(), returns 'toast'
 * 4. App Visible + Not Focused: shows notification + flashes taskbar, returns 'taskbar_flash'
 * 5. App Visible + Active Session: returns 'none' immediately
 * 6. App Visible + Different Session: sends IPC bubble, returns 'bubble'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationManager } from '../src/session/notification-manager.js';
import type { SessionManager } from '../src/session/manager.js';
import type { WindowManager } from '../src/electron/window-manager.js';

// Mock electron before any imports
const electronMockState = vi.hoisted(() => {
  const getAllWindowsMock = vi.fn();
  return { getAllWindowsMock };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: electronMockState.getAllWindowsMock,
  },
  Notification: class MockNotification {
    constructor(private options: any) {}
    on = vi.fn();
    show = vi.fn();
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockWindowManager(): WindowManager {
  return {
    getMainWindow: vi.fn(),
    getWindowForSession: vi.fn(),
    getWindowIdForSession: vi.fn(),
    getWindow: vi.fn(),
    unassignSession: vi.fn(),
    unregisterWindow: vi.fn(),
    registerWindow: vi.fn(),
    assignSessionToWindow: vi.fn(),
    isSessionSnappedOut: vi.fn(),
    focusWindowForSession: vi.fn(),
  } as unknown as WindowManager;
}

function createMockSessionManager(): SessionManager {
  return {
    getSession: vi.fn(),
    removeSession: vi.fn(),
    getAllSessions: vi.fn(),
    setActiveSession: vi.fn(),
    getActiveSession: vi.fn(),
    renameSession: vi.fn(),
    hasSession: vi.fn(),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

describe('NotificationManager.notifyLlmDirected()', () => {
  let notificationManager: NotificationManager;
  let windowManager: WindowManager;
  let sessionManager: SessionManager;
  let screenLockChecker: ReturnType<typeof vi.fn>;
  let telegramNotifier: ReturnType<typeof vi.fn>;
  let activeSessionIdGetter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    electronMockState.getAllWindowsMock.mockClear();
    windowManager = createMockWindowManager();
    sessionManager = createMockSessionManager();

    notificationManager = new NotificationManager(windowManager, sessionManager);

    screenLockChecker = vi.fn(() => false);
    telegramNotifier = vi.fn();
    activeSessionIdGetter = vi.fn(() => null);

    notificationManager.setScreenLockChecker(screenLockChecker);
    notificationManager.setTelegramNotifier(telegramNotifier);
    notificationManager.setActiveSessionIdGetter(activeSessionIdGetter);
  });

  describe('2. Screen Locked + Telegram Enabled', () => {
    beforeEach(() => {
      screenLockChecker.mockReturnValue(true);
      telegramNotifier.mockClear();
    });

    it('calls telegramNotifier with sessionId, title, and content', () => {
      const result = notificationManager.notifyLlmDirected('sess-1', 'My Title', 'My Content');

      expect(telegramNotifier).toHaveBeenCalledWith('sess-1', 'My Title', 'My Content');
      expect(result).toBe('telegram');
    });

    it('returns "telegram" as delivery mechanism', () => {
      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(result).toBe('telegram');
    });

    it('passes exact sessionId, title, and content to telegramNotifier', () => {
      const sessionId = 'sess-special-123';
      const longTitle = 'This is a very long title with special chars: @#$%^&*()';
      const longContent = 'Multi-line content\nWith newlines\nAnd more text';

      notificationManager.notifyLlmDirected(sessionId, longTitle, longContent);

      expect(telegramNotifier).toHaveBeenCalledWith(sessionId, longTitle, longContent);
    });

    it('calls telegramNotifier even if sessionId is empty', () => {
      notificationManager.notifyLlmDirected('', 'Title', 'Content');
      expect(telegramNotifier).toHaveBeenCalledWith('', 'Title', 'Content');
    });
  });

  describe('3. Screen Locked + Telegram Disabled', () => {
    beforeEach(() => {
      screenLockChecker.mockReturnValue(true);
      notificationManager.setTelegramNotifier(null as any);
    });

    it('returns "none" when telegramNotifier is not set', () => {
      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(result).toBe('none');
    });

    it('does not call any notification method', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');
      notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(showNotificationSpy).not.toHaveBeenCalled();
    });

    it('exits early without checking window state', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');
      electronMockState.getAllWindowsMock.mockReturnValue([]);

      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

      expect(result).toBe('none');
      expect(electronMockState.getAllWindowsMock).not.toHaveBeenCalled();
      expect(showNotificationSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. App Hidden/Minimised', () => {
    beforeEach(() => {
      screenLockChecker.mockReturnValue(false);
      electronMockState.getAllWindowsMock.mockReturnValue([]);
    });

    it('returns "toast" when app is hidden', () => {
      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(result).toBe('toast');
    });

    it('calls showNotification when app is hidden', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');

      notificationManager.notifyLlmDirected('sess-1', 'My Title', 'My Content');

      expect(showNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Title',
          body: 'My Content',
        }),
        'sess-1',
      );
    });

    it('passes sessionId to showNotification', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');

      notificationManager.notifyLlmDirected('sess-abc-123', 'Title', 'Content');

      expect(showNotificationSpy).toHaveBeenCalledWith(
        expect.any(Object),
        'sess-abc-123',
      );
    });
  });

  describe('5. App Visible + Active Session', () => {
    let mockWindow: any;

    beforeEach(() => {
      screenLockChecker.mockReturnValue(false);
      mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue('sess-1');
    });

    it('returns "none" when active session matches notified session', () => {
      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(result).toBe('none');
    });

    it('still sends IPC so the in-app notification list can persist it', () => {
      notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'notification:llmNotify',
        {
          sessionId: 'sess-1',
          title: 'Title',
          content: 'Content',
        },
      );
    });

    it('returns "none" immediately without calling showNotification', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');

      notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

      expect(showNotificationSpy).not.toHaveBeenCalled();
    });

    it('works when activeSessionIdGetter returns exact sessionId', () => {
      activeSessionIdGetter.mockReturnValue('my-session-abc');

      const result = notificationManager.notifyLlmDirected('my-session-abc', 'Title', 'Content');

      expect(result).toBe('none');
    });
  });

  describe('6. App Visible + Different Session', () => {
    let mockWindow: any;

    beforeEach(() => {
      screenLockChecker.mockReturnValue(false);
      mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue('sess-1');
    });

    it('returns "bubble" when session differs from active session', () => {
      const result = notificationManager.notifyLlmDirected('sess-2', 'Title', 'Content');
      expect(result).toBe('bubble');
    });

    it('sends notification:llmNotify IPC event', () => {
      notificationManager.notifyLlmDirected('sess-2', 'My Title', 'My Content');

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'notification:llmNotify',
        expect.any(Object),
      );
    });

    it('includes correct sessionId, title, and content in IPC payload', () => {
      notificationManager.notifyLlmDirected('sess-2', 'My Title', 'My Content');

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'notification:llmNotify',
        {
          sessionId: 'sess-2',
          title: 'My Title',
          content: 'My Content',
        },
      );
    });

    it('sends IPC with exact strings', () => {
      const longTitle = 'Session Alert: @special #chars';
      const longContent = 'Line 1\nLine 2\nLine 3';

      notificationManager.notifyLlmDirected('sess-2', longTitle, longContent);

      const call = mockWindow.webContents.send.mock.calls[0];
      expect(call[1].title).toBe(longTitle);
      expect(call[1].content).toBe(longContent);
    });

    it('does not call showNotification for in-app bubble', () => {
      const showNotificationSpy = vi.spyOn(notificationManager as any, 'showNotification');

      notificationManager.notifyLlmDirected('sess-2', 'Title', 'Content');

      expect(showNotificationSpy).not.toHaveBeenCalled();
    });

    it('works with multiple windows (sends to first visible)', () => {
      const window2 = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => false),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow, window2]);

      notificationManager.notifyLlmDirected('sess-2', 'Title', 'Content');

      expect(mockWindow.webContents.send).toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('handles null activeSessionIdGetter result', () => {
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue(null);
      screenLockChecker.mockReturnValue(false);

      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

      expect(result).toBe('bubble');
    });

    it('handles undefined activeSessionIdGetter result', () => {
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue(undefined);
      screenLockChecker.mockReturnValue(false);

      const result = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

      expect(result).toBe('bubble');
    });

    it('handles empty sessionId', () => {
      screenLockChecker.mockReturnValue(true);
      const result = notificationManager.notifyLlmDirected('', 'Title', 'Content');
      expect(result).toBe('telegram');
    });

    it('handles very long content strings', () => {
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      screenLockChecker.mockReturnValue(false);
      activeSessionIdGetter.mockReturnValue('sess-2');

      const longContent = 'x'.repeat(10000);
      notificationManager.notifyLlmDirected('sess-1', 'Title', longContent);

      const payload = mockWindow.webContents.send.mock.calls[0][1];
      expect(payload.content).toBe(longContent);
    });

    it('handles special characters in title and content', () => {
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      screenLockChecker.mockReturnValue(false);
      activeSessionIdGetter.mockReturnValue('sess-2');

      const specialTitle = 'Alert: <script>alert("xss")</script>';
      const specialContent = 'Content with\nnewlines\tand\ttabs\r\nand ANSI: \x1b[32mgreen\x1b[0m';

      notificationManager.notifyLlmDirected('sess-1', specialTitle, specialContent);

      const payload = mockWindow.webContents.send.mock.calls[0][1];
      expect(payload.title).toBe(specialTitle);
      expect(payload.content).toBe(specialContent);
    });
  });

  describe('Session interaction channel affinity', () => {
    it('routes to telegram when session has interactionChannel=telegram', () => {
      screenLockChecker.mockReturnValue(false);
      (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-tg', interactionChannel: 'telegram',
      });

      const result = notificationManager.notifyLlmDirected('sess-tg', 'Title', 'Content');

      expect(telegramNotifier).toHaveBeenCalledWith('sess-tg', 'Title', 'Content');
      expect(result).toBe('telegram');
    });

    it('takes priority over screen-locked routing (still goes telegram)', () => {
      screenLockChecker.mockReturnValue(true);
      (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-tg', interactionChannel: 'telegram',
      });

      const result = notificationManager.notifyLlmDirected('sess-tg', 'Title', 'Content');

      expect(telegramNotifier).toHaveBeenCalledWith('sess-tg', 'Title', 'Content');
      expect(result).toBe('telegram');
    });

    it('falls through to normal routing when interactionChannel is desktop', () => {
      screenLockChecker.mockReturnValue(false);
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue('other-session');
      (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-desktop', interactionChannel: 'desktop',
      });

      const result = notificationManager.notifyLlmDirected('sess-desktop', 'Title', 'Content');

      expect(telegramNotifier).not.toHaveBeenCalled();
      expect(result).toBe('bubble');
    });

    it('falls through to normal routing when interactionChannel is undefined', () => {
      screenLockChecker.mockReturnValue(false);
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue('other-session');
      (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-none',
      });

      const result = notificationManager.notifyLlmDirected('sess-none', 'Title', 'Content');

      expect(telegramNotifier).not.toHaveBeenCalled();
      expect(result).toBe('bubble');
    });

    it('falls through to normal routing when interactionChannel=telegram but telegramNotifier is not set', () => {
      screenLockChecker.mockReturnValue(false);
      notificationManager.setTelegramNotifier(null as any);
      const mockWindow = {
        isFocused: vi.fn(() => true),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      electronMockState.getAllWindowsMock.mockReturnValue([mockWindow]);
      activeSessionIdGetter.mockReturnValue('other-session');
      (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'sess-tg', interactionChannel: 'telegram',
      });

      const result = notificationManager.notifyLlmDirected('sess-tg', 'Title', 'Content');

      // Falls through to normal routing since telegramNotifier is not available
      expect(result).toBe('bubble');
    });
  });
});

describe('NotificationManager.flashAttention()', () => {
  let notificationManager: NotificationManager;
  let windowManager: WindowManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    electronMockState.getAllWindowsMock.mockClear();
    windowManager = createMockWindowManager();
    sessionManager = createMockSessionManager();
    notificationManager = new NotificationManager(windowManager, sessionManager);
    notificationManager.setAccentColorReader(() => '1f3a5fff');
  });

  it('broadcasts session:flashAttention to every live window with a resolved accent + text colour', () => {
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'sess-1' });
    const window1: any = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } };
    const window2: any = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } };
    const destroyed: any = { isDestroyed: vi.fn(() => true), webContents: { send: vi.fn() } };
    electronMockState.getAllWindowsMock.mockReturnValue([window1, window2, destroyed]);

    const result = notificationManager.flashAttention('sess-1');

    expect(result).toEqual({ flashed: true });
    const expectedPayload = { sessionId: 'sess-1', accentColor: '#1f3a5f', textColor: '#ffffff' };
    expect(window1.webContents.send).toHaveBeenCalledWith('session:flashAttention', expectedPayload);
    expect(window2.webContents.send).toHaveBeenCalledWith('session:flashAttention', expectedPayload);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it('is a graceful no-op for an unknown session', () => {
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const window1: any = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } };
    electronMockState.getAllWindowsMock.mockReturnValue([window1]);

    const result = notificationManager.flashAttention('ghost');

    expect(result).toEqual({ flashed: false });
    expect(window1.webContents.send).not.toHaveBeenCalled();
  });

  it('sends null colours when the accent is unavailable so the renderer falls back to the app accent', () => {
    notificationManager.setAccentColorReader(() => null);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'sess-1' });
    const window1: any = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } };
    electronMockState.getAllWindowsMock.mockReturnValue([window1]);

    notificationManager.flashAttention('sess-1');

    expect(window1.webContents.send).toHaveBeenCalledWith('session:flashAttention', {
      sessionId: 'sess-1',
      accentColor: null,
      textColor: null,
    });
  });
});


/**
 * The phone is an ADDITIONAL surface, never an alternative one.
 *
 * The failure this guards against is subtle: routing a notification to the phone
 * "because Telegram is unavailable" would make whether the user was told depend
 * on link state, which is the ambiguity the ratified double-buzz pays to avoid.
 */
describe('NotificationManager fan-out to a paired phone', () => {
  let notificationManager: NotificationManager;
  let sessionManager: SessionManager;
  let mobile: { notified: ReturnType<typeof vi.fn>; flashed: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    electronMockState.getAllWindowsMock.mockClear();
    electronMockState.getAllWindowsMock.mockReturnValue([]);
    sessionManager = createMockSessionManager();
    notificationManager = new NotificationManager(createMockWindowManager(), sessionManager);
    mobile = { notified: vi.fn(), flashed: vi.fn() };
    notificationManager.setMobileNotifier(mobile);
  });

  it('tells the phone about a notify_user whatever the desktop did with it', () => {
    notificationManager.setScreenLockChecker(() => true);
    const telegram = vi.fn();
    notificationManager.setTelegramNotifier(telegram);

    const route = notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

    expect(mobile.notified).toHaveBeenCalledWith('sess-1', 'Title', 'Content');
    expect(telegram).toHaveBeenCalled();
    // The route describes where the DESKTOP put it; the phone is not a route.
    expect(route).toBe('telegram');
  });

  it('tells the phone about a notify_user even with no Telegram at all', () => {
    notificationManager.setScreenLockChecker(() => false);

    notificationManager.notifyLlmDirected('sess-1', 'Title', 'Content');

    expect(mobile.notified).toHaveBeenCalledWith('sess-1', 'Title', 'Content');
  });

  it('tells the phone about a flash', () => {
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'sess-1' });

    notificationManager.flashAttention('sess-1');

    expect(mobile.flashed).toHaveBeenCalledWith('sess-1');
  });

  it('does not flash a phone about a session that does not exist', () => {
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    notificationManager.flashAttention('gone');

    expect(mobile.flashed).not.toHaveBeenCalled();
  });
});
