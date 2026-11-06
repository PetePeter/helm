/**
 * Telegram Bot IPC Handlers
 *
 * Exposes Telegram bot configuration and control operations to the renderer.
 */

import { ipcMain } from 'electron';
import type { ConfigLoader, TelegramConfig } from '../../config/loader.js';
import type { TelegramBotCore } from '../../telegram/bot.js';
import type { TopicManager } from '../../telegram/topic-manager.js';
import type { TelegramNotifier } from '../../telegram/notifier.js';
import type { SessionManager } from '../../session/manager.js';
import type { StateDetector } from '../../session/state-detector.js';
import { logger } from '../../utils/logger.js';
import type { ActivityLevel } from '../../types/session.js';

export function setupTelegramHandlers(
  configLoader: ConfigLoader,
  botCore: TelegramBotCore,
  topicManager: TopicManager,
  notifier: TelegramNotifier,
  sessionManager: SessionManager,
  stateDetector: StateDetector,
  onConfigChanged?: () => void,
): () => void {
  // --- Turn-ended notifications: activity leaving 'active' (see session-alert.ts) ---

  const lastLevel = new Map<string, ActivityLevel>();
  const onActivity = (event: { sessionId: string; level: ActivityLevel }) => {
    const previous = lastLevel.get(event.sessionId);
    lastLevel.set(event.sessionId, event.level);
    if (previous) notifier.handleStateChange({ sessionId: event.sessionId, previousState: previous, newState: event.level });
  };
  stateDetector.on('activity-change', onActivity);

  // --- Config CRUD ---

  ipcMain.handle('telegram:getConfig', () => {
    try {
      return configLoader.getTelegramConfig();
    } catch (error) {
      logger.error(`[IPC] Failed to get telegram config: ${error}`);
      return null;
    }
  });

  ipcMain.handle('telegram:setConfig', (_event, updates: Partial<TelegramConfig>) => {
    try {
      configLoader.setTelegramConfig(updates);
      onConfigChanged?.();
      logger.info(`[IPC] Telegram config updated: ${JSON.stringify(updates)}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set telegram config: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // --- Bot lifecycle ---

  ipcMain.handle('telegram:start', async () => {
    try {
      const config = configLoader.getTelegramConfig();
      if (!config.botToken || !config.chatId) {
        return { success: false, error: 'Bot token and chat ID are required' };
      }
      if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
        return { success: false, error: 'At least one allowed user ID is required' };
      }
      botCore.start(config.botToken, config.chatId, config.allowedUserIds);
      topicManager.setInstanceName(config.instanceName);
      await topicManager.ensureAllTopics();
      logger.info('[IPC] Telegram bot started via IPC');
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to start telegram bot: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:stop', () => {
    try {
      botCore.stop();
      logger.info('[IPC] Telegram bot stopped');
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to stop telegram bot: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:isRunning', () => {
    return botCore.isRunning();
  });

  ipcMain.handle('telegram:testConnection', async () => {
    try {
      const config = configLoader.getTelegramConfig();
      if (!config.botToken) {
        return { success: false, error: 'Bot token is required' };
      }

      // Create a temporary bot to test the token
      const TelegramBot = (await import('node-telegram-bot-api')).default;
      const testBot = new TelegramBot(config.botToken);
      const me = await testBot.getMe();
      await testBot.stopPolling();

      return {
        success: true,
        botName: me.username,
        botId: me.id,
      };
    } catch (error) {
      logger.error(`[IPC] Telegram connection test failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  return () => {
    stateDetector.off('activity-change', onActivity);
    botCore.stop();
    notifier.dispose();
  };
}
