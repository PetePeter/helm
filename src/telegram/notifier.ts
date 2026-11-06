import type { TelegramBotCore } from './bot.js';
import type { TopicManager } from './topic-manager.js';
import type { SessionManager } from '../session/manager.js';
import type { TelegramConfig } from '../config/loader.js';
import type { ActivityLevel } from '../types/session.js';
import { notificationKeyboard } from './keyboards.js';
import { logger } from '../utils/logger.js';
import { alertKindForTransition } from '../session/session-alert.js';
import path from 'path';
import { cliLabel } from './cli-label.js';

/** Dedup guard window — skip duplicate notifications for the same session within this period. */
const DEDUP_WINDOW_MS = 15_000;

/** Max notifications per minute across all sessions. */
const MAX_NOTIFICATIONS_PER_MIN = 3;

const COMPLETED_LABEL = { emoji: '🎉', title: 'Session Completed', verb: 'is done' };

/** Local definition — StateDetector no longer exports this interface. */
interface StateTransition {
  sessionId: string;
  previousState: ActivityLevel;
  newState: ActivityLevel;
}

/**
 * Sends Telegram notifications when session state changes.
 *
 * Triggers on:
 * - Turn ended: the session's activity leaves 'active' (see session-alert.ts)
 * - Crash/error events (future)
 *
 * Each notification includes inline action buttons and is sent only to
 * the session's topic.
 */
export class TelegramNotifier {
  private lastNotificationTime: Map<string, number> = new Map();
  private globalNotificationTimes: number[] = [];

  constructor(
    private bot: TelegramBotCore,
    private topicManager: TopicManager,
    private sessionManager: SessionManager,
    private getConfig: () => TelegramConfig,
  ) {}

  /**
   * Handle an activity transition (fed from session:updated).
   * Only notifies when a turn ends.
   */
  handleStateChange(transition: StateTransition): void {
    // The definition of "something happened" is shared with the mobile surface
    // so the two can never drift into telling the user different things.
    if (!alertKindForTransition(transition.previousState, transition.newState)) return;

    if (!this.getConfig().notifyOnComplete) return;
    this.sendNotification(transition.sessionId, COMPLETED_LABEL);
  }

  /** Remove dedup tracking for a session. */
  removeSession(sessionId: string): void {
    this.lastNotificationTime.delete(sessionId);
  }

  /** Clean up all tracking. */
  dispose(): void {
    this.lastNotificationTime.clear();
    this.globalNotificationTimes = [];
  }

  private async sendNotification(
    sessionId: string,
    labelInfo: { emoji: string; title: string; verb: string },
  ): Promise<void> {
    if (!this.shouldNotify(sessionId)) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const dirName = session.workingDir ? path.basename(session.workingDir) : 'unknown';

    const text = [
      `${labelInfo.emoji} ${labelInfo.title}`,
      '',
      `"${session.name}" in ${dirName}`,
      `${cliLabel(session.cliType)} — ${labelInfo.verb}`,
    ].join('\n');

    const keyboard = notificationKeyboard(sessionId);

    // Send to the session's topic
    const topicId = this.topicManager.getTopicId(sessionId);
    if (topicId) {
      await this.bot.sendToTopic(topicId, text, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    this.lastNotificationTime.set(sessionId, Date.now());
    this.globalNotificationTimes.push(Date.now());
    logger.info(`[TelegramNotifier] ${labelInfo.title} — ${session.name}`);
  }

  private shouldNotify(sessionId: string): boolean {
    if (!this.bot.isRunning()) return false;

    const config = this.getConfig();
    if (!config.enabled) return false;

    // Per-session dedup
    const lastTime = this.lastNotificationTime.get(sessionId) ?? 0;
    if (Date.now() - lastTime < DEDUP_WINDOW_MS) return false;

    // Global rate limit
    const now = Date.now();
    this.globalNotificationTimes = this.globalNotificationTimes.filter(t => now - t < 60_000);
    if (this.globalNotificationTimes.length >= MAX_NOTIFICATIONS_PER_MIN) return false;

    return true;
  }
}
