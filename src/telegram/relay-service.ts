/**
 * TelegramRelayService — Simple message broker between CLIs and Telegram topics.
 *
 * CLIs send via MCP → topic. Any user reply in a topic is PTY-injected.
 * No tracking tokens, no pending replies, no output modes.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger.js';
import type { TelegramBotCore } from './bot.js';
import type { TopicManager } from './topic-manager.js';
import type { SessionManager } from '../session/manager.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { ConfigLoader } from '../config/loader.js';
import type { HelmControlService } from '../mcp/helm-control-service.js';
import { deliverPromptSequenceToSession } from '../session/sequence-delivery.js';
import type { DeliveryVerificationResult } from '../session/delivery-verification.js';
import {
  buildLargeTextTempFileNotice,
  shouldSendLargeTextAsTempFile,
  writeLargeTextTempFile,
} from '../session/large-text-temp-file.js';
import { formatAgentMessageForTelegram } from './utils.js';
import { OpenWhisprTranscriber, type AudioTranscriber, type AudioTranscriptionResult } from './openwhispr-transcriber.js';
import { resolveFfmpegPath } from './ffmpeg.js';
import { buildFrameSeekHint, extractVideoFrames } from './video-frames.js';
import type { SessionInfo } from '../types/session.js';
import { TELEGRAM_CHAT_PROVIDER } from '../session/chat/chat-bindings.js';
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type {
  TelegramBridge,
  TelegramChannel,
  TelegramChannelCreateInput,
  TelegramSendToUserInput,
  TelegramSendToUserResult,
} from '../types/telegram-channel.js';

/** Telegram's max upload size is 50MB. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Telegram's getFile ceiling for bots — inbound downloads, not our uploads. */
const BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    // Videos
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export class TelegramRelayService extends EventEmitter implements TelegramBridge, ChatBridge {
  /** Telegram's key in the ChatBroker registry and in `chatBindings`. */
  readonly provider = TELEGRAM_CHAT_PROVIDER;

  private channels = new Map<string, TelegramChannel>();

  constructor(
    private telegramBot: TelegramBotCore,
    private topicManager: TopicManager,
    private sessionManager: SessionManager,
    private ptyManager: PtyManager,
    private configLoader: ConfigLoader,
    private helmControl: HelmControlService,
    private audioTranscriber?: AudioTranscriber,
  ) {
    super();
  }

  isRunning(): boolean {
    return this.telegramBot.isRunning();
  }

  isAvailable(): boolean {
    return this.telegramBot.isRunning();
  }

  listChannels(): TelegramChannel[] {
    return [...this.channels.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionName.localeCompare(b.sessionName));
  }

  async createChannel(input: TelegramChannelCreateInput): Promise<TelegramChannel> {
    const session = this.sessionManager.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const existing = [...this.channels.values()].find((channel) => (
      channel.sessionId === session.id && channel.status === 'open'
    ));
    if (existing) return existing;

    const topicId = await this.topicManager.ensureTopic(session);
    const now = Date.now();
    const channel: TelegramChannel = {
      id: randomUUID(),
      sessionId: session.id,
      sessionName: session.name,
      ...(topicId != null ? { topicId } : {}),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.channels.set(channel.id, channel);
    this.emit('channel:created', channel);
    return channel;
  }

  closeChannel(channelId: string): TelegramChannel | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;
    const closed: TelegramChannel = {
      ...channel,
      status: 'closed',
      updatedAt: Date.now(),
    };
    this.channels.set(channelId, closed);
    this.emit('channel:closed', closed);
    return closed;
  }

  async sendToUser(input: TelegramSendToUserInput): Promise<TelegramSendToUserResult> {
    if (!this.telegramBot.isRunning()) {
      return { sent: false, reason: 'Telegram bot is not running' };
    }

    const session = input.sessionId
      ? this.sessionManager.getSession(input.sessionId)
      : undefined;
    const channel = input.channelId
      ? this.requireOpenChannel(input.channelId)
      : session
        ? await this.createChannel({ sessionId: session.id })
        : undefined;

    if (!channel) {
      return { sent: false, reason: 'No session or channel specified' };
    }

    if (channel.topicId == null) {
      return { sent: false, reason: 'Telegram topic could not be created for session' };
    }

    const chatId = this.telegramBot.getChatId();
    if (!chatId) {
      return { sent: false, reason: 'Telegram chat not configured' };
    }

    let messageId: number | undefined;

    if (input.filePath) {
      const attachmentResult = await this.sendFileAttachment(input.filePath, channel.topicId, input.text, input.asVoice);
      if (!attachmentResult.sent) return attachmentResult;
      messageId = attachmentResult.documentId;
    } else {
      const text = formatAgentMessageForTelegram(input.text);
      const message = await this.telegramBot.sendToTopic(channel.topicId, text, {
        parse_mode: 'HTML',
        reply_markup: input.keyboard ? { inline_keyboard: input.keyboard } : undefined,
      });
      if (message) messageId = message.message_id;
    }

    if (!messageId) {
      return { sent: false, reason: 'Failed to send message' };
    }

    const updated: TelegramChannel = {
      ...channel,
      lastMessageAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.channels.set(updated.id, updated);
    this.emit('message:sent_to_user', { channel: updated, messageId });
    return { sent: true, channel: updated, messageId };
  }

  /**
   * The generic ChatBridge send. Telegram's own richer entry point (keyboards,
   * explicit channel ids) stays `sendToUser`; this is the transport-agnostic
   * subset the broker fans out, delegating rather than duplicating it.
   *
   * Inbound is NOT surfaced through the broker: Telegram already resolves its
   * own topic → session mapping and injects into the PTY itself, and routing it
   * twice would deliver the user's message twice.
   */
  async sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    const { sent, reason } = await this.sendToUser({
      sessionId: message.sessionId,
      text: message.text,
      ...(message.filePath ? { filePath: message.filePath } : {}),
      ...(message.asVoice ? { asVoice: true } : {}),
    });
    return { sent, ...(reason ? { reason } : {}) };
  }

  async handleIncomingTelegramMessage(msg: TelegramBot.Message): Promise<boolean> {
    if (msg.text && msg.text.startsWith('/')) return false;

    // Handle attachment messages (photo, document, video, voice)
    if (!msg.text) {
      return this.handleIncomingAttachment(msg);
    }
    const topicId = msg.message_thread_id;
    if (!topicId) return false;

    const from = msg.from?.username ? `@${msg.from.username}` : 'unknown';
    const chatId = msg.chat.id;

    const msgContext = { chatId, messageId: msg.message_id };

    // Find session by topic mapping. A topic that maps to no session is stale
    // (its session was closed) — reject rather than misrouting to the active
    // session, which would inject the message into an unrelated CLI.
    const session = this.topicManager.findSessionByTopicId(topicId);
    if (!session) {
      await this.notifyStaleTopic(topicId);
      logger.warn(`[TelegramRelay] Stale topic ${topicId} — no mapped session; message not delivered`);
      return true;
    }

    const wrapped = wrapTelegramEnvelope(this.resolveTelegramTextPayload(session, msg.text), from, chatId);
    // Set channel affinity and inject first-contact instructions
    let text = wrapped;
    if (session.interactionChannel !== 'telegram') {
      this.sessionManager.updateSession(session.id, { interactionChannel: 'telegram' });
      text = TELEGRAM_MODE_INSTRUCTIONS + '\n\n' + wrapped;
    }
    await deliverPromptSequenceToSession({
      sessionId: session.id,
      text,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      verifyDelivery: {
        label: 'telegram message',
        delayMs: 4000,
        retrySubmit: true,
        background: true,
        onComplete: (result) => void this.handleDeliveryVerification(session.id, topicId, result, msgContext),
      },
    });
    logger.info(`[TelegramRelay] Injected user message to session ${session.id}`);
    return true;
  }

  /**
   * Notify the user in a stale forum topic that their message was not delivered.
   * A stale topic is one that still exists in Telegram but no longer maps to a
   * live hub session, so there is nowhere to route the message.
   */
  private async notifyStaleTopic(topicId: number): Promise<void> {
    if (!this.telegramBot.isRunning()) return;
    await this.telegramBot.sendToTopic(
      topicId,
      '⚠️ This session no longer exists. Your message was not delivered.',
    );
  }

  private resolveTelegramTextPayload(session: SessionInfo, text: string): string {
    const cliEntry = this.configLoader.getCliTypeEntry(session.cliType);
    if (!shouldSendLargeTextAsTempFile(cliEntry?.largeTextAsTempFile, text)) {
      return text;
    }
    const tempPath = writeLargeTextTempFile(text, 'telegram-message');
    logger.info(`[TelegramRelay] Wrote large Telegram message to temp file for ${session.id}: ${tempPath}`);
    return buildLargeTextTempFileNotice(tempPath, 'Telegram message');
  }

  /**
   * Handle a Telegram message containing an attachment (photo, document, video, voice).
   * Resolves the target session synchronously, then fires download + transcribe + deliver
   * in a background task so the Telegram polling loop is not blocked by IO.
   */
  async handleIncomingAttachment(msg: TelegramBot.Message): Promise<boolean> {
    const attachment = extractAttachmentInfo(msg);
    if (!attachment) {
      // A media message we cannot classify used to vanish without a trace,
      // leaving the user waiting on a reply that would never come. Log loudly.
      logger.error(`[TelegramRelay] Unrecognized non-text message ${msg.message_id}; keys: ${describeMessageKeys(msg)}`);
      return false;
    }

    // Resolve target session before any IO so we can reject early without downloading.
    const topicId = msg.message_thread_id;
    const session = topicId ? this.topicManager.findSessionByTopicId(topicId) : undefined;
    // A topic that maps to no session is stale — reject rather than misrouting the
    // attachment to the active (unrelated) session.
    if (topicId && !session) {
      await this.notifyStaleTopic(topicId);
      logger.warn(`[TelegramRelay] Stale topic ${topicId} — no mapped session; attachment not delivered`);
      return true;
    }
    const targetSession = session ?? this.sessionManager.getActiveSession();
    if (!targetSession) return false;

    const destDir = path.join(process.env.APPDATA || process.env.HOME || '.', 'Helm', 'tmp', 'telegram-attachments');
    const from = msg.from?.username ? `@${msg.from.username}` : 'unknown';
    const chatId = msg.chat.id;
    const caption = attachment.caption || '';
    const fileSize = attachment.fileSize ?? 0;

    // Fire download + transcribe + deliver in the background.
    void (async () => {
      const filePath = await this.telegramBot.downloadFile(attachment.fileId, destDir, attachment.fileName);
      if (!this.isValidDownloadedFile(filePath)) {
        logger.error(`[TelegramRelay] Failed to download attachment: ${attachment.fileId}; path=${filePath ?? 'null'}`);
        await this.notifyDownloadFailure(topicId, attachment.type, fileSize);
        return;
      }

      const transcription = await this.transcribeAttachmentIfAudio(attachment.type, filePath, attachment.mimeType);
      const video = await this.extractFramesIfVideo(attachment.mimeType, filePath, attachment.durationSec);

      const envelope = [
        `[HELM_TELEGRAM_ATTACHMENT${from === 'unknown' ? '' : ` from:${from}`} chat:${chatId}]`,
        `type: ${attachment.type}`,
        `file_name: ${attachment.fileName}`,
        `file_path: ${filePath}`,
        `file_size: ${fileSize}`,
        `mime_type: ${attachment.mimeType}`,
        ...(attachment.durationSec ? [`duration: ${attachment.durationSec}s`] : []),
        ...(video.framePaths.length > 0 ? [
          `frame_paths: ${video.framePaths.join(', ')}`,
          `Read the frames above to see the video.`,
          ...(video.seekHint ? [`For any other moment, run: ${video.seekHint}`] : []),
        ] : []),
        ...(transcription ? [
          `transcription_path: ${transcription.transcriptPath}`,
          `transcription_text: ${oneLine(transcription.text)}`,
        ] : []),
        ...(caption ? [`caption: ${caption}`] : []),
        `[/HELM_TELEGRAM_ATTACHMENT]`,
        `Respond via telegram_chat MCP tool.`,
      ].join('\n');

      let text = envelope;
      if (targetSession.interactionChannel !== 'telegram') {
        this.sessionManager.updateSession(targetSession.id, { interactionChannel: 'telegram' });
        text = TELEGRAM_MODE_INSTRUCTIONS + '\n\n' + envelope;
      }

      await deliverPromptSequenceToSession({
        sessionId: targetSession.id,
        text,
        ptyManager: this.ptyManager,
        sessionManager: this.sessionManager,
        configLoader: this.configLoader,
        verifyDelivery: {
          label: 'telegram attachment',
          delayMs: 4000,
          retrySubmit: true,
          background: true,
          onComplete: (result) => void this.handleDeliveryVerification(targetSession.id, topicId, result, { chatId, messageId: msg.message_id }),
        },
      });
      logger.info(`[TelegramRelay] Injected attachment (${attachment.type}) to session ${targetSession.id}: ${filePath}`);
    })().catch((err) => {
      logger.warn(`[TelegramRelay] Attachment processing error for ${targetSession.id}: ${err}`);
    });

    return true;
  }

  /**
   * Handle a Telegram message_reaction event.
   * Delivers a reaction envelope to the active CLI session.
   */
  async handleReaction(reaction: any): Promise<boolean> {
    const active = this.sessionManager.getActiveSession();
    if (!active) return false;

    const from = reaction.user?.username ? `@${reaction.user.username}` : 'unknown';
    // Only `type: 'emoji'` entries carry an `emoji` field — custom_emoji and paid
    // reactions do not, and mapping over them leaves empty slots in the list.
    const emojisOf = (list: TelegramBot.ReactionType[] | undefined): string =>
      (list ?? [])
        .filter((r): r is TelegramBot.ReactionTypeEmoji => r.type === 'emoji')
        .map((r) => r.emoji)
        .join(', ');
    const newEmojis = emojisOf(reaction.new_reaction) || 'none';
    const oldEmojis = emojisOf(reaction.old_reaction);

    const envelope = [
      `[HELM_TELEGRAM_REACTION${from === 'unknown' ? '' : ` from:${from}`} chat:${reaction.chat?.id}]`,
      `type: emoji`,
      `emoji: ${newEmojis}`,
      `message_id: ${reaction.message_id}`,
      ...(oldEmojis ? [`(removed: ${oldEmojis})`] : []),
      `[/HELM_TELEGRAM_REACTION]`,
    ].join('\n');

    const verification = await deliverPromptSequenceToSession({
      sessionId: active.id,
      text: envelope,
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      verifyDelivery: {
        label: 'telegram reaction',
        delayMs: 4000,
        retrySubmit: true,
      },
    });
    await this.handleDeliveryVerification(active.id, active.topicId, verification);

    logger.info(`[TelegramRelay] Injected reaction (${newEmojis}) to session ${active.id}`);
    return true;
  }

  private async sendFileAttachment(
    filePath: string,
    topicId?: number,
    caption?: string,
    asVoice?: boolean,
  ): Promise<TelegramSendToUserResult> {
    if (!path.isAbsolute(filePath)) {
      return { sent: false, reason: 'File path must be absolute' };
    }

    if (!fs.existsSync(filePath)) {
      return { sent: false, reason: `File not found: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { sent: false, reason: `Not a file: ${filePath}` };
    }

    if (stats.size > MAX_ATTACHMENT_BYTES) {
      const mb = (stats.size / (1024 * 1024)).toFixed(1);
      return { sent: false, reason: `Attachment too large (${mb}MB). Telegram limit is 50MB.` };
    }

    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mime = detectMimeType(filePath);
    const captionHtml = caption ? formatAgentMessageForTelegram(caption) : undefined;
    const opts = { caption: captionHtml, topicId };

    let message: Awaited<ReturnType<typeof this.telegramBot.sendDocument>> | null = null;

    if (asVoice && mime === 'audio/ogg') {
      message = await this.telegramBot.sendVoice(buffer, opts);
    } else if (mime.startsWith('image/')) {
      message = await this.telegramBot.sendPhoto(buffer, opts);
    } else if (mime.startsWith('video/')) {
      message = await this.telegramBot.sendVideo(buffer, opts);
    } else {
      message = await this.telegramBot.sendDocument(buffer, fileName, opts);
    }

    if (!message) {
      return { sent: false, reason: 'Failed to send attachment via Telegram API' };
    }

    return { sent: true, documentId: message.message_id };
  }

  private requireOpenChannel(channelId: string): TelegramChannel {
    const channel = this.channels.get(channelId);
    if (!channel || channel.status !== 'open') {
      throw new Error(`Open Telegram channel not found: ${channelId}`);
    }
    return channel;
  }

  private isValidDownloadedFile(filePath: string | null): filePath is string {
    if (!filePath || filePath.trim().length === 0) return false;
    if (!path.isAbsolute(filePath)) return false;
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Give the agent eyes: a contact sheet plus the command to seek any other
   * moment itself. Failure is non-fatal — the attachment still gets delivered.
   */
  private async extractFramesIfVideo(
    mimeType: string,
    filePath: string,
    durationSec?: number,
  ): Promise<{ framePaths: string[]; seekHint?: string }> {
    if (!isVideoAttachment(mimeType)) return { framePaths: [] };

    try {
      const config = this.configLoader.getTelegramConfig();
      const ffmpegPath = resolveFfmpegPath({
        ffmpegPath: config.ffmpegPath,
        openWhisprPath: config.openWhisprPath,
      });
      if (!ffmpegPath) {
        logger.warn('[TelegramRelay] Video frames skipped: no ffmpeg configured (Settings → Telegram → ffmpegPath)');
        return { framePaths: [] };
      }

      const framePaths = await extractVideoFrames({ videoPath: filePath, ffmpegPath, durationSec });
      if (framePaths.length === 0) return { framePaths: [] };
      return { framePaths, seekHint: buildFrameSeekHint(ffmpegPath, filePath) };
    } catch (err) {
      logger.warn(`[TelegramRelay] Video frame extraction failed: ${err}`);
      return { framePaths: [] };
    }
  }

  /** Tell the user their media never made it, instead of leaving them waiting. */
  private async notifyDownloadFailure(topicId: number | undefined, type: string, fileSize: number): Promise<void> {
    if (!topicId || !this.telegramBot.isRunning()) return;
    // Telegram's getFile refuses anything over 20MB for bots — by far the most
    // common reason a phone video fails, so name it rather than saying "error".
    const overBotLimit = fileSize > BOT_DOWNLOAD_LIMIT_BYTES;
    const reason = overBotLimit
      ? `it is ${(fileSize / 1024 / 1024).toFixed(1)}MB and Telegram caps bot downloads at 20MB — send a shorter or lower-quality clip`
      : 'the download failed';
    await this.telegramBot.sendToTopic(topicId, `❌ Could not fetch that ${type}: ${reason}.`);
  }

  private async transcribeAttachmentIfAudio(
    attachmentType: string,
    filePath: string,
    mimeType: string,
  ): Promise<AudioTranscriptionResult | null> {
    if (!shouldTranscribe(attachmentType, mimeType)) return null;

    try {
      const transcriber = this.audioTranscriber ?? this.createConfiguredTranscriber();
      if (!transcriber) return null;
      return await transcriber.transcribe(filePath, mimeType);
    } catch (err) {
      logger.warn(`[TelegramRelay] Audio transcription failed: ${err}`);
      return null;
    }
  }

  private createConfiguredTranscriber(): AudioTranscriber | null {
    const config = this.configLoader.getTelegramConfig();
    if (!config.openWhisprPath) {
      logger.warn('[TelegramRelay] Audio transcription skipped: openWhisprPath is not configured');
      return null;
    }
    return new OpenWhisprTranscriber({
      openWhisprPath: config.openWhisprPath,
      modelPath: config.openWhisprModelPath,
      ffmpegPath: config.ffmpegPath,
    });
  }

  private async handleDeliveryVerification(
    sessionId: string,
    _topicId: number | undefined,
    verification: DeliveryVerificationResult | undefined,
    msgContext?: { chatId: number; messageId: number },
  ): Promise<void> {
    if (!verification) return;

    logger.debug(`[TelegramRelay] Delivery verification for ${sessionId}: ${verification.status} (${verification.detail})`);

    if (!msgContext || !this.telegramBot.isRunning()) return;

    const emoji = reactionForStatus(verification.status);
    if (!emoji) return;

    void this.telegramBot.setMessageReaction(msgContext.chatId, msgContext.messageId, emoji);
  }
}

/**
 * Map delivery verification status to a Telegram reaction emoji.
 *   confirmed       → 👀  (CLI received and moved past the message)
 *   no_signal       → ❌  (PTY produced no output after delivery; likely never received)
 *   suspected_stuck → ❓  (CLI received but hasn't moved past — possibly stuck)
 *   unverifiable    → ❓  (couldn't determine — terminal tail unavailable or empty payload)
 * Returns null for statuses that should stay silent.
 */
function reactionForStatus(status: DeliveryVerificationResult['status']): string | null {
  switch (status) {
    case 'confirmed':
    case 'retry_confirmed':
      return '👀';
    case 'no_signal':
    case 'retry_failed':
      return '❌';
    case 'suspected_stuck':
    case 'unverifiable':
      return '❓';
    default:
      return null;
  }
}

/**
 * Video carries speech just as often as a voice note does, and the transcriber
 * already runs everything through ffmpeg — so the audio track of a video is
 * transcribed on the same path.
 */
function shouldTranscribe(attachmentType: string, mimeType: string): boolean {
  if (attachmentType === 'voice') return true;
  const mime = mimeType.toLowerCase();
  return mime.startsWith('audio/') || mime.startsWith('video/');
}

function isVideoAttachment(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('video/');
}

/**
 * Name the payload-bearing fields of a message so an unhandled media type can
 * be identified from the log alone, without echoing user content.
 */
function describeMessageKeys(msg: TelegramBot.Message): string {
  const skipped = new Set(['message_id', 'from', 'chat', 'date', 'message_thread_id']);
  const keys = Object.keys(msg).filter(key => !skipped.has(key));
  return keys.length > 0 ? keys.join(', ') : '(none)';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract attachment metadata from a Telegram message.
 * Returns null if the message has no recognizable attachment.
 */
function extractAttachmentInfo(msg: TelegramBot.Message): {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  caption?: string;
  type: string;
  durationSec?: number;
} | null {
  // Photo: array of sizes, pick the largest (last element)
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileName: `photo_${msg.message_id}.jpg`,
      mimeType: 'image/jpeg',
      fileSize: largest.file_size,
      caption: msg.caption,
      type: 'photo',
    };
  }

  // Document
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileName: msg.document.file_name || `document_${msg.message_id}`,
      mimeType: msg.document.mime_type || 'application/octet-stream',
      fileSize: msg.document.file_size,
      caption: msg.caption,
      type: 'document',
    };
  }

  // Video
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      fileName: (msg.video as { file_name?: string } & typeof msg.video).file_name || `video_${msg.message_id}.mp4`,
      mimeType: msg.video.mime_type || 'video/mp4',
      fileSize: msg.video.file_size,
      caption: msg.caption,
      type: 'video',
    };
  }

  // Voice message
  if (msg.voice) {
    return {
      fileId: msg.voice.file_id,
      fileName: `voice_${msg.message_id}.ogg`,
      mimeType: msg.voice.mime_type || 'audio/ogg',
      fileSize: msg.voice.file_size,
      caption: undefined,
      type: 'voice',
      durationSec: msg.voice.duration,
    };
  }

  // Video note — the round record-in-place bubble. Always mp4, never named.
  if (msg.video_note) {
    return {
      fileId: msg.video_note.file_id,
      fileName: `video_note_${msg.message_id}.mp4`,
      mimeType: 'video/mp4',
      fileSize: msg.video_note.file_size,
      caption: undefined,
      type: 'video_note',
      durationSec: msg.video_note.duration,
    };
  }

  // Animation — a GIF, which Telegram stores as a silent mp4.
  if (msg.animation) {
    return {
      fileId: msg.animation.file_id,
      fileName: msg.animation.file_name || `animation_${msg.message_id}.mp4`,
      mimeType: msg.animation.mime_type || 'video/mp4',
      fileSize: msg.animation.file_size,
      caption: msg.caption,
      type: 'animation',
      durationSec: msg.animation.duration,
    };
  }

  // Music / shared audio file, as opposed to a recorded voice note.
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name || `audio_${msg.message_id}.mp3`,
      mimeType: msg.audio.mime_type || 'audio/mpeg',
      fileSize: msg.audio.file_size,
      caption: msg.caption,
      type: 'audio',
      durationSec: msg.audio.duration,
    };
  }

  return null;
}

function wrapTelegramEnvelope(text: string, from: string, chatId: number): string {
  const fromTag = from === 'unknown' ? '' : ` from:${from}`;
  return `[HELM_TELEGRAM${fromTag} chat:${chatId}]\n${text}\n[/HELM_TELEGRAM]\nRespond via telegram_chat MCP tool.`;
}

const TELEGRAM_MODE_INSTRUCTIONS =
  '[HELM_TELEGRAM_MODE]\n' +
  'This session is now in Telegram mode. The user is interacting via Telegram and CANNOT see the terminal.\n' +
  'ALL responses MUST go through the telegram_chat MCP tool.\n' +
  'ALL questions and confirmations MUST go through telegram_chat — do NOT use AskUserQuestion.\n' +
  'The user will return to their desk when they type in the terminal, which automatically exits Telegram mode.\n' +
  '[/HELM_TELEGRAM_MODE]';

