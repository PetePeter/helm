import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramRelayService } from '../src/telegram/relay-service.js';
import * as fs from 'fs';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRelay() {
  const innerBot = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };
  const bot = {
    isRunning: vi.fn(() => true),
    getChatId: vi.fn(() => -1001234567890),
    getBot: vi.fn(() => innerBot),
    sendToTopic: vi.fn().mockResolvedValue({ message_id: 12 }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 13 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 100 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 101 }),
    sendVideo: vi.fn().mockResolvedValue({ message_id: 102 }),
    downloadFile: vi.fn().mockResolvedValue('/tmp/test/photo.jpg'),
    setMessageReaction: vi.fn().mockResolvedValue(undefined),
  };
  const session = { id: 's1', name: 'Claude', cliType: 'claude-code', topicId: 42 };
  const topicManager = {
    ensureTopic: vi.fn(async () => 42),
    findSessionByTopicId: vi.fn((topicId: number) => topicId === 42 ? session : undefined),
  };
  const sessionManager = {
    getSession: vi.fn((id: string) => id === 's1' ? session : null),
    getActiveSession: vi.fn(() => session),
    updateSession: vi.fn(),
  };
  const ptyManager = {
    write: vi.fn(),
    deliverText: vi.fn().mockResolvedValue(undefined),
    nudgeResize: vi.fn().mockResolvedValue(undefined),
  };
  const configLoader = {
    getCliTypeEntry: vi.fn(() => ({ submitSuffix: '\\r' })),
    getTelegramConfig: vi.fn(() => ({ openWhisprPath: '' })),
  };
  const helmControl = {};
  const relay = new TelegramRelayService(
    bot as any,
    topicManager as any,
    sessionManager as any,
    ptyManager as any,
    configLoader as any,
    helmControl as any,
  );
  return { relay, bot, topicManager, sessionManager, ptyManager, configLoader };
}

function tempAttachmentPath(fileName: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'helm-relay-'));
  const filePath = path.join(dir, fileName);
  closeSync(openSync(filePath, 'w'));
  return filePath;
}

describe('TelegramRelayService', () => {
  it('sendToUser() creates topic if none exists and sends message', async () => {
    const { relay, bot, topicManager } = makeRelay();

    const result = await relay.sendToUser({ sessionId: 's1', text: 'Hello from CLI' });

    expect(topicManager.ensureTopic).toHaveBeenCalled();
    expect(bot.sendToTopic).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Hello from CLI'),
      { parse_mode: 'HTML' },
    );
    expect(result.sent).toBe(true);
  });

  it('sendToUser() returns { sent: false, reason } when bot offline', async () => {
    const { relay, bot } = makeRelay();
    bot.isRunning.mockReturnValue(false);

    const result = await relay.sendToUser({ sessionId: 's1', text: 'Hello' });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('Telegram bot is not running');
  });

  it('handleIncomingTelegramMessage() wraps text in HELM_TELEGRAM envelope and delivers via sequence', async () => {
    const { relay, ptyManager } = makeRelay();

    const consumed = await relay.handleIncomingTelegramMessage({
      message_id: 77,
      message_thread_id: 42,
      text: 'Yes, ship it',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    expect(consumed).toBe(true);
    // Now routed through deliverPromptSequenceToSession which uses deliverText for text content
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('[HELM_TELEGRAM from:@testuser'));
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('Respond via telegram_chat MCP tool.'));
  });

  it('keeps the instruction line when the reminder resolves to pty — no hooks, prepend as always', async () => {
    const { relay, ptyManager } = makeRelay();
    relay.setReminderDelivery(async () => ({ channel: 'pty', fellBack: true }));

    await relay.handleIncomingTelegramMessage({
      message_id: 78,
      message_thread_id: 42,
      text: 'Still there?',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    const text = ptyManager.deliverText.mock.calls[0][1] as string;
    expect(text).toContain('Respond via telegram_chat MCP tool.');
  });

  it('drops the instruction line when the reminder resolves to hook — the hook injects the rules itself', async () => {
    const { relay, ptyManager } = makeRelay();
    relay.setReminderDelivery(async (_session, reminder) => (
      reminder === 'telegramInstruction' ? { channel: 'hook', fellBack: false } : { channel: 'pty', fellBack: false }
    ));

    await relay.handleIncomingTelegramMessage({
      message_id: 79,
      message_thread_id: 42,
      text: 'Ship it',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    const text = ptyManager.deliverText.mock.calls[0][1] as string;
    // The envelope itself is untouched — only the trailing instruction goes.
    expect(text).toContain('[HELM_TELEGRAM from:@testuser');
    expect(text).toContain('Ship it');
    expect(text).not.toContain('Respond via telegram_chat');
  });

  /** G9: mode pty beats capability — the visible setting means what it says. */
  it('mode pty keeps the instruction line even for a hook-capable recipient', async () => {
    const { relay, ptyManager } = makeRelay();
    relay.setReminderDelivery(async () => ({ channel: 'pty', fellBack: false }));

    await relay.handleIncomingTelegramMessage({
      message_id: 87,
      message_thread_id: 42,
      text: 'Prefer prepend',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    const text = ptyManager.deliverText.mock.calls[0][1] as string;
    expect(text).toContain('Respond via telegram_chat MCP tool.');
  });

  /** G9: off suppresses the reminder on both paths — the message still lands. */
  it('mode off drops the instruction line even though the recipient cannot inject', async () => {
    const { relay, ptyManager } = makeRelay();
    relay.setReminderDelivery(async () => ({ channel: 'off', fellBack: false }));

    await relay.handleIncomingTelegramMessage({
      message_id: 88,
      message_thread_id: 42,
      text: 'Bare envelope',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    const text = ptyManager.deliverText.mock.calls[0][1] as string;
    expect(text).toContain('[HELM_TELEGRAM from:@testuser');
    expect(text).toContain('Bare envelope');
    expect(text).not.toContain('Respond via telegram_chat');
  });

  it('handleIncomingTelegramMessage() does NOT set 👀 on inject — only verification can produce 👀', async () => {
    // 👀 must only appear when verification reports confirmed. With a fake ptyManager
    // that has no getTerminalTail, verification returns unverifiable → ❓ (never 👀).
    const { relay, bot } = makeRelay();

    await relay.handleIncomingTelegramMessage({
      message_id: 77,
      message_thread_id: 42,
      text: 'Yes, ship it',
      chat: { id: 12345 },
      from: { username: 'testuser' },
    } as any);

    const reactionEmojis = bot.setMessageReaction.mock.calls.map((c) => c[2]);
    expect(reactionEmojis).not.toContain('👀');
  });

  describe('incoming media recognition', () => {
    // Regression: video_note, animation and audio used to fall through
    // extractAttachmentInfo and vanish with no download and no user feedback.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['video_note (round bubble)', { video_note: { file_id: 'vn1', duration: 8, file_size: 100 } }, 'video_note'],
      ['animation (GIF)', { animation: { file_id: 'an1', duration: 3, mime_type: 'video/mp4', file_size: 100 } }, 'animation'],
      ['audio file', { audio: { file_id: 'au1', duration: 30, mime_type: 'audio/mpeg', file_size: 100 } }, 'audio'],
    ];

    for (const [label, payload, expectedType] of cases) {
      it(`claims and downloads ${label}`, async () => {
        const { relay, bot } = makeRelay();
        const filePath = tempAttachmentPath(`${expectedType}.bin`);
        bot.downloadFile.mockResolvedValue(filePath);

        const consumed = await relay.handleIncomingTelegramMessage({
          message_id: 90,
          message_thread_id: 42,
          chat: { id: 12345 },
          from: { username: 'testuser' },
          ...payload,
        } as any);

        expect(consumed).toBe(true);
        await vi.waitFor(() => expect(bot.downloadFile).toHaveBeenCalled());
      });
    }

    it('does not claim a message with no recognizable media', async () => {
      const { relay, bot } = makeRelay();

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 91,
        message_thread_id: 42,
        chat: { id: 12345 },
      } as any);

      expect(consumed).toBe(false);
      expect(bot.downloadFile).not.toHaveBeenCalled();
    });

    it('tells the user why an oversized video could not be fetched', async () => {
      const { relay, bot } = makeRelay();
      bot.downloadFile.mockResolvedValue(null);

      await relay.handleIncomingTelegramMessage({
        message_id: 92,
        message_thread_id: 42,
        chat: { id: 12345 },
        video: { file_id: 'v1', duration: 60, mime_type: 'video/mp4', file_size: 45 * 1024 * 1024 },
      } as any);

      await vi.waitFor(() => {
        expect(bot.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('20MB'));
      });
    });
  });

  describe('handleDeliveryVerification → reactions', () => {
    const msgContext = { chatId: 12345, messageId: 77 };
    const baseResult = { sessionId: 's1', detail: 'd', retryAttempted: false, delayMs: 0 };

    it('confirmed → 👀, no topic message', async () => {
      const { relay, bot } = makeRelay();
      await (relay as any).handleDeliveryVerification('s1', 42, { ...baseResult, status: 'confirmed' }, msgContext);
      expect(bot.setMessageReaction).toHaveBeenCalledWith(12345, 77, '👀');
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('no_signal → ❌, no topic message', async () => {
      const { relay, bot } = makeRelay();
      await (relay as any).handleDeliveryVerification('s1', 42, { ...baseResult, status: 'no_signal' }, msgContext);
      expect(bot.setMessageReaction).toHaveBeenCalledWith(12345, 77, '❌');
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('suspected_stuck → ❓', async () => {
      const { relay, bot } = makeRelay();
      await (relay as any).handleDeliveryVerification('s1', 42, { ...baseResult, status: 'suspected_stuck' }, msgContext);
      expect(bot.setMessageReaction).toHaveBeenCalledWith(12345, 77, '❓');
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('unverifiable → ❓', async () => {
      const { relay, bot } = makeRelay();
      await (relay as any).handleDeliveryVerification('s1', 42, { ...baseResult, status: 'unverifiable' }, msgContext);
      expect(bot.setMessageReaction).toHaveBeenCalledWith(12345, 77, '❓');
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('msgContext absent → no reaction, no topic message', async () => {
      const { relay, bot } = makeRelay();
      await (relay as any).handleDeliveryVerification('s1', 42, { ...baseResult, status: 'no_signal' }, undefined);
      expect(bot.setMessageReaction).not.toHaveBeenCalled();
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });
  });

  it('handleIncomingTelegramMessage() rejects stale topics with a notice instead of routing to active session', async () => {
    const { relay, bot, ptyManager, sessionManager } = makeRelay();

    const consumed = await relay.handleIncomingTelegramMessage({
      message_id: 78,
      message_thread_id: 999,
      text: 'Unmapped topic message',
      chat: { id: 12345 },
      from: { username: 'someone' },
    } as any);

    // Consumed (claimed) but NOT delivered anywhere — stale topic.
    expect(consumed).toBe(true);
    expect(ptyManager.deliverText).not.toHaveBeenCalled();
    // Must not fall back to the active session.
    expect(sessionManager.getActiveSession).not.toHaveBeenCalled();
    // Posts a notice back into the stale topic.
    expect(bot.sendToTopic).toHaveBeenCalledWith(999, expect.stringContaining('no longer exists'));
  });

  it('writes large Telegram messages to a temp file when the target CLI enables it', async () => {
    const oldThreshold = process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
    const oldAppData = process.env.APPDATA;
    const oldHome = process.env.HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), 'helm-telegram-large-'));
    process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = '10';
    process.env.APPDATA = tempHome;
    process.env.HOME = tempHome;

    try {
      const { relay, ptyManager, configLoader } = makeRelay();
      configLoader.getCliTypeEntry.mockReturnValue({ submitSuffix: '\\r', largeTextAsTempFile: true });

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 80,
        message_thread_id: 42,
        text: 'large telegram instruction',
        chat: { id: 12345 },
        from: { username: 'testuser' },
      } as any);

      expect(consumed).toBe(true);
      const noticeCall = ptyManager.deliverText.mock.calls.find((c: any[]) => String(c[1]).includes('Read the full file at:'));
      const notice = String(noticeCall?.[1] ?? '');
      const pathMatch = notice.match(/Read the full file at: (.+)$/m);
      expect(pathMatch).toBeTruthy();
      expect(readFileSync(pathMatch![1], 'utf8')).toBe('large telegram instruction');
      expect(notice).not.toContain('large telegram instruction');
    } finally {
      if (oldThreshold === undefined) delete process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
      else process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = oldThreshold;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('handleIncomingTelegramMessage() omits from tag when username is missing', async () => {
    const { relay, ptyManager } = makeRelay();

    const consumed = await relay.handleIncomingTelegramMessage({
      message_id: 79,
      message_thread_id: 42,
      text: 'No username here',
      chat: { id: 12345 },
      from: {},
    } as any);

    expect(consumed).toBe(true);
    const callArgs = ptyManager.deliverText.mock.calls[0];
    expect(callArgs[1]).toContain('[HELM_TELEGRAM chat:12345]');
    expect(callArgs[1]).not.toContain('from:unknown');
    expect(callArgs[1]).toContain('No username here');
    expect(callArgs[1]).toContain('Respond via telegram_chat MCP tool.');
  });

  it('does not send a General Chat nudge after successful topic message', async () => {
    const { relay, bot } = makeRelay();
    const innerBot = bot.getBot();

    await relay.sendToUser({ sessionId: 's1', text: 'A message that is longer than 80 characters so it gets truncated in the General Chat nudge preview text' });

    expect(innerBot.sendMessage).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('isAvailable() returns true when bot is running', () => {
    const { relay } = makeRelay();
    expect(relay.isAvailable()).toBe(true);
  });

  it('isAvailable() returns false when bot is not running', () => {
    const { relay, bot } = makeRelay();
    bot.isRunning.mockReturnValue(false);
    expect(relay.isAvailable()).toBe(false);
  });

  describe('attachment support', () => {
    it('sends PDF attachment via sendDocument', async () => {
      const { relay, bot } = makeRelay();
      const pdfPath = tempAttachmentPath('report.pdf');
      const result = await relay.sendToUser({ sessionId: 's1', text: 'See report', filePath: pdfPath });
      expect(result.sent).toBe(true);
      expect(bot.sendToTopic).not.toHaveBeenCalled();
      expect(bot.sendDocument).toHaveBeenCalledWith(
        expect.any(Buffer),
        'report.pdf',
        expect.objectContaining({ topicId: 42 }),
      );
      rmSync(path.dirname(pdfPath), { recursive: true, force: true });
    });

    it('sends image attachment via sendPhoto', async () => {
      const { relay, bot } = makeRelay();
      const imagePath = tempAttachmentPath('screenshot.png');
      const result = await relay.sendToUser({ sessionId: 's1', text: 'Screenshot', filePath: imagePath });
      expect(result.sent).toBe(true);
      expect(bot.sendPhoto).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ topicId: 42 }),
      );
      rmSync(path.dirname(imagePath), { recursive: true, force: true });
    });

    it('sends video attachment via sendVideo', async () => {
      const { relay, bot } = makeRelay();
      const videoPath = tempAttachmentPath('clip.mp4');
      const result = await relay.sendToUser({ sessionId: 's1', text: 'Video', filePath: videoPath });
      expect(result.sent).toBe(true);
      expect(bot.sendVideo).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ topicId: 42 }),
      );
      rmSync(path.dirname(videoPath), { recursive: true, force: true });
    });

    it('returns failure when file exceeds 50MB', async () => {
      const { relay } = makeRelay();
      const tempDir = mkdtempSync(path.join(tmpdir(), 'helm-large-file-'));
      const hugePath = path.join(tempDir, 'huge.bin');
      const bigBuffer = Buffer.alloc(51 * 1024 * 1024);
      closeSync(openSync(hugePath, 'w'));
      fs.writeFileSync(hugePath, bigBuffer);
      const result = await relay.sendToUser({
        sessionId: 's1',
        text: 'Big file',
        filePath: hugePath,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('too large');
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns failure when file does not exist', async () => {
      const { relay, bot } = makeRelay();
      const result = await relay.sendToUser({
        sessionId: 's1',
        text: 'OK',
        filePath: '/nonexistent/file.txt',
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('File not found');
      expect(bot.sendToTopic).not.toHaveBeenCalled();
      expect(bot.sendDocument).not.toHaveBeenCalled();
    });

    it('returns failure when Telegram API fails to send attachment', async () => {
      const { relay, bot } = makeRelay();
      bot.sendDocument.mockResolvedValue(null);
      const filePath = tempAttachmentPath('file.txt');
      const result = await relay.sendToUser({
        sessionId: 's1',
        text: 'Broken',
        filePath,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('Failed to send attachment');
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('fails closed for an attachment when no topic can be created', async () => {
      const { relay, bot } = makeRelay();
      const session = { id: 's2', name: 'NoTopic', cliType: 'claude-code' };
      const sm = {
        getSession: vi.fn((id: string) => id === 's2' ? session : null),
        getActiveSession: vi.fn(() => session),
      };
      const tm = { ensureTopic: vi.fn(async () => undefined) };
      const relay2 = new TelegramRelayService(bot as any, tm as any, sm as any, {} as any, {} as any, {} as any);
      const pdfPath = tempAttachmentPath('report.pdf');
      const result = await relay2.sendToUser({
        sessionId: 's2',
        text: 'No topic',
        filePath: pdfPath,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('Telegram topic could not be created');
      expect(bot.sendDocument).not.toHaveBeenCalled();
      rmSync(path.dirname(pdfPath), { recursive: true, force: true });
    });
  });

  describe('incoming attachments', () => {
    // Attachment handling is fire-and-forget — use fake timers so vi.runAllTimersAsync()
    // can flush the background promise chain (including the 200ms submit delay).
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('photo message downloads file and delivers envelope with file_path', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('photo_77.jpg');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 77,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [
          { file_id: 'small', file_size: 100 },
          { file_id: 'large', file_size: 5000 },
        ],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(bot.downloadFile).toHaveBeenCalledWith('large', expect.stringContaining('telegram-attachments'), 'photo_77.jpg');
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('[HELM_TELEGRAM_ATTACHMENT from:@testuser'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('type: photo'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining(`file_path: ${filePath}`));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('Respond via telegram_chat MCP tool.'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('document message downloads file and delivers envelope', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('report.pdf');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 78,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        document: {
          file_id: 'doc1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 123456,
        },
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(bot.downloadFile).toHaveBeenCalledWith('doc1', expect.stringContaining('telegram-attachments'), 'report.pdf');
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('type: document'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('file_name: report.pdf'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('mime_type: application/pdf'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('video message downloads file and delivers envelope', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('video_79.mp4');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 79,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        video: {
          file_id: 'vid1',
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          file_size: 999999,
        },
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('type: video'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('file_name: clip.mp4'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('voice message downloads file and delivers envelope', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('voice_80.ogg');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 80,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        voice: {
          file_id: 'voice1',
          mime_type: 'audio/ogg',
          file_size: 55555,
        },
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('type: voice'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('mime_type: audio/ogg'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('voice message includes transcript path and text when transcription succeeds', async () => {
      const { bot, topicManager, sessionManager, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('voice_80.ogg');
      const transcriptPath = path.join(path.dirname(filePath), 'voice_80.transcript.txt');
      bot.downloadFile.mockResolvedValue(filePath);

      const transcriber = {
        transcribe: vi.fn().mockResolvedValue({
          text: 'ship the tiny audio bridge',
          transcriptPath,
        }),
      };
      const relay = new TelegramRelayService(
        bot as any,
        topicManager as any,
        sessionManager as any,
        ptyManager as any,
        { getCliTypeEntry: vi.fn(() => ({ submitSuffix: '\\r' })), getTelegramConfig: vi.fn(() => ({ openWhisprPath: 'unused' })) } as any,
        {} as any,
        transcriber,
      );

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 80,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        voice: {
          file_id: 'voice1',
          mime_type: 'audio/ogg',
          file_size: 55555,
        },
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(transcriber.transcribe).toHaveBeenCalledWith(filePath, 'audio/ogg');
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining(`transcription_path: ${transcriptPath}`));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('transcription_text: ship the tiny audio bridge'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('attachment with caption includes caption in envelope', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('photo_81.jpg');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 81,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        caption: 'Here is a screenshot',
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('caption: Here is a screenshot'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('rejects a stale topic attachment with a notice instead of routing to active session', async () => {
      const { relay, bot, ptyManager, sessionManager } = makeRelay();
      const filePath = tempAttachmentPath('photo_82.jpg');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 82,
        message_thread_id: 999,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      // Claimed but not routed: no download, no delivery, no active-session fallback.
      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();
      expect(bot.downloadFile).not.toHaveBeenCalled();
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
      expect(sessionManager.getActiveSession).not.toHaveBeenCalled();
      expect(bot.sendToTopic).toHaveBeenCalledWith(999, expect.stringContaining('no longer exists'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('still routes an attachment with no topic id to the active session', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      const filePath = tempAttachmentPath('photo_87.jpg');
      bot.downloadFile.mockResolvedValue(filePath);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 87,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('[HELM_TELEGRAM_ATTACHMENT'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('returns true but does not deliver when download fails', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      bot.downloadFile.mockResolvedValue(null);

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 83,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true); // message claimed; download failure is handled internally
      await vi.runAllTimersAsync();
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
    });

    it('returns true but does not deliver when download path is empty', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      bot.downloadFile.mockResolvedValue('');

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 84,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
    });

    it('returns true but does not deliver when download path is whitespace', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      bot.downloadFile.mockResolvedValue('   ');

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 85,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
    });

    it('returns true but does not deliver when download path does not exist', async () => {
      const { relay, bot, ptyManager } = makeRelay();
      bot.downloadFile.mockResolvedValue(path.join(tmpdir(), 'missing-telegram-file.jpg'));

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 86,
        message_thread_id: 42,
        chat: { id: 12345 },
        from: { username: 'testuser' },
        photo: [{ file_id: 'p1', file_size: 1000 }],
      } as any);

      expect(consumed).toBe(true);
      await vi.runAllTimersAsync();
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
    });
  });

  describe('incoming reactions', () => {
    it('reaction with new emoji delivers envelope to active session', async () => {
      const { relay, ptyManager } = makeRelay();

      const consumed = await relay.handleReaction({
        chat: { id: 12345 },
        message_id: 77,
        user: { id: 111, username: 'testuser' },
        date: Date.now(),
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      });

      expect(consumed).toBe(true);
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('[HELM_TELEGRAM_REACTION from:@testuser'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('emoji: 👍'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('message_id: 77'));
    });

    it('reaction with old_reaction shows removed emoji in envelope', async () => {
      const { relay, ptyManager } = makeRelay();

      const consumed = await relay.handleReaction({
        chat: { id: 12345 },
        message_id: 88,
        user: { id: 111, username: 'testuser' },
        date: Date.now(),
        old_reaction: [{ type: 'emoji', emoji: '❤️' }],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      });

      expect(consumed).toBe(true);
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('(removed: ❤️)'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('emoji: 👍'));
    });

    // Telegram reactions are not all emoji: custom_emoji and paid entries carry
    // no `emoji` field. Mapping over them blindly leaves an empty slot in the
    // joined list, so a mixed reaction renders as "emoji: , 👍".
    it('skips non-emoji reactions rather than leaving an empty slot', async () => {
      const { relay, ptyManager } = makeRelay();

      const consumed = await relay.handleReaction({
        chat: { id: 12345 },
        message_id: 77,
        user: { id: 111, username: 'testuser' },
        date: Date.now(),
        old_reaction: [],
        new_reaction: [
          { type: 'custom_emoji', custom_emoji_id: '5789' },
          { type: 'emoji', emoji: '👍' },
        ],
      });

      expect(consumed).toBe(true);
      const [, text] = ptyManager.deliverText.mock.calls[0];
      expect(text).toContain('emoji: 👍');
      expect(text).not.toMatch(/emoji: ,/);
    });

    it('reports no emoji when every reaction is non-emoji', async () => {
      const { relay, ptyManager } = makeRelay();

      await relay.handleReaction({
        chat: { id: 12345 },
        message_id: 78,
        user: { id: 111, username: 'testuser' },
        date: Date.now(),
        old_reaction: [{ type: 'paid' }],
        new_reaction: [{ type: 'custom_emoji', custom_emoji_id: '5789' }],
      });

      const [, text] = ptyManager.deliverText.mock.calls[0];
      expect(text).toContain('emoji: none');
      expect(text).not.toContain('removed:');
    });

    it('returns false when no active session for reaction', async () => {
      const { relay, sessionManager } = makeRelay();
      sessionManager.getActiveSession.mockReturnValue(null);

      const consumed = await relay.handleReaction({
        chat: { id: 12345 },
        message_id: 99,
        user: { id: 111, username: 'testuser' },
        date: Date.now(),
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      });

      expect(consumed).toBe(false);
    });
  });

  describe('interaction channel affinity', () => {
    it('sets interactionChannel to telegram and injects first-contact instructions on first text message', async () => {
      const { relay, ptyManager, sessionManager } = makeRelay();

      await relay.handleIncomingTelegramMessage({
        message_id: 80, message_thread_id: 42,
        text: 'Hello from Telegram',
        chat: { id: 12345 }, from: { username: 'tguser' },
      } as any);

      expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { interactionChannel: 'telegram' });
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('HELM_TELEGRAM_MODE'));
    });

    it('does NOT inject instructions on subsequent Telegram messages', async () => {
      const { relay, ptyManager, sessionManager, topicManager } = makeRelay();
      // Clear call records from prior tests using the same mock factory
      sessionManager.updateSession.mockClear();
      // Simulate already in telegram mode
      const telegramSession = { id: 's1', name: 'Claude', cliType: 'claude-code', topicId: 42, interactionChannel: 'telegram' as const };
      topicManager.findSessionByTopicId.mockReturnValue(telegramSession as any);
      sessionManager.getSession.mockImplementation((id: string) => id === 's1' ? telegramSession : null);

      await relay.handleIncomingTelegramMessage({
        message_id: 81, message_thread_id: 42,
        text: 'Second message',
        chat: { id: 12345 }, from: { username: 'tguser' },
      } as any);

      // Should not call updateSession again
      expect(sessionManager.updateSession).not.toHaveBeenCalledWith('s1', { interactionChannel: 'telegram' });
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.not.stringContaining('HELM_TELEGRAM_MODE'));
    });

    it('skips the first-contact mode block when telegramModeInstructions resolves to hook — the injector owns it', async () => {
      const { relay, ptyManager, sessionManager } = makeRelay();
      relay.setReminderDelivery(async (_session, reminder) => (
        reminder === 'telegramModeInstructions' ? { channel: 'hook', fellBack: false } : { channel: 'pty', fellBack: false }
      ));

      await relay.handleIncomingTelegramMessage({
        message_id: 89, message_thread_id: 42,
        text: 'Enter mode quietly',
        chat: { id: 12345 }, from: { username: 'tguser' },
      } as any);

      // Channel affinity is state, not text — it still flips.
      expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { interactionChannel: 'telegram' });
      const text = ptyManager.deliverText.mock.calls[0][1] as string;
      expect(text).not.toContain('HELM_TELEGRAM_MODE');
      expect(text).toContain('Enter mode quietly');
    });

    it('suppresses the first-contact mode block entirely when it resolves to off', async () => {
      const { relay, ptyManager } = makeRelay();
      relay.setReminderDelivery(async () => ({ channel: 'off', fellBack: false }));

      await relay.handleIncomingTelegramMessage({
        message_id: 90, message_thread_id: 42,
        text: 'No mode block',
        chat: { id: 12345 }, from: { username: 'tguser' },
      } as any);

      const text = ptyManager.deliverText.mock.calls[0][1] as string;
      expect(text).not.toContain('HELM_TELEGRAM_MODE');
    });

    it('injects first-contact instructions for attachment messages too', async () => {
      vi.useFakeTimers();
      const { relay, ptyManager, bot } = makeRelay();
      const filePath = tempAttachmentPath('report.pdf');
      bot.downloadFile.mockResolvedValue(filePath);

      await relay.handleIncomingTelegramMessage({
        message_id: 82, message_thread_id: 42,
        chat: { id: 12345 }, from: { username: 'tguser' },
        document: { file_id: 'doc123', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 1024 },
      } as any);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('HELM_TELEGRAM_MODE'));
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    });

    it('does not inject or deliver anything for a stale (unmapped) topic', async () => {
      const { relay, bot, ptyManager } = makeRelay();

      const consumed = await relay.handleIncomingTelegramMessage({
        message_id: 83, message_thread_id: 999,
        text: 'Message for stale topic',
        chat: { id: 12345 }, from: { username: 'tguser' },
      } as any);

      // Stale topic: nothing delivered, only a notice posted back to the topic.
      expect(consumed).toBe(true);
      expect(ptyManager.deliverText).not.toHaveBeenCalled();
      expect(bot.sendToTopic).toHaveBeenCalledWith(999, expect.stringContaining('no longer exists'));
    });
  });
});
