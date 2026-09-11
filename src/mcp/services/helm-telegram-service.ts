import * as fs from 'fs';
import * as path from 'path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionInfo } from '../../types/session.js';
import type {
  TelegramBridge,
  TelegramChannel,
  TelegramStatus,
} from '../../types/telegram-channel.js';
import type { ChatBroker } from '../../session/chat/chat-broker.js';
import type { ChatOutboundMessage } from '../../session/chat/chat-bridge.js';
import type { NotificationManager } from '../../session/notification-manager.js';
import type { CapabilityDetector } from '../../session/capability-detector.js';
import { validateMobileFriendlyTelegramText } from '../../telegram/utils.js';
import { PiperTts } from '../../telegram/piper-tts.js';
import { getTempDir } from '../../utils/app-paths.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Telegram messaging and LLM notification routing.
 * Delegates to TelegramBridge for channel operations and NotificationManager for smart routing.
 */
export class HelmTelegramService {
  private telegramBridge: TelegramBridge | null = null;
  private notificationManager: NotificationManager | null = null;
  private chatBroker: ChatBroker | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly sessionManager: SessionManager,
    private readonly capabilityDetector: CapabilityDetector,
  ) {}

  setTelegramBridge(bridge: TelegramBridge | null): void {
    this.telegramBridge = bridge;
  }

  setNotificationManager(nm: NotificationManager): void {
    this.notificationManager = nm;
  }

  /**
   * Wire the fan-out. Once a broker is set, `telegram_chat` and
   * `telegram_send_voice` reach EVERY registered chat surface, not just
   * Telegram. The MCP tool names are unchanged on purpose — a CLI keeps calling
   * what it always called and the extra surfaces appear behind it.
   */
  setChatBroker(broker: ChatBroker | null): void {
    this.chatBroker = broker;
  }

  getTelegramStatus(): TelegramStatus {
    const config = this.configLoader.getTelegramConfig();
    const chatConfigured = typeof config.chatId === 'number';
    const allowedUsersConfigured = Array.isArray(config.allowedUserIds) && config.allowedUserIds.length > 0;
    const configured = Boolean(config.botToken && chatConfigured && allowedUsersConfigured);
    const running = this.telegramBridge?.isRunning() ?? false;
    const caps = this.capabilityDetector.getCapabilities();
    return {
      enabled: config.enabled,
      configured,
      running,
      available: config.enabled && configured && running,
      chatConfigured,
      allowedUsersConfigured,
      openChannels: this.telegramBridge?.listChannels().filter((channel) => channel.status === 'open').length ?? 0,
      guidance: 'Use Telegram only for mobile-friendly urgent blockers or after the user has already engaged through Telegram.',
      capabilities: {
        openwhisper: { available: caps.openwhisper, ...(caps.openwhisperPath ? { path: caps.openwhisperPath } : {}) },
        piper: { available: caps.piper, ...(caps.piperPath ? { path: caps.piperPath } : {}) },
        ffmpeg: { available: caps.ffmpeg, ...(caps.ffmpegPath ? { path: caps.ffmpegPath } : {}) },
      },
    };
  }

  /**
   * Synthesize the given text to an OGG/Opus voice message (piper → ffmpeg) and
   * send it to the caller's own session topic. Helm owns the TTS pipeline; the
   * LLM only supplies text. Returns a reason instead of throwing on the common
   * not-ready cases so callers get actionable feedback.
   */
  async sendTelegramVoice(sessionRef: string, text: string): Promise<{ sent: boolean; reason?: string }> {
    const unreachable = this.noChatSurface();
    if (unreachable) return unreachable;
    const caps = this.capabilityDetector.getCapabilities();
    if (!caps.piper) return { sent: false, reason: 'piper (text-to-speech) is not configured' };
    if (!caps.ffmpeg) return { sent: false, reason: 'ffmpeg (audio conversion) is not configured' };
    if (!text || text.trim() === '') {
      return { sent: false, reason: 'text is empty' };
    }
    const session = this.sessionManager.getSession(sessionRef);
    if (!session) return { sent: false, reason: `Session not found by ID: ${sessionRef}` };

    const config = this.configLoader.getTelegramConfig();
    let oggPath: string;
    try {
      const result = await new PiperTts({
        piperPath: config.piperPath,
        piperVoicePath: config.piperVoicePath,
        ffmpegPath: config.ffmpegPath,
        tmpDir: getTempDir(moduleDir),
      }).synthesize(text);
      oggPath = result.oggPath;
    } catch (err) {
      return { sent: false, reason: err instanceof Error ? err.message : String(err) };
    }

    try {
      return await this.fanOut({ sessionId: session.id, text: '', filePath: oggPath, asVoice: true });
    } finally {
      fs.promises.unlink(oggPath).catch(() => {});
    }
  }

  async closeTelegramChannel(channelId: string): Promise<TelegramChannel> {
    this.requireTelegramBridge();
    const closed = this.telegramBridge!.closeChannel(channelId);
    if (!closed) {
      throw new Error(`Telegram channel not found: ${channelId}`);
    }
    return closed;
  }

  async sendTelegramChat(
    sessionRef: string,
    message: string,
    filePath?: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    const unreachable = this.noChatSurface();
    if (unreachable) return unreachable;
    if (filePath) {
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
      if (stats.size > 50 * 1024 * 1024) {
        const mb = (stats.size / (1024 * 1024)).toFixed(1);
        return { sent: false, reason: `File too large (${mb}MB). Telegram limit is 50MB.` };
      }
      if (message.length > 1024) {
        return { sent: false, reason: 'Message caption with attachment must be 1024 characters or fewer' };
      }
    } else {
      validateMobileFriendlyTelegramText(message);
    }
    // Telegram replies are routed by session ID only — never by name. The dispatcher
    // guarantees sessionRef is the verified caller's UUID (authContext or explicit
    // sessionId). Using getSession (id-only) instead of findSession avoids any
    // name-resolution fallback that could mis-route a reply to the wrong topic.
    const session = this.sessionManager.getSession(sessionRef);
    if (!session) return { sent: false, reason: `Session not found by ID: ${sessionRef}` };
    return this.fanOut({ sessionId: session.id, text: message, ...(filePath ? { filePath } : {}) });
  }

  /**
   * Deliver to every registered chat surface. Fan-out is UNCONDITIONAL: the
   * phone still gets the message when Telegram is down, and Telegram still gets
   * it when the phone is linked — Telegram is the only out-of-BLE-range path, so
   * suppressing it would make "was I told?" depend on link state.
   *
   * The single reported outcome is "did it reach anyone": the caller is an LLM
   * deciding whether to try something else, and a surface-by-surface breakdown
   * is not something it can act on.
   */
  private async fanOut(message: ChatOutboundMessage): Promise<{ sent: boolean; reason?: string }> {
    if (!this.chatBroker) {
      const result = await this.telegramBridge!.sendToUser({
        sessionId: message.sessionId,
        text: message.text,
        filePath: message.filePath,
        asVoice: message.asVoice,
      });
      return { sent: result.sent, ...(result.reason ? { reason: result.reason } : {}) };
    }

    const results = await this.chatBroker.send(message);
    if (results.some(result => result.sent)) return { sent: true };
    const reason = results
      .map(result => `${result.provider}: ${result.reason ?? 'not sent'}`)
      .join('; ');
    return { sent: false, reason: reason || 'No chat surface is registered' };
  }

  /**
   * The one precondition shared by every chat send: SOMETHING can carry it.
   * With a broker wired that means any available surface — a running Telegram
   * bot is no longer required, because a linked phone is a complete channel on
   * its own. Returns the refusal to hand back, or undefined to proceed.
   */
  private noChatSurface(): { sent: boolean; reason: string } | undefined {
    if (this.chatBroker) {
      return this.chatBroker.list().some(bridge => bridge.isAvailable())
        ? undefined
        : { sent: false, reason: 'No chat surface is available (Telegram is not running and no phone is linked)' };
    }
    return this.telegramBridge?.isRunning()
      ? undefined
      : { sent: false, reason: 'Telegram bot is not running' };
  }

  notifyUser(sessionRef: string, title: string, content: string): { delivered: 'toast' | 'bubble' | 'telegram' | 'taskbar_flash' | 'none' } {
    if (!this.notificationManager) {
      throw new Error('Notification manager is not available');
    }
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    return { delivered: this.notificationManager.notifyLlmDirected(session.id, title, content) };
  }

  getAppVisibility(): {
    visibility: 'visible-focused' | 'visible-background' | 'hidden';
    screenLocked: boolean;
    activeSessionId: string | null;
  } {
    if (!this.notificationManager) {
      throw new Error('Notification manager is not available');
    }
    return this.notificationManager.getAppVisibilityDetails();
  }

  private findSession(sessionRef: string): SessionInfo | null {
    const nameMatches = this.sessionManager.getAllSessions().filter((session) => session.name === sessionRef);
    if (nameMatches.length > 1) {
      throw new Error(`Multiple sessions found with name: ${sessionRef}. Use sessionId instead.`);
    }
    if (nameMatches.length === 1) return nameMatches[0];
    return this.sessionManager.getSession(sessionRef);
  }

  private requireTelegramBridge(): void {
    if (!this.telegramBridge) {
      throw new Error('Telegram bridge is not available');
    }
  }
}
