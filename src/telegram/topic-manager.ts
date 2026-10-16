import type { TelegramBotCore } from './bot.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionInfo } from '../types/session.js';
import { saveSessions } from '../session/persistence.js';
import { logger } from '../utils/logger.js';
import { TelegramTopicRegistry, type TelegramTopicRecord } from './topic-registry.js';
import { cliLabel } from './cli-label.js';

export interface StaleTopicProbe {
  sessionId: string;
  sessionName: string;
  topicId: number;
  status: 'alive' | 'dead' | 'orphan' | 'failed';
  error?: string;
}

export interface StaleTopicPreview {
  totalSessions: number;
  mappedTopics: number;
  alive: number;
  dead: number;
  failed: number;
  probes: StaleTopicProbe[];
}

export interface StaleTopicCleanupResult extends StaleTopicPreview {
  deleted: number;
  cleared: number;
  skipped: number;
  failures: Array<{ sessionId: string; topicId: number; error: string }>;
}

/**
 * Manages the mapping between hub sessions and Telegram forum topics.
 *
 * Each session gets its own forum topic. The topic ID is persisted in
 * sessions.yaml via the `topicId` field on SessionInfo.
 *
 * Topic naming convention: `[InstanceName] session-name`
 */
export class TopicManager {
  private topicNames = new Map<number, string>();

  constructor(
    private bot: TelegramBotCore,
    private sessionManager: SessionManager,
    private instanceName: string,
    private topicRegistry = new TelegramTopicRegistry(),
  ) {}

  /** Update the instance name prefix for topic names. */
  setInstanceName(name: string): void {
    this.instanceName = name;
  }

  /**
   * Ensure a session has a valid forum topic.
   * - If topicId exists: probe it by sending a "reconnected" message
   * - If probe fails or no topicId: create a new topic
   * Returns the topic ID (either existing or newly created).
   */
  async ensureTopic(session: SessionInfo): Promise<number | null> {
    if (session.topicId) {
      const alive = await this.probeTopic(session.topicId);
      if (alive) {
        logger.info(`[TopicManager] Topic ${session.topicId} alive for session ${session.id}`);
        this.topicNames.set(session.topicId, this.formatTopicName(session.name));
        this.topicRegistry.upsert({
          topicId: session.topicId,
          sessionId: session.id,
          sessionName: session.name,
        });
        return session.topicId;
      }
      logger.warn(`[TopicManager] Topic ${session.topicId} dead for session ${session.id}, recreating`);
      this.topicRegistry.remove(session.topicId);
    }

    return this.createTopicForSession(session);
  }

  /**
   * Ensure all current sessions have topics.
   * Called on bot startup after sessions are restored.
   */
  async ensureAllTopics(): Promise<void> {
    const sessions = this.sessionManager.getAllSessions();
    for (const session of sessions) {
      const topicId = await this.ensureTopic(session);
      if (topicId != null && topicId !== session.topicId) {
        this.updateSessionTopicId(session.id, topicId);
      }
    }
  }

  /**
   * Create a new forum topic for a session.
   * Updates the session's topicId in SessionManager.
   */
  async createTopicForSession(session: SessionInfo): Promise<number | null> {
    const topicName = this.formatTopicName(session.name, session.workingDir);
    const topic = await this.bot.createForumTopic(topicName);
    if (!topic) {
      logger.error(`[TopicManager] Failed to create topic for session ${session.id}`);
      return null;
    }

    const topicId = topic.message_thread_id;
    this.updateSessionTopicId(session.id, topicId);
    this.topicRegistry.upsert({
      topicId,
      sessionId: session.id,
      sessionName: session.name,
    });
    this.topicNames.set(topicId, topicName);
    logger.info(`[TopicManager] Created topic ${topicId} for session ${session.id}: "${topicName}"`);

    await this.bot.sendToTopic(
      topicId,
      `🖥️ Session: ${session.name}\nCLI: ${cliLabel(session.cliType)}\nDir: ${session.workingDir ?? 'unknown'}`,
    );

    return topicId;
  }

  /**
   * Delete a session's topic permanently from Telegram.
   * Called when a session is removed from the hub.
   */
  async closeSessionTopic(session: SessionInfo): Promise<void> {
    if (!session.topicId) return;

    const deleted = await this.bot.deleteForumTopic(session.topicId);
    if (!deleted) {
      logger.error(`[TopicManager] Failed to delete topic ${session.topicId} for session ${session.id}`);
      return;
    }
    this.topicNames.delete(session.topicId);
    this.topicRegistry.remove(session.topicId);
    logger.info(`[TopicManager] Deleted topic ${session.topicId} for session ${session.id}`);
  }

  /**
   * Delete a session's topic and clear the topicId so it can be recreated.
   */
  async deleteTopic(sessionId: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.topicId) return;
    const deleted = await this.bot.deleteForumTopic(session.topicId);
    if (!deleted) {
      logger.error(`[TopicManager] Failed to delete topic ${session.topicId} for session ${sessionId}`);
      return;
    }
    this.topicNames.delete(session.topicId);
    this.topicRegistry.remove(session.topicId);
    this.updateSessionTopicId(sessionId, undefined);
    logger.info(`[TopicManager] Deleted topic ${session.topicId} and cleared topicId for session ${sessionId}`);
  }

  /**
   * Handle a forum_topic_closed event from Telegram.
   * Clears the topicId so the next ensureTopic() creates a fresh topic.
   * The session keeps running — only the Telegram topic is gone.
   */
  handleTopicClosed(topicId: number): void {
    const session = this.findSessionByTopicId(topicId);
    if (session) {
      this.topicNames.delete(topicId);
      this.topicRegistry.remove(topicId);
      this.updateSessionTopicId(session.id, undefined);
      logger.info(`[TopicManager] Topic ${topicId} closed by user, cleared topicId for session ${session.id}`);
    }
  }

  /**
   * Rename a session's topic to match the new session name.
   * No-ops if the name is unchanged to avoid Telegram's TOPIC_NOT_MODIFIED error.
   */
  async renameSessionTopic(session: SessionInfo): Promise<void> {
    if (!session.topicId) return;
    const newName = this.formatTopicName(session.name, session.workingDir);
    if (this.topicNames.get(session.topicId) === newName) return;
    // Record before editing: a failed or timed-out edit must not be retried on
    // every session update. The next real rename tries again.
    this.topicNames.set(session.topicId, newName);
    await this.bot.editForumTopic(session.topicId, newName);
  }

  /**
   * Get the topic ID for a session, or null if not mapped.
   */
  getTopicId(sessionId: string): number | null {
    const session = this.sessionManager.getSession(sessionId);
    return session?.topicId ?? null;
  }

  /**
   * Find the session that maps to a given topic ID.
   * Used to route incoming Telegram messages to the correct session.
   */
  findSessionByTopicId(topicId: number): SessionInfo | null {
    const sessions = this.sessionManager.getAllSessions();
    return sessions.find(s => s.topicId === topicId) ?? null;
  }

  /** Return the session ID mapped to a Telegram topic, if any. */
  getSessionIdByTopic(topicId: number): string | null {
    return this.findSessionByTopicId(topicId)?.id ?? null;
  }

  /**
   * Preview cleanup for Helm-known topic mappings.
   *
   * Telegram bots cannot enumerate all forum topics, so cleanup is limited to
   * sessions Helm still knows about through topicId fields. Alive topics are
   * skipped because they still belong to active sessions; dead mappings can be
   * cleared on confirmation so Helm can create fresh topics later.
   */
  async previewStaleTopics(): Promise<StaleTopicPreview> {
    const sessions = this.sessionManager.getAllSessions();
    const mapped = sessions.filter(session => session.topicId != null);
    const probes: StaleTopicProbe[] = [];

    for (const session of mapped) {
      const topicId = session.topicId!;
      try {
        const alive = await this.probeTopic(topicId);
        probes.push({
          sessionId: session.id,
          sessionName: session.name,
          topicId,
          status: alive ? 'alive' : 'dead',
        });
      } catch (error) {
        probes.push({
          sessionId: session.id,
          sessionName: session.name,
          topicId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const record of this.orphanRegistryRecords()) {
      probes.push({
        sessionId: record.sessionId,
        sessionName: record.sessionName,
        topicId: record.topicId,
        status: 'orphan',
      });
    }

    return this.summarizePreview(sessions.length, probes);
  }

  /**
   * Clear dead Helm-known topic mappings after the user confirms the preview.
   * Does not delete topics for active sessions.
   */
  async cleanupStaleTopics(): Promise<StaleTopicCleanupResult> {
    const preview = await this.previewStaleTopics();
    let cleared = 0;
    let deleted = 0;
    const failures: StaleTopicCleanupResult['failures'] = [];

    for (const probe of preview.probes) {
      if (probe.status === 'dead') {
        try {
          this.updateSessionTopicId(probe.sessionId, undefined);
          this.topicRegistry.remove(probe.topicId);
          cleared++;
          logger.info(`[TopicManager] Cleared dead topic ${probe.topicId} for session ${probe.sessionId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ sessionId: probe.sessionId, topicId: probe.topicId, error: message });
          logger.error(`[TopicManager] Failed to clear dead topic ${probe.topicId} for ${probe.sessionId}: ${message}`);
        }
        continue;
      }

      if (probe.status !== 'orphan') continue;
      try {
        const deleteOk = await this.bot.deleteForumTopic(probe.topicId);
        if (!deleteOk) {
          throw new Error('Telegram deleteForumTopic returned false');
        }
        this.topicNames.delete(probe.topicId);
        this.topicRegistry.remove(probe.topicId);
        deleted++;
        logger.info(`[TopicManager] Deleted orphan topic ${probe.topicId} for former session ${probe.sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ sessionId: probe.sessionId, topicId: probe.topicId, error: message });
        logger.error(`[TopicManager] Failed to delete orphan topic ${probe.topicId} for ${probe.sessionId}: ${message}`);
      }
    }

    return {
      ...preview,
      deleted,
      cleared,
      skipped: preview.alive,
      failed: preview.failed + failures.length,
      failures,
    };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Probe whether a topic is still alive by attempting to send a message.
   * Telegram has no list/get endpoint for forum topics, so sending a
   * message is the only reliable way to verify a topic still exists.
   */
  private async probeTopic(topicId: number): Promise<boolean> {
    const result = await this.bot.sendToTopic(topicId, '🔄 Hub reconnected.');
    return result !== null;
  }

  private summarizePreview(totalSessions: number, probes: StaleTopicProbe[]): StaleTopicPreview {
    return {
      totalSessions,
      mappedTopics: probes.length,
      alive: probes.filter(probe => probe.status === 'alive').length,
      dead: probes.filter(probe => probe.status === 'dead').length,
      failed: probes.filter(probe => probe.status === 'failed').length,
      probes,
    };
  }

  /** Return the formatted topic name for a session (instance prefix + session name + dir tail). */
  getFormattedName(session: SessionInfo): string {
    return this.formatTopicName(session.name, session.workingDir);
  }

  /** Format a topic name with the instance prefix and working directory tail. */
  private formatTopicName(sessionName: string, workingDir?: string): string {
    const dir = workingDir ? ` (${workingDir.replace(/\\/g, '/').split('/').filter(Boolean).pop()})` : '';
    return `[${this.instanceName}] ${sessionName}${dir}`;
  }

  /**
   * Persist a topicId update for a session.
   *
   * SessionManager.getSession() returns the live Map reference, so mutating
   * topicId on it updates the in-memory store. We then call saveSessions()
   * directly to flush to disk without needing a dedicated SessionManager method.
   */
  private updateSessionTopicId(sessionId: string, topicId: number | undefined): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;
    session.topicId = topicId;
    saveSessions(this.sessionManager.getAllSessions());
  }

  private orphanRegistryRecords(): TelegramTopicRecord[] {
    const liveTopicIds = new Set(
      this.sessionManager
        .getAllSessions()
        .map(session => session.topicId)
        .filter((topicId): topicId is number => topicId != null),
    );
    return this.topicRegistry
      .list()
      .filter(record => !liveTopicIds.has(record.topicId));
  }
}
