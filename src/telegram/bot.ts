import TelegramBot from 'node-telegram-bot-api';
// The default import binds only the class, so a separate type-only namespace
// import is needed to reach the library's exported types. Both names refer to
// the same module; TelegramBot stays the value (`new TelegramBot(...)`).
import type * as TG from 'node-telegram-bot-api';

import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

// v1.x renamed the per-method option bags from `Send*Options` to `Send*Params`
// and folded the positional arguments into them. These aliases name just the
// "form" half — what each send*/edit* method actually accepts — so the call
// sites stay readable and the rename lives in exactly one place.
type SendMessageOptions = Omit<TG.SendMessageParams, 'chat_id' | 'text'>;
type SendDocumentOptions = Omit<TG.SendDocumentParams, 'chat_id' | 'document'>;
type SendVoiceOptions = Omit<TG.SendVoiceParams, 'chat_id' | 'voice'>;
type SendPhotoOptions = Omit<TG.SendPhotoParams, 'chat_id' | 'photo'>;
type SendVideoOptions = Omit<TG.SendVideoParams, 'chat_id' | 'video'>;
type EditMessageTextOptions = Omit<TG.EditMessageTextParams, 'text'>;

/**
 * Forum topic returned by the Telegram Bot API.
 * Not present in @types/node-telegram-bot-api — defined locally.
 */
interface ForumTopic {
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

/**
 * A Telegram message_reaction event.
 *
 * `old_reaction`/`new_reaction` are `ReactionType[]`, NOT emoji-only: Telegram
 * also sends `custom_emoji` and `paid` entries, which carry no `emoji` field.
 * Consumers must narrow on `type === 'emoji'` before reading it.
 */
type MessageReaction = TG.MessageReactionUpdated;

/**
 * Queued message edit to prevent hitting Telegram rate limits.
 * Only the latest edit per (chatId, messageId) is kept.
 */
interface PendingEdit {
  chatId: number;
  messageId: number;
  text: string;
  options?: EditMessageTextOptions;
  resolveList: Array<(msg: TG.Message | boolean) => void>;
  rejectList: Array<(err: Error) => void>;
}

/** Minimum interval between edits to the same message (ms). */
const EDIT_DEBOUNCE_MS = 1500;

/** Fail-fast timeout for all Telegram Bot API calls (ms). */
const API_TIMEOUT_MS = 10_000;

/** Maximum edits per topic per minute. */
const MAX_EDITS_PER_MIN = 20;

/** Maximum incoming messages per user per minute before rate limiting. */
const MAX_RECV_PER_MIN = 30;

/**
 * Core Telegram bot wrapper.
 *
 * Responsibilities:
 * - Bot lifecycle (start/stop long-polling)
 * - User-ID whitelist authentication
 * - Callback query routing (emits events)
 * - Message edit queue with debounce and rate limiting
 *
 * Events:
 * - 'callback_query' (query: TG.CallbackQuery) — authenticated callback
 * - 'message' (msg: TG.Message) — authenticated non-command message
 * - 'command:{name}' (msg: TG.Message, args: string) — slash command
 */
export class TelegramBotCore extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: number | null = null;
  private allowedUserIds: Set<number> = new Set();
  private running = false;

  // Edit queue: key = `chatId:messageId`, coalesces rapid edits
  private pendingEdits: Map<string, PendingEdit> = new Map();
  private editTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Rate tracking: key = topicId (message_thread_id), value = timestamps of recent edits
  private editRateLog: Map<number, number[]> = new Map();
  // Inbound rate tracking: key = userId, value = timestamps of recent messages
  private recvRateLog: Map<number, number[]> = new Map();

  /** Start the bot with the given token and config. */
  start(token: string, chatId: number, allowedUserIds: number[]): void {
    if (!allowedUserIds || allowedUserIds.length === 0) {
      throw new Error('allowedUserIds must not be empty — at least one authorized user is required');
    }

    if (this.running) {
      logger.warn('[Telegram] Bot already running, stopping first');
      this.stop();
    }

    this.chatId = chatId;
    this.allowedUserIds = new Set(allowedUserIds);

    try {
      this.bot = new TelegramBot(token, { polling: true });
      this.running = true;
      logger.info('[Telegram] Bot started with long-polling');

      this.bot.on('message', (msg) => this.handleMessage(msg));
      this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));
      this.bot.on('message_reaction', (reaction) => this.handleMessageReaction(reaction));
      this.bot.on('polling_error', (err) => {
        logger.error(`[Telegram] Polling error: ${err.message}`);
      });
    } catch (err) {
      logger.error(`[Telegram] Failed to start bot: ${err}`);
      this.running = false;
      throw err;
    }
  }

  /** Stop the bot and flush pending edits. */
  stop(): void {
    if (!this.running || !this.bot) return;

    // Clear all pending edit timers
    for (const timer of this.editTimers.values()) clearTimeout(timer);
    this.editTimers.clear();
    this.pendingEdits.clear();
    this.editRateLog.clear();
    this.recvRateLog.clear();

    this.bot.stopPolling();
    this.bot = null;
    this.running = false;
    logger.info('[Telegram] Bot stopped');
  }

  /** Check if the bot is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the underlying TelegramBot instance (for direct API calls). */
  getBot(): TelegramBot | null {
    return this.bot;
  }

  /** Get the configured chat ID. */
  getChatId(): number | null {
    return this.chatId;
  }

  // ==========================================================================
  // Sending messages
  // ==========================================================================

  /** Send a message to the configured chat, optionally in a specific topic. */
  async sendMessage(
    text: string,
    options?: SendMessageOptions,
  ): Promise<TG.Message | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      return await this.withTimeout(this.bot.sendMessage(this.chatId, text, options), 'sendMessage');
    } catch (err) {
      logger.error(`[Telegram] sendMessage failed: ${err}`);
      return null;
    }
  }

  /** Send a message to a specific forum topic. */
  async sendToTopic(
    topicId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TG.Message | null> {
    return this.sendMessage(text, {
      ...options,
      message_thread_id: topicId,
    });
  }

  /** Send a document (PDF, text, etc.) to the configured chat or a specific topic. */
  async sendDocument(
    buffer: Buffer,
    filename: string,
    options?: { caption?: string; topicId?: number },
  ): Promise<TG.Message | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      const sendOptions: SendDocumentOptions = {
        caption: options?.caption,
      };
      if (options?.topicId != null) {
        sendOptions.message_thread_id = options.topicId;
      }
      return await this.withTimeout(
        this.bot.sendDocument(this.chatId, Readable.from(buffer), sendOptions, { filename }),
        'sendDocument',
      );
    } catch (err) {
      logger.error(`[Telegram] sendDocument failed: ${err}`);
      return null;
    }
  }

  /** Send an OGG/Opus buffer as a native Telegram voice message. */
  async sendVoice(
    buffer: Buffer,
    options?: { caption?: string; topicId?: number },
  ): Promise<TG.Message | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      const sendOptions: SendVoiceOptions = { caption: options?.caption };
      if (options?.topicId != null) {
        sendOptions.message_thread_id = options.topicId;
      }
      return await this.withTimeout(
        this.bot.sendVoice(this.chatId, Readable.from(buffer), sendOptions),
        'sendVoice',
      );
    } catch (err) {
      logger.error(`[Telegram] sendVoice failed: ${err}`);
      return null;
    }
  }

  /** Send a photo to the configured chat or a specific topic. */
  async sendPhoto(
    buffer: Buffer,
    options?: { caption?: string; topicId?: number },
  ): Promise<TG.Message | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      const sendOptions: SendPhotoOptions = { caption: options?.caption };
      if (options?.topicId != null) {
        sendOptions.message_thread_id = options.topicId;
      }
      return await this.withTimeout(
        this.bot.sendPhoto(this.chatId, buffer, sendOptions),
        'sendPhoto',
      );
    } catch (err) {
      logger.error(`[Telegram] sendPhoto failed: ${err}`);
      return null;
    }
  }

  /** Send a video to the configured chat or a specific topic. */
  async sendVideo(
    buffer: Buffer,
    options?: { caption?: string; topicId?: number },
  ): Promise<TG.Message | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      const sendOptions: SendVideoOptions = { caption: options?.caption };
      if (options?.topicId != null) {
        sendOptions.message_thread_id = options.topicId;
      }
      return await this.withTimeout(
        this.bot.sendVideo(this.chatId, buffer, sendOptions),
        'sendVideo',
      );
    } catch (err) {
      logger.error(`[Telegram] sendVideo failed: ${err}`);
      return null;
    }
  }

  /**
   * Download a file from Telegram to disk.
   * Creates the destination directory if it does not exist.
   * Returns the local file path on success, null on failure.
   */
  async downloadFile(fileId: string, destDir: string, preferredFileName?: string): Promise<string | null> {
    if (!this.bot || !fileId.trim()) return null;
    try {
      const absoluteDestDir = path.resolve(destDir);
      mkdirSync(absoluteDestDir, { recursive: true });

      const link = await this.withTimeout(this.bot.getFileLink(fileId), 'getFileLink');
      const response = await this.withTimeout(fetch(link), 'downloadFile');
      if (!response.ok) {
        logger.error(`[Telegram] downloadFile failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        logger.error('[Telegram] downloadFile failed: empty response body');
        return null;
      }

      const fileName = this.resolveDownloadFileName(fileId, link, preferredFileName);
      const filePath = path.resolve(absoluteDestDir, fileName);
      if (!this.isPathInsideDirectory(filePath, absoluteDestDir)) {
        logger.error(`[Telegram] downloadFile failed: resolved path escaped destination: ${filePath}`);
        return null;
      }

      writeFileSync(filePath, buffer);
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        logger.error(`[Telegram] downloadFile failed: file missing after write: ${filePath}`);
        return null;
      }

      logger.info(`[Telegram] Downloaded file ${fileId} to ${filePath}`);
      return filePath;
    } catch (err) {
      logger.error(`[Telegram] downloadFile failed: ${err}`);
      return null;
    }
  }

  /**
   * Edit a message with debounce + rate limiting.
   * Rapid edits to the same message are coalesced — only the latest text is sent.
   */
  editMessageDebounced(
    chatId: number,
    messageId: number,
    text: string,
    options?: EditMessageTextOptions,
    topicId?: number,
  ): Promise<TG.Message | boolean> {
    const key = `${chatId}:${messageId}`;

    return new Promise((resolve, reject) => {
      const existing = this.pendingEdits.get(key);
      if (existing) {
        // Coalesce: update text, add promise callbacks
        existing.text = text;
        existing.options = options;
        existing.resolveList.push(resolve);
        existing.rejectList.push(reject);
        return;
      }

      const pending: PendingEdit = {
        chatId,
        messageId,
        text,
        options,
        resolveList: [resolve],
        rejectList: [reject],
      };
      this.pendingEdits.set(key, pending);

      const timer = setTimeout(() => {
        this.flushEdit(key, topicId);
      }, EDIT_DEBOUNCE_MS);
      this.editTimers.set(key, timer);
    });
  }

  /** Answer a callback query with a toast message. */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.withTimeout(this.bot.answerCallbackQuery(callbackQueryId, { text }), 'answerCallbackQuery');
    } catch (err) {
      logger.error(`[Telegram] answerCallback failed: ${err}`);
    }
  }

  /** Set an emoji reaction on a message (replaces any existing bot reaction). */
  async setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.withTimeout(
        (this.bot as any).setMessageReaction(chatId, messageId, {
          reaction: [{ type: 'emoji', emoji }],
          is_big: false,
        }),
        'setMessageReaction',
      );
    } catch (err) {
      logger.warn(`[Telegram] setMessageReaction failed (chat=${chatId} msg=${messageId} emoji=${emoji}): ${err}`);
    }
  }

  // ==========================================================================
  // Forum topic management
  // ==========================================================================

  /**
   * Create a forum topic in the configured supergroup.
   * Note: @types/node-telegram-bot-api types createForumTopic as Promise<boolean>,
   * but the actual Telegram API returns a ForumTopic object.
   */
  async createForumTopic(
    name: string,
    iconColor?: number,
  ): Promise<ForumTopic | null> {
    if (!this.bot || !this.chatId) return null;
    try {
      const result = await this.withTimeout(this.bot.createForumTopic(
        this.chatId,
        name,
        { icon_color: iconColor },
      ) as unknown as Promise<ForumTopic>, 'createForumTopic');
      return result;
    } catch (err) {
      logger.error(`[Telegram] createForumTopic failed: ${err}`);
      return null;
    }
  }

  /** Close a forum topic. */
  async closeForumTopic(topicId: number): Promise<boolean> {
    if (!this.bot || !this.chatId) return false;
    try {
      await this.withTimeout(this.bot.closeForumTopic(this.chatId, topicId), 'closeForumTopic');
      return true;
    } catch (err) {
      logger.error(`[Telegram] closeForumTopic failed: ${err}`);
      return false;
    }
  }

  /** Reopen a forum topic. */
  async reopenForumTopic(topicId: number): Promise<boolean> {
    if (!this.bot || !this.chatId) return false;
    try {
      await this.withTimeout(this.bot.reopenForumTopic(this.chatId, topicId), 'reopenForumTopic');
      return true;
    } catch (err) {
      logger.error(`[Telegram] reopenForumTopic failed: ${err}`);
      return false;
    }
  }

  /** Delete a forum topic permanently. */
  async deleteForumTopic(topicId: number): Promise<boolean> {
    if (!this.bot || !this.chatId) return false;
    try {
      await this.withTimeout((this.bot as any).deleteForumTopic(this.chatId, topicId), 'deleteForumTopic');
      return true;
    } catch (err) {
      logger.error(`[Telegram] deleteForumTopic failed: ${err}`);
      return false;
    }
  }

  /** Edit a forum topic name/icon. */
  async editForumTopic(topicId: number, name: string): Promise<boolean> {
    if (!this.bot || !this.chatId) return false;
    try {
      await this.withTimeout(this.bot.editForumTopic(this.chatId, topicId, { name }), 'editForumTopic');
      return true;
    } catch (err) {
      // The topic already has this name: the edit's goal is met.
      if (String(err).includes('TOPIC_NOT_MODIFIED')) return true;
      logger.error(`[Telegram] editForumTopic failed: ${err}`);
      return false;
    }
  }

  // ==========================================================================
  // Private handlers
  // ==========================================================================

  private isAuthorized(userId: number | undefined): boolean {
    if (!userId) return false;
    if (this.allowedUserIds.size === 0) return false;
    return this.allowedUserIds.has(userId);
  }

  /** Race an API promise against a fixed timeout. Rejects with a descriptive error on timeout. */
  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Telegram ${operation} timed out after ${API_TIMEOUT_MS}ms`)), API_TIMEOUT_MS),
      ),
    ]);
  }

  private resolveDownloadFileName(fileId: string, fileLink: string, preferredFileName?: string): string {
    const fromPreferred = this.sanitizeFileName(preferredFileName);
    if (fromPreferred) return fromPreferred;

    try {
      const urlPath = new URL(fileLink).pathname;
      const fromUrl = this.sanitizeFileName(path.basename(urlPath));
      if (fromUrl) return fromUrl;
    } catch {
      // Fall through to fileId-based fallback.
    }

    return `${this.sanitizeFileName(fileId) || 'telegram-file'}.bin`;
  }

  private sanitizeFileName(name?: string): string {
    const base = path.basename((name ?? '').trim());
    return base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/^\.+$/, '')
      .slice(0, 120)
      .trim();
  }

  private isPathInsideDirectory(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /** Check if a user has exceeded the inbound rate limit. */
  private isRateLimited(userId: number): boolean {
    const now = Date.now();
    const timestamps = this.recvRateLog.get(userId) ?? [];
    const recent = timestamps.filter(t => now - t < 60_000);

    if (recent.length >= MAX_RECV_PER_MIN) {
      logger.warn(`[Telegram] Rate limit exceeded for user ${userId}`);
      return true;
    }

    recent.push(now);
    this.recvRateLog.set(userId, recent);
    return false;
  }

  private handleMessage(msg: TG.Message): void {
    if (!this.isAuthorized(msg.from?.id)) {
      const who = msg.from;
      const label = who?.username ? `@${who.username}` : (who?.first_name ?? 'unknown');
      const safeText = (msg.text ?? '<no text>').replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 200);
      logger.warn(`[Telegram] Unauthorized message from user ${who?.id} (${label}): ${safeText}`);
      return;
    }

    if (this.isRateLimited(msg.from!.id)) return;

    // Check for bot commands
    if (msg.text?.startsWith('/')) {
      const parts = msg.text.split(' ');
      const command = parts[0].replace('/', '').replace(/@.*$/, ''); // strip @botname
      const args = parts.slice(1).join(' ');
      this.emit(`command:${command}`, msg, args);
      return;
    }

    this.emit('message', msg);
  }

  private handleCallbackQuery(query: TG.CallbackQuery): void {
    if (!this.isAuthorized(query.from?.id)) {
      logger.warn(`[Telegram] Unauthorized callback from user ${query.from?.id}`);
      return;
    }

    if (this.isRateLimited(query.from!.id)) {
      this.answerCallback(query.id, '⚠️ Rate limited — slow down').catch(() => {});
      return;
    }

    this.emit('callback_query', query);
  }

  private handleMessageReaction(reaction: MessageReaction): void {
    // Telegram sends `user` for a reaction by a user; the anonymous-admin case
    // carries `actor_chat` and no user id, which fails authorization below.
    const userId = reaction.user?.id;
    if (!this.isAuthorized(userId)) {
      logger.warn(`[Telegram] Unauthorized message reaction from user ${userId}`);
      return;
    }

    this.emit('message_reaction', reaction);
  }

  private async flushEdit(key: string, topicId?: number): Promise<void> {
    this.editTimers.delete(key);
    const pending = this.pendingEdits.get(key);
    if (!pending) return;
    this.pendingEdits.delete(key);

    // Rate limit check
    if (topicId != null) {
      const now = Date.now();
      const log = this.editRateLog.get(topicId) ?? [];
      // Remove entries older than 1 minute
      const recent = log.filter(t => now - t < 60_000);
      if (recent.length >= MAX_EDITS_PER_MIN) {
        // Over rate limit — drop this edit
        logger.warn(`[Telegram] Edit rate limit exceeded for topic ${topicId}, dropping edit`);
        for (const resolve of pending.resolveList) resolve(false);
        this.editRateLog.set(topicId, recent);
        return;
      }
      recent.push(now);
      this.editRateLog.set(topicId, recent);
    }

    if (!this.bot) {
      for (const reject of pending.rejectList) reject(new Error('Bot not running'));
      return;
    }

    try {
      const result = await this.withTimeout(this.bot.editMessageText(pending.text, {
        chat_id: pending.chatId,
        message_id: pending.messageId,
        ...pending.options,
      }), 'editMessageText');
      for (const resolve of pending.resolveList) resolve(result);
    } catch (err) {
      logger.error(`[Telegram] editMessageText failed: ${err}`);
      for (const reject of pending.rejectList) reject(err as Error);
    }
  }
}
