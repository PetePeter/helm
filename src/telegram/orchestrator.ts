/**
 * Telegram Module Orchestrator
 *
 * Wires together Telegram integration modules and exposes cleanup.
 * Called from the IPC handler orchestrator after bot, topicManager, and notifier
 * are created. Returns module instances + cleanup function.
 */

import type { TelegramBotCore } from './bot.js';
import type { TopicManager } from './topic-manager.js';
import type { TelegramNotifier } from './notifier.js';
import type { SessionManager } from '../session/manager.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ProjectStore } from '../session/project-store.js';
import { PinnedDashboard } from './pinned-dashboard.js';
import { TelegramRelayService } from './relay-service.js';
import { setupCallbackHandler } from './callback-handler.js';
import { setupTopicInput } from './topic-input.js';
import { setupCommandHandler } from './command-handler.js';
import { logger } from '../utils/logger.js';
import type { HelmControlService } from '../mcp/helm-control-service.js';
import { setCliLabelResolver } from './cli-label.js';

export interface TelegramModules {
  dashboard: PinnedDashboard;
  relayService: TelegramRelayService;
  cleanup: () => void;
}

export function initTelegramModules(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  _notifier: TelegramNotifier,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  helmControlService: HelmControlService,
  projectStore?: ProjectStore,
): TelegramModules {
  // CLI types are keyed by UUID; Telegram must render labels, never ids.
  setCliLabelResolver(ref => configLoader.getCliTypeLabel(ref));
  const instanceName = configLoader.getTelegramConfig().instanceName;
  const dashboard = new PinnedDashboard(bot, sessionManager, instanceName);
  const relayService = new TelegramRelayService(bot, topicManager, sessionManager, ptyManager, configLoader, helmControlService);
  helmControlService.setTelegramBridge(relayService);

  const cleanupCallbacks = setupCallbackHandler(
    bot, topicManager, sessionManager, ptyManager,
    configLoader, projectStore,
  );

  const cleanupTopicInput = setupTopicInput(
    bot, topicManager, ptyManager, configLoader, sessionManager, relayService,
  );

  const cleanupCommands = setupCommandHandler(bot, sessionManager, ptyManager, topicManager, helmControlService, configLoader);

  // Listen for forum_topic_closed events from Telegram
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topicClosedHandler = (msg: any) => {
    if (msg.forum_topic_closed && msg.message_thread_id) {
      const topicId: number = msg.message_thread_id;
      const session = topicManager.findSessionByTopicId(topicId);
      // Delete the forum topic before handleTopicClosed clears session.topicId —
      // otherwise the session:removed listener sees topicId=undefined and skips deletion.
      if (session) {
        topicManager.closeSessionTopic(session).catch(err =>
          logger.warn(`[Telegram] Failed to delete topic ${topicId} on close: ${err}`),
        );
      }
      topicManager.handleTopicClosed(topicId);
      if (session) {
        if (session.locked) {
          logger.info(`[Telegram] Preserving locked session ${session.id} after its topic closed`);
          return;
        }
        try { ptyManager.kill(session.id); } catch { /* already dead */ }
        sessionManager.removeSession(session.id);
      }
    }
  };
  bot.on('message', topicClosedHandler);

  // Listen for forum_topic_edited events — rename Helm session to match
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topicEditedHandler = (msg: any) => {
    if (msg.forum_topic_edited && msg.message_thread_id) {
      const newName: string | undefined = msg.forum_topic_edited.name;
      if (!newName) return; // icon-only edit, name unchanged
      const session = topicManager.findSessionByTopicId(msg.message_thread_id);
      if (!session) return;
      const prefix = `[${instanceName}] `;
      const stripped = newName.startsWith(prefix) ? newName.slice(prefix.length) : newName;
      sessionManager.renameSession(session.id, stripped);
    }
  };
  bot.on('message', topicEditedHandler);

  // Forward reaction events to the relay service
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reactionHandler = async (reaction: any) => {
    await relayService.handleReaction(reaction);
  };
  bot.on('message_reaction', reactionHandler);

  logger.info('[Telegram] All modules initialized');

  return {
    dashboard,
    relayService,
    cleanup: () => {
      cleanupCallbacks();
      cleanupTopicInput();
      cleanupCommands();
      bot.removeListener('message', topicClosedHandler);
      bot.removeListener('message', topicEditedHandler);
      bot.removeListener('message_reaction', reactionHandler);
      helmControlService.setTelegramBridge(null);
      dashboard.dispose();
      logger.info('[Telegram] All modules cleaned up');
    },
  };
}
