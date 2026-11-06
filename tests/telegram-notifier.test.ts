/**
 * TelegramNotifier unit tests
 *
 * Tests: state change handling, dedup window, rate limiting,
 * per-event config toggles, formatting, dispose cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramNotifier } from '../src/telegram/notifier.js';
import type { ActivityLevel } from '../src/types/session.js';
import type { TelegramConfig } from '../src/config/loader.js';
import type { SessionInfo } from '../src/types/session.js';

/** StateTransition shape consumed by TelegramNotifier.handleStateChange. */
interface StateTransition {
  sessionId: string;
  previousState: ActivityLevel;
  newState: ActivityLevel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBot() {
  return {
    sendToTopic: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    isRunning: vi.fn().mockReturnValue(true),
  };
}

function makeMockTopicManager() {
  return {
    getTopicId: vi.fn().mockReturnValue(42),
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'my-session',
    cliType: 'claude-code',
    processId: 1234,
    workingDir: '/projects/app',
    state: 'idle',
    topicId: 42,
    ...overrides,
  };
}

function makeMockSessionManager(sessions: SessionInfo[]) {
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  return {
    getAllSessions: vi.fn(() => [...sessionMap.values()]),
    getSession: vi.fn((id: string) => sessionMap.get(id) ?? null),
  };
}

function defaultConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    enabled: true,
    autoStart: false,
    botToken: 'test-token',
    instanceName: 'Home',
    chatId: -100123,
    allowedUserIds: [],
    safeModeDefault: true,
    notifyOnComplete: true,
    notifyOnIdle: true,
    notifyOnError: true,
    notifyOnCrash: true,
    ...overrides,
  };
}

/** Build a turn-ended transition (active → inactive). */
function transition(sessionId: string, _label?: string): StateTransition {
  return { sessionId, previousState: 'active', newState: 'inactive' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramNotifier', () => {
  let bot: ReturnType<typeof makeMockBot>;
  let topicManager: ReturnType<typeof makeMockTopicManager>;
  let session: SessionInfo;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let config: TelegramConfig;
  let notifier: TelegramNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    bot = makeMockBot();
    topicManager = makeMockTopicManager();
    session = makeSession();
    sessionManager = makeMockSessionManager([session]);
    config = defaultConfig();
    notifier = new TelegramNotifier(
      bot as any,
      topicManager as any,
      sessionManager as any,
      () => config,
    );
  });

  afterEach(() => {
    notifier.dispose();
    vi.useRealTimers();
  });

  // =========================================================================
  // Basic notification sending
  // =========================================================================

  describe('handleStateChange', () => {
    it('sends notification to correct topic on active→completed', () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));

      expect(bot.sendToTopic).toHaveBeenCalledWith(
        42,
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
    });

    it('includes keyboard (reply_markup) in notification', () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));

      expect(bot.sendToTopic).toHaveBeenCalledWith(
        42,
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: expect.stringContaining('sess-1') }),
              ]),
            ]),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Notification formatting
  // =========================================================================

  describe('formatting', () => {
    it('includes emoji and state info for completed', () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));

      const text = bot.sendToTopic.mock.calls[0][1] as string;
      expect(text).toContain('🎉');
      expect(text).toContain('Session Completed');
      expect(text).toContain('my-session');
    });

    it('includes directory basename in text', () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));

      const text = bot.sendToTopic.mock.calls[0][1] as string;
      expect(text).toContain('app'); // basename of /projects/app
    });
  });

  // =========================================================================
  // Ignores non-active → X transitions
  // =========================================================================

  describe('non-active transitions ignored', () => {
    it('ignores idle→inactive (not from active)', () => {
      notifier.handleStateChange({
        sessionId: 'sess-1',
        previousState: 'idle',
        newState: 'inactive',
      });
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('ignores active→active', () => {
      notifier.handleStateChange({
        sessionId: 'sess-1',
        previousState: 'active',
        newState: 'active',
      });
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('ignores inactive→idle (already stopped)', () => {
      notifier.handleStateChange({
        sessionId: 'sess-1',
        previousState: 'inactive',
        newState: 'idle',
      });
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dedup window
  // =========================================================================

  describe('dedup window', () => {
    it('deduplicates within 15s window', async () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));
      // Flush async sendNotification so lastNotificationTime is set
      await vi.advanceTimersByTimeAsync(0);

      notifier.handleStateChange(transition('sess-1', 'idle'));
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendToTopic).toHaveBeenCalledTimes(1);
    });

    it('allows same session after 15s', async () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(16_000);

      notifier.handleStateChange(transition('sess-1', 'idle'));
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendToTopic).toHaveBeenCalledTimes(2);
    });

    it('allows different sessions within dedup window', async () => {
      const s2 = makeSession({ id: 'sess-2', name: 'other' });
      const mgr = makeMockSessionManager([session, s2]);
      const n = new TelegramNotifier(bot as any, topicManager as any, mgr as any, () => config);

      n.handleStateChange(transition('sess-1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('sess-2', 'completed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendToTopic).toHaveBeenCalledTimes(2);
      n.dispose();
    });
  });

  // =========================================================================
  // Global rate limit (3/min)
  // =========================================================================

  describe('global rate limit', () => {
    it('respects 3 notifications per minute', async () => {
      const sessions = [
        makeSession({ id: 's1', name: 'a' }),
        makeSession({ id: 's2', name: 'b' }),
        makeSession({ id: 's3', name: 'c' }),
        makeSession({ id: 's4', name: 'd' }),
      ];
      const mgr = makeMockSessionManager(sessions);
      const n = new TelegramNotifier(bot as any, topicManager as any, mgr as any, () => config);

      n.handleStateChange(transition('s1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('s2', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('s3', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('s4', 'completed')); // should be dropped
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendToTopic).toHaveBeenCalledTimes(3);
      n.dispose();
    });

    it('allows more notifications after 1 minute', async () => {
      const sessions = [
        makeSession({ id: 's1', name: 'a' }),
        makeSession({ id: 's2', name: 'b' }),
        makeSession({ id: 's3', name: 'c' }),
        makeSession({ id: 's4', name: 'd' }),
      ];
      const mgr = makeMockSessionManager(sessions);
      const n = new TelegramNotifier(bot as any, topicManager as any, mgr as any, () => config);

      n.handleStateChange(transition('s1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('s2', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      n.handleStateChange(transition('s3', 'completed'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(61_000);

      n.handleStateChange(transition('s4', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendToTopic).toHaveBeenCalledTimes(4);
      n.dispose();
    });
  });

  // =========================================================================
  // Per-event config toggles
  // =========================================================================

  describe('per-event config toggles', () => {
    it('skips completed notification when notifyOnComplete=false', () => {
      config = defaultConfig({ notifyOnComplete: false });
      notifier.handleStateChange(transition('sess-1', 'completed'));
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

  });

  // =========================================================================
  // Skip conditions
  // =========================================================================

  describe('skip conditions', () => {
    it('skips when bot is not running', () => {
      bot.isRunning.mockReturnValue(false);
      notifier.handleStateChange(transition('sess-1', 'completed'));
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('skips when config.enabled is false', () => {
      config = defaultConfig({ enabled: false });
      notifier.handleStateChange(transition('sess-1', 'completed'));
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('skips when session has no topicId', () => {
      topicManager.getTopicId.mockReturnValue(null);
      notifier.handleStateChange(transition('sess-1', 'completed'));
      // sendToTopic should NOT be called since topicId is null
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('skips when session not found in manager', () => {
      sessionManager.getSession.mockReturnValue(null);
      notifier.handleStateChange(transition('unknown', 'completed'));
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dispose
  // =========================================================================

  describe('dispose', () => {
    it('clears tracking state', async () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      notifier.dispose();

      // After dispose + immediate re-notify, dedup map should be clear
      // so a notification can be sent again
      notifier.handleStateChange(transition('sess-1', 'idle'));
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendToTopic).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // removeSession
  // =========================================================================

  describe('removeSession', () => {
    it('clears dedup tracking for a session', async () => {
      notifier.handleStateChange(transition('sess-1', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      notifier.removeSession('sess-1');

      // Immediately re-notify: should succeed since dedup was cleared
      notifier.handleStateChange(transition('sess-1', 'idle'));
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendToTopic).toHaveBeenCalledTimes(2);
    });
  });
});
